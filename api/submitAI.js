// Vercel Serverless Function: POST /api/submitAI
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import crypto from "crypto";

const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET = "flowers",
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
    if (userCount >= 50) {
      return res.status(403).json({ error: "🌸 Max 50 blooms per user" });
    }

    const seed = hashToSeed(clean);

    // 🎨 Step 1: Rewrite user input into a safe flower description
    let safeFlowerDesc;
    try {
      const rewrite = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Turn the following message into a brief, poetic, and completely safe description of a single real or imaginary flower. Rules: Only output a flower description.  Do NOT reference people, food, animals, or inappropriate concepts. If the message can't be safely converted, respond with: "A delicate, imaginary lily glowing softly in gentle light."
            `
          },
          {
            role: "user",
            content: clean
          }
        ],
        max_tokens: 80
      });

      safeFlowerDesc = rewrite.choices[0].message.content.trim();
    } catch (err) {
      console.error("❌ Rewrite step failed, using fallback:", err.message);
      safeFlowerDesc = "A delicate, imaginary lily glowing softly in gentle light.";
    }

    // 🎨 Step 2: Moderation check
    try {
      const moderation = await openai.moderations.create({
        model: "omni-moderation-latest",
        input: safeFlowerDesc
      });

      if (moderation.results[0].flagged) {
        console.warn("⚠️ Moderation flagged, using fallback safe flower");
        safeFlowerDesc = "A delicate, imaginary lily glowing softly in gentle light.";
      }
    } catch (err) {
      console.error("⚠️ Moderation check failed, continuing with description:", err.message);
    }

    // 🎨 Step 3: Build final flower prompt
    const flowerPrompt = `An illustration of ${safeFlowerDesc}, in the style of Japanese anime realism, inspired by Makoto Shinkai. Soft yet vibrant lighting, natural highlights, and atmospheric shading. Poetic, cinematic mood with smooth color blending and delicate gradients; no harsh outlines. Surfaces glow subtly under natural light, with vivid, harmonious colors and gentle pastel depth. Completely isolated on a pure white background, no extra scenery. Square 1:1, high resolution, polished anime realism. `;

    // 🖼️ Step 4: Generate image
    const img = await openai.images.generate({
      model: "gpt-image-1",
      prompt: flowerPrompt,
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
      style_version: 2,
      ip
    });

    return res.status(200).json({ ok: true, image_url, prompt: flowerPrompt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}
