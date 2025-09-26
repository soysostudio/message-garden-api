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

    // 🌸 Per-IP limit: Max 3
    const { count: userCount } = await supabase
      .from("blooms")
      .select("*", { count: "exact", head: true })
      .eq("ip", ip);
    if (userCount >= 100) {
      return res.status(403).json({ error: "🌸 Max 3 blooms per user" });
    }

    const seed = hashToSeed(clean);

    // 🎨 Generate prompt
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
            You are an AI prompt designer.
            Convert any user message into a description of a single imaginative flower.
    
            Rules:
            - Always generate a flower — never people, animals, objects, or text.
            - Style must always be:
    
            "An illustration of a flower in the style of Japanese anime realism, inspired by Makoto Shinkai.
            Painted with soft yet vibrant lighting, natural highlights, and atmospheric shading.
            Poetic and cinematic feel, smooth gradients, no harsh outlines.
            Subtle glow under natural light. Vivid, harmonious colors with pastel tones.
            Square format (1:1), high resolution, polished anime realism."
    
            - The user message should only affect the flower’s **color, petal shape, and mood**.
            - Keep the description short and safe, under 100 words.
          `
        },
        {
          role: "user",
          content: `Message: "${clean}". Make this into a flower description using the locked anime realism style.`
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

    // 🌐 Push to Webflow CMS (publish live immediately)
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

    const wfData = await wfResp.json();
    if (!wfResp.ok) {
      console.error("Webflow CMS error:", wfData);
      return res.status(500).json({ error: "Webflow CMS insert failed", details: wfData });
    }

    return res.status(200).json({
      ok: true,
      image_url,
      prompt: flowerPrompt,
      webflowItemId: wfData.id // return new item ID so frontend can confirm it
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}
