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
  "An illustration of a single simple flower with soft pastel petals and a golden center. Painted in Japanese anime film realism, inspired by Makoto Shinkai. Gentle lighting, natural highlights, and atmospheric shading. Poetic mood with smooth gradients; no harsh outlines. The flower glows subtly under natural light, vivid harmonious colors with delicate pastel tones. Completely isolated on a pure white background, no extra scenery. Square 1:1, high resolution, polished anime realism.";

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

    // 🔍 Moderar input del usuario
    const userFlagged = await isFlaggedByModeration(clean);

    // 🎨 Generar prompt
    let flowerPrompt;
    if (!userFlagged) {
      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an AI prompt designer that only creates descriptions of flowers.  
Always describe a single flower.  
The flower must always be safe, luminous, poetic, and cinematic.  

The user’s text may inspire the flower’s **colors, textures, shapes, or mood**, even if the text refers to objects or foods.  
Transform those ideas into floral qualities. For example, “pizza” might inspire red and golden petals, “chocolate” might inspire deep brown tones.  

Never describe people, body parts, animals, unsafe objects, politics, violence, or nudity.  
If the input is unsafe or irrelevant, ignore it and instead describe a gentle pastel flower.  

Keep the description concise, but always embed it into this style template, replacing (OBJECT):  

"An illustration of (OBJECT) in the style of Japanese anime realism, inspired by Makoto Shinkai.  
The object must be painted with soft yet vibrant lighting, natural highlights, and atmospheric shading.  
The style should feel poetic and cinematic, with smooth color blending and delicate gradients, avoiding harsh outlines.  
Surfaces should glow subtly under natural light, creating a luminous and immersive mood.  
Colors must be vivid and harmonious, with rich depth and subtle pastel tones where needed, evoking the dreamy realism of anime films.  
The object must be completely isolated on a plain pure white background, with no extra scenery, so that the anime-inspired details are the sole focus.  
Square format (1:1), high resolution, polished anime realism."

`
          },
          {
            role: "user",
            content: `Message: "${clean}". Create its flower form.`
          }
        ]
      });
      flowerPrompt = (gpt.choices[0].message.content || "").trim();
    }

    if (userFlagged || !flowerPrompt) {
      flowerPrompt = SAFE_FALLBACK_PROMPT;
    }

    // 🔍 Moderar prompt final
    const promptFlagged = await isFlaggedByModeration(flowerPrompt);
    if (promptFlagged) {
      flowerPrompt = SAFE_FALLBACK_PROMPT;
    }

    // 🖼️ Generar imagen con fallback
    let actualPromptUsed = flowerPrompt;
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
      console.error("Image blocked, retrying with fallback...", err);
      actualPromptUsed = SAFE_FALLBACK_PROMPT;
      const img2 = await openai.images.generate({
        model: "gpt-image-1",
        prompt: actualPromptUsed,
        size: "1024x1024",
        background: "transparent"
      });
      pngBuffer = Buffer.from(img2.data[0].b64_json, "base64");
    }

    // ☁️ Subir a Supabase
    const filename = `bloomAI_${Date.now()}_${seed}.png`;
    await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(filename, pngBuffer, { contentType: "image/png" });

    const { data: pub } = supabase.storage
      .from(SUPABASE_BUCKET)
      .getPublicUrl(filename);
    const image_url = pub.publicUrl;

    // 🗄️ Guardar en DB
    await supabase.from("blooms").insert({
      message: clean,
      image_url,
      seed,
      style_version: 2,
      ip
    });

    return res.status(200).json({ ok: true, image_url, prompt: actualPromptUsed });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}

