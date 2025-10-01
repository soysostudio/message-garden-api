// /api/submitFish.js
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import crypto from "crypto";

const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET = "garden"   // use your bucket; "garden" is just a suggestion
} = process.env;

const TABLE = "fish";          // ← table to insert into
const FOLDER = "fish";         // ← folder inside the bucket

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
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const { message } = req.body || {};
    const clean = (message || "").toString().trim().slice(0, 500);
    if (!clean) return res.status(400).json({ error: "Message required" });

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "";

    const seed = hashToSeed(clean);

    // 1) Build a safe, locked fish description (one-sentence)
    const sys = `
You rewrite any user message into a single-sentence, safe description of ONE stylized fish.
Hard rules: describe only the fish body (no people, no animals, no text, no objects, no background).
Keep the same hero pose: fish oriented left-to-right, slight 3/4 angle, centered.
Personalization can affect only color palette, subtle patterns, and surface texture.
At the end of the sentence, append exactly this locked style tag:
" — anime realism, soft yet vibrant lighting, natural highlights, atmospheric shading, smooth gradients, no harsh outlines, luminous feel, harmonious vivid colors, isolated on pure white, square 1:1, high resolution, polished anime realism."
If the input is unsafe or off-topic, output:
"A gentle, iridescent koi with pearly fins and a luminous core" — anime realism, soft yet vibrant lighting, natural highlights, atmospheric shading, smooth gradients, no harsh outlines, luminous feel, harmonious vivid colors, isolated on pure white, square 1:1, high resolution, polished anime realism.
    `.trim();

    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: sys }, { role: "user", content: clean }]
    });
    const fishPrompt = gpt.choices[0].message.content.trim();

    // 2) Generate the image
    const img = await openai.images.generate({
      model: "gpt-image-1",
      prompt: fishPrompt,
      size: "1024x1024",
      background: "transparent"
    });

    const pngBuffer = Buffer.from(img.data[0].b64_json, "base64");
    const revisedPrompt = img.data[0].revised_prompt || fishPrompt;

    // 3) Upload to Supabase Storage (foldered)
    const filename = `${FOLDER}/fish_${Date.now()}_${seed}.png`;
    await supabase.storage.from(SUPABASE_BUCKET)
      .upload(filename, pngBuffer, { contentType: "image/png", upsert: false });

    const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(filename);
    const image_url = pub.publicUrl;

    // 4) Insert row to the fish table
    await supabase.from(TABLE).insert({
      message: clean,
      image_url,
      seed,
      style_version: 1,
      ip,
      prompt_used: revisedPrompt
    });

    return res.status(200).json({ ok: true, image_url, prompt: fishPrompt });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}
