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

// 🌸 Compact style block
function buildPrompt(detail) {
  const d = (detail || "with soft pastel petals glowing gently").trim();
  return `A single flower ${d}, Japanese anime realism, Makoto Shinkai style, soft vibrant lighting, smooth gradients, dreamy cinematic mood, vivid harmonious pastel colors, isolated on a pure white background, square high resolution.`;
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
    const clean = (message || "").toString().trim().slice(0, 300);
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

    // 🎨 Step 1: GPT rewrite → short detail only
    let flowerDetail = "with soft pastel petals glowing gently";
    try {
      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Describe a single flower in one short poetic phrase. 
Always only a flower. 
If the user mentions an object or concept, integrate it symbolically into the petals, colors, or center — never replacing the flower. 
Return only the short detail, like: "with glowing golden petals etched with clock patterns".`
          },
          { role: "user", content: clean }
        ]
      });
      flowerDetail = (gpt.choices[0].message.content || "").trim();
    } catch (err) {
      console.error("GPT rewrite failed, using fallback:", err);
    }

    // 🎨 Step 2: Build full prompt with style
    const finalPrompt = buildPrompt(flowerDetail);

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
      console.error("Image generation failed, retrying with fallback:", err);
      const img2 = await openai.images.generate({
        model: "gpt-image-1",
        prompt: buildPrompt("with soft pastel petals glowing gently"),
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
