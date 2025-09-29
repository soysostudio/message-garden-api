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

// 🌸 Fallback description
const SAFE_FALLBACK_FLOWER =
  "a delicate pastel flower with soft glowing petals fading into light";

// 🌸 Shorter style wrapper
function buildStyledPrompt(flowerDescription) {
  return `An illustration of ${flowerDescription} in Japanese anime realism, inspired by Makoto Shinkai.  Soft vibrant lighting, natural highlights, cinematic shading.  Smooth gradients, glowing surfaces, dreamy anime realism.  The flower must be completely isolated on a pure white background, no scenery.  Square format (1:1), high resolution.`;
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

    // 🎨 Generate description with GPT
    let flowerDescription = SAFE_FALLBACK_FLOWER;
    try {
      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You rewrite user words into a poetic description of a single flower.  Always only one flower, completely isolated, with no background, no people, and no objects.  The description should be vivid but short, focusing on colors, petal shapes, or mood.  Example: "a flower with golden petals glowing in soft light"`
          },
          {
            role: "user",
            content: clean
          }
        ]
      });
      flowerDescription = (gpt.choices[0].message.content || "").trim();
    } catch (err) {
      console.error("GPT rewrite failed, using fallback:", err);
    }

    // 🖼️ Build styled prompt (normal or fallback)
    let finalPrompt = buildStyledPrompt(
      flowerDescription || SAFE_FALLBACK_FLOWER
    );

    // 🖼️ Generate image
    const img = await openai.images.generate({
      model: "gpt-image-1",
      prompt: finalPrompt,
      size: "1024x1024",
      background: "transparent"
    });
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
      message: clean,
      image_url,
      seed,
      style_version: 4,
      ip
    });

    return res.status(200).json({ ok: true, image_url, prompt: finalPrompt });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ error: "Server error", details: e.message });
  }
}

