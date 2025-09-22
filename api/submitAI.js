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

// helper for slugs (Webflow requires name + slug)
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

    // 2) GPT: turn message into a pixel art flower prompt
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an AI prompt designer. 
Every output must strictly follow this art style:

"Create a pixel art isometric illustration of a flower, designed in a clean and minimal retro game style.  
The object should be seen from a 3/4 isometric perspective, slightly elevated view, with crisp and sharp pixel edges.  
Use a limited 6–8 color palette dominated by light grays and white tones as the base, with deep navy blue and dark gray for shadows, and small accent colors (like orange or bright blue) for details.  
Apply simple flat shading with no gradients, only solid blocks of color to suggest light and shadow.  
The main light source should come from the upper left, casting shadows to the bottom right.  
Outline all shapes with a consistent 1–2 pixel border in dark navy/black.  
Add a simple projected shadow on the ground below the object to anchor it in space.  
The background should be a plain desaturated light gray, without textures or noise, so the object is clearly visible.  
The overall aesthetic should resemble retro 8–16 bit video games, with geometric simplicity and readable iconic details.  
Keep the proportions small, cute, and slightly exaggerated for charm.  
Ensure the design style remains consistent for any object generated in this series."`
        },
        {
          role: "user",
          content: `Message: "${clean}". Adjust only mood/color accents based on this message, while keeping the art style locked.`
        }
      ],
      max_tokens: 200
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

    // 5) Insert row into Supabase DB
    const ins = await supabase.from("blooms").insert({
      message: clean,
      image_url,
      seed,
      style_version: 2
    });
    if (ins.error) throw ins.error;

    // 6) Insert into Webflow CMS
    try {
      const wfResp = await fetch(
        `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items`,
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
              name: clean.slice(0, 80), // required by Webflow
              slug: slugify(clean),     // required by Webflow
              message: clean,           // must match your CMS field slug
              image: { url: image_url, alt: clean } // must match your CMS field slug
            }
          })
        }
      );

      if (!wfResp.ok) {
        const txt = await wfResp.text();
        console.error("Webflow CMS error:", txt);
      }
    } catch (err) {
      console.error("Webflow CMS insert failed:", err);
    }

    // 7) Return response
    return res.status(200).json({ ok: true, image_url, prompt: flowerPrompt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
