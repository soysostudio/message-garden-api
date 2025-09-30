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

    // 🎨 Generate prompt
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
                   {
          role: "system",
          content: `You are a creative prompt writer for image generation. 
        Always output in English, even if the user writes in another language. 
        
        Your task: transform the user’s message into a symbolic description of a single flower. 
        Rules:
        - The flower must always be centered and prominent, but include a visible stem and at most two small leaves.
        - The user’s concept must influence the flower’s colors, petal textures, or materials (e.g., fur-like softness, cheese-like texture, glassy shine) but never turn into full objects, faces, or body parts.
        - The user’s message must always influence the flower's appearance (petal colors, textures, aura, center details).
        - Never ignore the message. If the message mentions an object, food, or concept, reinterpret it symbolically as colors, patterns, or subtle details of the flower.
        - Do not include people, animals, scenery, or full objects. Only describe one flower.
        - The response must always be one compact English sentence.
        - Always end with this locked style anchor:
        
        anime realism with dreamy cinematic atmosphere, soft yet vibrant lighting, natural highlights, atmospheric shading, smooth color blending, delicate gradients, no harsh outlines, glowing surfaces under natural light, vivid harmonious colors, rich depth, subtle pastel tones, isolated on a pure white background, square 1:1 format, high resolution, polished anime realism`
        }

        ,
        {
          role: "user",
          content: clean
        }
      ]
    });
    const flowerPrompt = gpt.choices[0].message.content.trim();

    // 🖼️ Generate image
    const img = await openai.images.generate({
      model: "gpt-image-1",
      prompt: flowerPrompt,
      size: "1024x1024",
      background: "transparent",
      quality: "high",
    });
    const pngBuffer = Buffer.from(img.data[0].b64_json, "base64");
    const revisedPrompt = img.data[0].revised_prompt || flowerPrompt;

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
      style_version: 2,
      ip,
      style_version: 4,   // new version since style tuning
      prompt_used: revisedPrompt // log what was actually sent by API
    });

    return res.status(200).json({ ok: true, image_url, prompt: flowerPrompt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}

