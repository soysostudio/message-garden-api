// Vercel Serverless Function: POST /api/submitAI
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import crypto from "crypto";

const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET = "flowers",
  WEBFLOW_API_KEY,
  WEBFLOW_COLLECTION_ID
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function hashToSeed(str) {
  const h = crypto.createHash("sha256").update(str).digest();
  return h.readUInt32BE(0);
}

function slugify(input) {
  return (input || "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || `bloom-${Date.now()}`;
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
      return res.status(403).json({ error: "🌸 Max 3 blooms per user" });
    }

    const seed = hashToSeed(clean);

    // 🎨 Generate prompt
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a creative AI for image generation. Task: When I provide you with a concept, internally transform it into a poetic description of a flower. The description must be vivid, imaginative, and describe only the flower itself (no people, no animals, no objects other than a flower, no background). Without showing me the intermediate description, automatically place it inside the following image-generation prompt, replacing (FLOWER): An illustration of (FLOWER) in the style of Japanese anime realism, inspired by Makoto Shinkai. The flower must be painted with soft yet vibrant lighting, natural highlights, and atmospheric shading. The style should feel poetic and cinematic, with smooth color blending and delicate gradients, avoiding harsh outlines. Surfaces should glow subtly under natural light, creating a luminous and immersive mood. Colors must be vivid and harmonious, with rich depth and subtle pastel tones where needed, evoking the dreamy realism of anime films. The flower must be completely isolated on a plain pure white background, with no extra scenery, so that the anime-inspired details are the sole focus. Square format (1:1), high resolution, polished anime realism. Return only the final combined prompt ready to send to an image model."
        },
        
        {
          role: "user",
          content: `Message: "${clean}". Create its flower form.`
        }
      ]
    });
    const flowerPrompt = gpt.choices[0].message.content.trim();

    // 🖼️ Generate image
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

    // 🌐 Push to Webflow CMS
    const wfResp = await fetch(
      `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items?live=true`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WEBFLOW_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          isArchived: false,
          isDraft: false,
          fieldData: {
            name: clean.slice(0, 80),
            slug: slugify(clean),
            message: clean,
            "flower-image": { url: image_url, alt: clean }
          }
        })
      }
    );

    if (!wfResp.ok) {
      const txt = await wfResp.text();
      console.error("Webflow CMS error:", txt);
    }

    return res.status(200).json({ ok: true, image_url, prompt: flowerPrompt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}
