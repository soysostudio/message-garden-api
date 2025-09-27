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

    // 🎨 Generate safe prompt
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You turn any concept into a brief, poetic description of a single flower. 
The flower must always be safe and clearly recognizable. 
⚠️ Never describe people, body parts, violence, nudity, politics, or food. 
Only flowers or flowers inspired by abstract materials (glass, fire, fabric, etc). 
Then place that description into this template, replacing (OBJECT): 
An illustration of (OBJECT) in Japanese anime film realism, inspired by Makoto Shinkai. 
Soft yet vibrant lighting, natural highlights, and atmospheric shading. 
Poetic, cinematic mood with smooth color blending and delicate gradients; no harsh outlines. 
Surfaces glow subtly under natural light, with vivid, harmonious colors and gentle pastel depth. 
Completely isolated on a pure white background, no extra scenery. 
Square 1:1, high resolution, polished anime realism.`
        },
        {
          role: "user",
          content: `Message: "${clean}". Create its flower form.`
        }
      ]
    });
    const flowerPrompt = gpt.choices[0].message.content.trim();

    // 🔍 Moderation check
    let moderation;
    try {
      moderation = await openai.moderations.create({
        model: "omni-moderation-latest",
        input: flowerPrompt
      });
    } catch (err) {
      console.error("Moderation API failed:", err);
      return res.status(500).json({ error: "Moderation service error" });
    }

    if (moderation.results && moderation.results[0].flagged) {
      return res.status(400).json({
        error: "Message blocked by safety filter 🌸"
      });
    }

    // 🖼️ Generate image
    const img = await openai.images.generate({
      model: "gpt-image-1",
      prompt: flowerPrompt,
      size: "1024x1024",
      background: "transparent"
    });
    const pngBuffer = Buffer.from(img.

