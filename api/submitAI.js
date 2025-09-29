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
const SAFE_FALLBACK_DESC =
  "a delicate pastel flower with soft glowing petals fading into light";

// 🌸 Sanitizer
function sanitizeDescription(desc = "") {
  return desc
    .replace(/^["'“”]+|["'“”]+$/g, "") // strip quotes
    .replace(/\s+/g, " ")              // collapse whitespace/newlines
    .trim()
    .slice(0, 240);                    // keep compact
}

// 🌸 Style block (short + consistent)
function buildStyledPrompt(description) {
  const d = sanitizeDescription(description || SAFE_FALLBACK_DESC);
  return `${d}. In Japanese anime realism, Makoto Shinkai style. 
Soft vibrant lighting, cinematic shading, smooth gradients. 
Dreamy anime film realism with vivid harmonious colors and pastel tones. 
Single isolated flower on pure white background. Square high resolution.`;
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

    // 🎨 Step 1: GPT rewrite (now tied to user input)
    let flowerLine = SAFE_FALLBACK_DESC;
    try {
      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You transform the user’s words into a poetic description of a single flower.  
Always describe only one flower, isolated, with no background or objects.  
The user’s text should inspire the flower’s colors, petal shapes, textures, or mood.  
Do not describe the object literally (e.g. don't put pizza or cats inside the flower).  
Instead, reinterpret them into safe floral qualities.  

Examples:  
User: "pizza" → "a flower with warm golden petals dotted with red speckles, glowing playfully"  
User: "cats" → "a flower with soft curved petals and a gentle playful mood"`
          },
          {
            role: "user",
            content: clean
          }
        ]
      });
      flowerLine = (gpt.choices[0].message.content || "").trim();
    } catch (err) {
      console.error("GPT rewrite failed, using fallback:", err);
    }

    // 🎨 Step 2: Build styled prompt
    const finalPrompt = buildStyledPrompt(flowerLine);

    // 🖼️ Step 3: Generate image
    let pngBuffer;
    try {
      const img = await openai.images.generate({
        model: "gpt-image-1",
        prompt: finalPrompt,
        size: "1024x1024",
        background: "transparent"
      });
      pngBuffer = Buffer.from(img.data[0].b64_json, "base64");
    } catch (err) {
      console.error("Image generation failed:", err);
      // fallback in case of error
      const img2 = await openai.images.generate({
        model: "gpt-image-1",
        prompt: buildStyledPrompt(SAFE_FALLBACK_DESC),
        size: "1024x1024",
        background: "transparent"
      });
      pngBuffer = Buffer.from(img2.data[0].b64_json, "base64");
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
      style_version: 7,
      ip
    });

    return res.status(200).json({ ok: true, image_url, prompt: finalPrompt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}
