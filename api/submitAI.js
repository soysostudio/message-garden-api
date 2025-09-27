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

// 🌸 Prompt seguro por defecto
const SAFE_FALLBACK_PROMPT =
  "A delicate pastel flower with soft glowing petals fading into light.";

async function isFlaggedByModeration(text) {
  try {
    const res = await openai.moderations.create({
      model: "omni-moderation-latest",
      input: text
    });
    return !!(res.results && res.results[0]?.flagged);
  } catch (err) {
    console.error("Moderation API error (non-blocking):", err);
    return false;
  }
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
    const clean = (message || "").toString().trim().slice(0, 200);
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

    // 🔍 Step 1: Rewrite message → flower description
    let flowerPrompt;
    try {
      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You only create poetic descriptions of flowers. 
The user’s words may inspire the flower’s colors, petal shapes, textures, or mood. 
Always output just one short line describing a single flower. 
Example: "A flower with golden layered petals glowing with warm earthy light."`
          },
          {
            role: "user",
            content: clean
          }
        ]
      });
      flowerPrompt = (gpt.choices[0].message.content || "").trim();
    } catch (err) {
      console.error("GPT rewrite failed:", err);
      flowerPrompt = SAFE_FALLBACK_PROMPT;
    }

    // 🔍 Step 2: Moderation check
    const flagged = await isFlaggedByModeration(flowerPrompt);
    if (flagged || !flowerPrompt) {
      flowerPrompt = SAFE_FALLBACK_PROMPT;
    }

    // 🖼️ Step 3: Generate image from rewritten description
    let actualPromptUsed = `An illustration of ${flowerPrompt} in the style of Japanese anime realism, inspired by Makoto Shinkai. 
The object must be painted with soft yet vibrant lighting, natural highlights, and atmospheric shading. 
Poetic, cinematic mood with smooth color blending and delicate gradients; no harsh outlines. 
Surfaces glow subtly under natural light, creating a luminous and immersive mood. 
Colors must be vivid and harmonious, with rich depth and subtle pastel tones where needed, evoking the dreamy realism of anime films. 
The object must be completely isolated on a plain pure white background, with no extra scenery. 
Square format (1:1), high resolution, polished anime realism.`;

    let pngBuffer;
    try {
      const img = await openai.images.generate({
        model: "gpt-image-1",
        prompt: actualPromptUsed,
        size: "1024x1024",
        background: "transparent"
      });
      pngBuffer = Buffer.from(img.data[0].b64_json, "base64");
    } catch (err) {
      console.error("Image generation failed:", err);
      return res.status(500).json({ error: "Image generation error" });
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

    // 🗄️ Save to DB
    await supabase.from("blooms").insert({
      message: clean,
      image_url,
      seed,
      style_version: 3,
      ip
    });

    return res.status(200).json({ ok: true, image_url, prompt: actualPromptUsed });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}


