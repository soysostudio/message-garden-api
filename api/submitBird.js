// Vercel Serverless Function: POST /api/submitBird
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import crypto from "crypto";

const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET = "bird"
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

    // 🐦 Limit check
    const { count } = await supabase
      .from("bird")
      .select("*", { count: "exact", head: true });
    if (count >= 200) {
      return res.status(403).json({ error: "The aviary is full 🐦" });
    }

    const { count: userCount } = await supabase
      .from("bird")
      .select("*", { count: "exact", head: true })
      .eq("ip", ip);
    if (userCount >= 500) {
      return res.status(403).json({ error: "🐦 Max 3 birds per user" });
    }

    const seed = hashToSeed(clean);

    // 🎨 Generate prompt for bird
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a Creative AI specializing in Metaphorical Description, tasked with transforming abstract concepts, feelings, or ideas into vivid, poetic descriptions suitable for AI Image Generation prompts. Your sole focus is to describe the concept as a Bird.

          Core Rules:
          - Always describe the concept as a single, tangible Bird, centered and prominent.
          - Exclusion of Environment: DO NOT describe sky, trees, nests, or background. Only the Bird itself.
          - Style: Concise but richly descriptive, highly visual, and poetic — focusing on unusual materials, textures, colors, and symbolic feeling.
          - Symbolic Interpretation: The user’s concept must influence feathers, wings, or body patterns as symbolic colors or textures. NEVER turn into people, other animals, or objects.
          - Output Format: One compact English sentence describing only the bird, immediately followed by the locked style anchor:

          anime realism with dreamy cinematic atmosphere, soft yet vibrant lighting, natural highlights, atmospheric shading, smooth color blending, delicate gradients, no harsh outlines, glowing surfaces under natural light, vivid harmonious colors, rich depth, subtle pastel tones, isolated on a pure white background, square 1:1 format, high resolution, polished anime realism.`
        },
        
        {
          role: "user",
          content: clean
        }
      ]
    });

    const birdPrompt = gpt.choices[0].message.content.trim();

    // 🖼️ Generate image
    const img = await openai.images.generate({
      model: "gpt-image-1",
      prompt: birdPrompt,
      size: "1024x1024",
      background: "transparent",
    });
    const pngBuffer = Buffer.from(img.data[0].b64_json, "base64");
    const revisedPrompt = img.data[0].revised_prompt || birdPrompt;

    // ☁️ Upload to Supabase
    const filename = `birdAI_${Date.now()}_${seed}.png`;
    await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(filename, pngBuffer, { contentType: "image/png" });

    const { data: pub } = supabase.storage
      .from(SUPABASE_BUCKET)
      .getPublicUrl(filename);
    const image_url = pub.publicUrl;

    // 🗄️ Insert in Supabase DB
    await supabase.from("bird").insert({
      message: clean,
      image_url,
      seed,
      style_version: 2,
      ip,
      style_version: 4,   // new version since style tuning
      prompt_used: revisedPrompt // log what was actually sent by API
    });

    return res.status(200).json({ ok: true, image_url, prompt: birdPrompt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}
