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
  // CORS for Webflow
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

    // 1) CAP: stop at 200 before doing anything expensive
    const { count, error: countErr } = await supabase
      .from("blooms")
      .select("*", { count: "exact", head: true });
    if (countErr) throw countErr;
    if (count >= 200) {
      return res.status(403).json({
        error: "The garden is full 🌱 — please come back later."
      });
    }

    const seed = hashToSeed(clean);

    // 2) GPT: turn message into a style-locked flower prompt
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Convert any message into a short, safe prompt for a flower illustration. Always keep this style: 'Flat vector illustration of a single flower, soft pastel colors, minimalist, centered, transparent background'. Adjust color/mood to match the message feeling. No text, no logos, no faces."
        },
        { role: "user", content: clean }
      ],
      max_tokens: 80
    });
    const flowerPrompt = gpt.choices[0].message.content.trim();

    // 3) Image: transparent PNG via OpenAI Images
    const img = await openai.images.generate({
      model: "gpt-image-1",
      prompt: flowerPrompt,
      size: "1024x1024",
      background: "transparent"
    });

    const b64 = img.data[0].b64_json;
    const pngBuffer = Buffer.from(b64, "base64");

    // 4) Upload to Supabase Storage
    const filename = `bloomAI_${Date.now()}_${seed}.png`;
    const up = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(filename, pngBuffer, { contentType: "image/png" });
    if (up.error) throw up.error;

    const { data: pub } = supabase.storage
      .from(SUPABASE_BUCKET)
      .getPublicUrl(filename);
    const image_url = pub.publicUrl;

    // 5) Insert row
    const ins = await supabase.from("blooms").insert({
      message: clean,
      image_url,
      seed,
      style_version: 2
    });
    if (ins.error) throw ins.error;

    return res.status(200).json({ ok: true, image_url, prompt: flowerPrompt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
