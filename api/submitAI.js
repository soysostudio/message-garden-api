// Vercel Serverless Function: POST /api/submitAI
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import crypto from "crypto";

const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET = "flowers"
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function hashToSeed(str) {
  const h = crypto.createHash("sha256").update(str).digest();
  return h.readUInt32BE(0);
}

// 🔒 Fallback cortico con el MISMO estilo (por si images da 400 safety)
const SAFE_FALLBACK_PROMPT =
  "An illustration of a single delicate flower in Japanese anime realism, inspired by Makoto Shinkai. Soft vibrant lighting, natural highlights, cinematic shading. Smooth gradients, glowing under natural light. Vivid harmonious colors. Completely isolated on a pure white background. Square format, high resolution.";

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
    if (userCount >= 500) {
      return res.status(403).json({ error: "🌸 Max 3 blooms per user" });
    }

    const seed = hashToSeed(clean);

    // 🎨 Generate prompt (MISMO prompt del sistema que ya te funciona)
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            'Describe a single flower, poetic and vivid.  Always only one flower, completely isolated, with no background, no scenery, and no other objects or people.  An illustration of (OBJECT) in the style of Japanese anime realism, inspired by Makoto Shinkai.  The flower must be painted with soft yet vibrant lighting, natural highlights, and atmospheric shading.  The style should feel poetic and cinematic, with smooth color blending and delicate gradients, avoiding harsh outlines. Petals and surfaces should glow gently under natural light, creating a luminous and immersive mood.  Colors must be vivid and harmonious, with rich depth and subtle pastel tones where needed, evoking the dreamy realism of anime films. The flower must be completely isolated on a plain pure white background, with no extra scenery or details, so that the anime-inspired details are the sole focus. polished anime realism.'
        },
        {
          role: "user",
          content: `Message: "${clean}". Create its flower form.`
        }
      ]
    });

    // 🧹 Micro-saneado y límite (NO cambia el contenido, solo evita edge cases)
    const flowerPrompt = (gpt.choices[0].message.content || "")
      .replace(/[“”]/g, '"')     // comillas curvas → rectas
      .replace(/\s+/g, " ")      // colapsar espacios/nuevas líneas
      .trim()
      .slice(0, 700);            // cap para no saturar al images API

    // 🖼️ Generate image con retry ultra-seguro SOLO si hay 400 safety
    let pngBuffer;
    try {
      const img = await openai.images.generate({
        model: "gpt-image-1",
        prompt: flowerPrompt,
        size: "1024x1024",
        background: "transparent"
      });
      pngBuffer = Buffer.from(img.data[0].b64_json, "base64");
    } catch (err) {
      const status = err?.status;
      const code = err?.code || err?.error?.code;
      const msg = err?.message || err?.error?.message || "";

      const looksSafety =
        code === "moderation_blocked" ||
        (status === 400 && /safety|moderation/i.test(msg));

      if (!looksSafety) {
        // No es un bloqueo de safety → propaga error original
        console.error("Images API error:", err);
        return res.status(500).json({ error: "Image generation error" });
      }

      // Reintento con prompt corto y seguro (mismo estilo)
      try {
        const img2 = await openai.images.generate({
          model: "gpt-image-1",
          prompt: SAFE_FALLBACK_PROMPT,
          size: "1024x1024",
          background: "transparent"
        });
        pngBuffer = Buffer.from(img2.data[0].b64_json, "base64");
      } catch (err2) {
        console.error("Images fallback failed:", err2);
        return res
          .status(400)
          .json({ error: "Blocked by safety filter 🌸" });
      }
    }

    // ☁️ Upload to Supabase
    const filename = `bloomAI_${Date.now()}_${seed}.png`;
    await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(filename, pngBuffer, { contentType: "image/png" });

    const { data: pub } = supabase.storage
      .from(SUPABASE_BUCKET)
      .getPublicUrl(filename);
    const image_url = pub.publicUrl;

    // 🗄️ Insert in Supabase DB (sin tocar tu esquema)
    await supabase.from("blooms").insert({
      message: clean,
      image_url,
      seed,
      style_version: 2,
      ip
    });

    return res.status(200).json({ ok: true, image_url, prompt: flowerPrompt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}
