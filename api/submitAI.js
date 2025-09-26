// Vercel Serverless Function: POST /api/submitAI
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import crypto from "crypto";

const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET = "flowers",
  WEBFLOW_API_KEY,
  WEBFLOW_COLLECTION_ID
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function hashToSeed(str) {
  const h = crypto.createHash("sha256").update(str).digest();
  return h.readUInt32BE(0);
}

function slugify(input) {
  return (input || "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || `bloom-${Date.now()}`;
}

// 🔒 Sanitizar mensaje para evitar bloqueos
function sanitizeInput(input) {
  return input
    .replace(
      /(sangre|sangriento|matar|muerte|arma|violencia|sexy|cuerpo|kill|blood|gun|sex|nude|death)/gi,
      "místico"
    )
    .slice(0, 100);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const { message } = req.body || {};
    const clean = (message || "").toString().trim().slice(0, 500);
    if (!clean) return res.status(400).json({ error: "Message required" });

    const safeMessage = sanitizeInput(clean);

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.socket.remoteAddress;

    // 🌸 Limit check
    const { count } = await supabase
      .from("blooms")
      .select("*", { count: "exact", head: true });
    if (count >= 200) {
      return res.status(403).json({ error: "Garden is full 🌱" });
    }

    const { count: userCount } = await supabase
      .from("blooms")
      .select("*", { count: "exact", head: true })
      .eq("ip", ip);
    if (userCount >= 50) {
      return res.status(403).json({ error: "🌸 Max 3 blooms per user" });
    }

    const seed = hashToSeed(safeMessage);

    // 🎨 Prompt fijo + concepto del usuario
    const dallePrompt = `
An imaginative flower that symbolizes: "${safeMessage}".
Style: Japanese anime realism inspired by Makoto Shinkai.
Soft yet vibrant lighting, natural highlights, atmospheric shading.
Poetic and cinematic, smooth color blending, delicate gradients, luminous glow.
Vivid harmonious colors, pastel tones. Isolated on pure white background.
Square format (1:1), high resolution, polished anime realism.
`;

    // 🖼️ Generar imagen con fallback
    let img;
    try {
      img = await openai.images.generate({
        model: "gpt-image-1",
        prompt: dallePrompt,
        size: "1024x1024",
        background: "transparent"
      });
    } catch (err) {
      if (err.code === "moderation_blocked") {
        console.error("🚫 Prompt bloqueado, usando fallback seguro…");
        img = await openai.images.generate({
          model: "gpt-image-1",
          prompt: `
          A luminous safe flower in Makoto Shinkai anime realism style.
          Soft pastel colors, cinematic lighting, isolated on pure white background.
          `,
          size: "1024x1024",
          background: "transparent"
        });
      } else {
        throw err;
      }
    }

    const pngBuffer = Buffer.from(img.data[0].b64_json, "base64");

    // ☁️ Upload to Supabase
    const filename = `bloomAI_${Date.now()}_${seed}.png`;
    await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(filename, pngBuffer, { contentType: "image/png" });
    const { data: pub } = supabase.storage
      .from(SUPABASE_BUCKET)
      .getPublicUrl(filename);
    const image_url = pub.publicUrl;

    // 🗄️ Insert in Supabase DB
    await supabase.from("blooms").insert({
      message: safeMessage,
      image_url,
      seed,
      style_version: 3,
      ip
    });

    // 🌐 Push to Webflow CMS
    const wfResp = await fetch(
      `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items?live=true`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WEBFLOW_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          isArchived: false,
          isDraft: false,
          fieldData: {
            name: safeMessage.slice(0, 80),
            slug: slugify(safeMessage),
            message: safeMessage,
            "flower-image": { url: image_url, alt: safeMessage }
          }
        })
      }
    );

    if (!wfResp.ok) {
      const txt = await wfResp.text();
      console.error("Webflow CMS error:", txt);
    }

    return res.status(200).json({ ok: true, image_url, prompt: dallePrompt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}

