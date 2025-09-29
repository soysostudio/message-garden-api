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

// ----- NEW: small helpers for safe prompt building -----
const SAFE_FALLBACK_DESC =
  "a delicate pastel flower with soft glowing petals fading into light";

function sanitizeDescription(desc = "") {
  return desc
    .replace(/^["'“”]+|["'“”]+$/g, "") // strip quotes
    .replace(/\s+/g, " ")              // collapse whitespace/newlines
    .trim()
    .slice(0, 240);                    // keep it compact
}

function buildStyledPrompt(description) {
  const d = sanitizeDescription(description || SAFE_FALLBACK_DESC);
  // NOTE: do NOT start with "An illustration of ..."
  const prompt = `${d}. In Japanese anime realism, Makoto Shinkai style. ` +
    `Soft vibrant lighting, natural highlights, cinematic shading, smooth gradients. ` +
    `Dreamy anime film realism with vivid harmonious colors and pastel tones. ` +
    `Single isolated flower on a pure white background. Square 1:1, high resolution.`;
  // keep final prompt tidy and not too long
  return prompt.replace(/\s+/g, " ").trim().slice(0, 600);
}

// Short, safe fallback in the same style (used only on safety 400)
const SAFE_FALLBACK_PROMPT = buildStyledPrompt(SAFE_FALLBACK_DESC);

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

    // Limits (unchanged)
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

    // ----- GPT step (unchanged system intent) -----
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            'Describe a single flower, poetic and vivid.  Always only a flower, no objects or people. An illustration of (OBJECT) in Japanese anime realism, inspired by Makoto Shinkai.  Soft vibrant lighting, natural highlights, cinematic shading.  Smooth gradients, glowing under natural light.  Vivid harmonious colors, dreamy anime film realism.  Isolated on a pure white background. Square format, high resolution.'
        },
        {
          role: "user",
          content: `Message: "${clean}". Create its flower form.`
        }
      ]
    });

    // ----- NEW: build final prompt safely -----
    const flowerLine = gpt.choices[0].message.content || "";
    const finalPrompt = buildStyledPrompt(flowerLine);

    // Images generate with safety-aware retry (unchanged behavior)
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
      const status = err?.status;
      const code = err?.code || err?.error?.code;
      const msg = err?.message || err?.error?.message || "";
      const looksSafety =
        code === "moderation_blocked" ||
        (status === 400 && /safety|moderation/i.test(msg));

      if (!looksSafety) {
        console.error("Images API error:", err);
        return res.status(500).json({ error: "Image generation error" });
      }

      // Retry with compact, styled fallback
      try {
        const img2 = await openai.images.generate({
          model: "gpt-image-1",
          prompt: SAFE_FALLBACK_PROMPT,
          size: "1024x1024",
          background: "transparent"
        });
        pngBuffer = Buffer.from(img2.data[0].b64_json, "base64");
      } catch (err2) {
        console.error("Images fallback failed:", err2);
        return res.status(400).json({ error: "Blocked by safety filter 🌸" });
      }
    }

    // Upload (unchanged)
    const filename = `bloomAI_${Date.now()}_${seed}.png`;
    await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(filename, pngBuffer, { contentType: "image/png" });

    const { data: pub } = supabase.storage
      .from(SUPABASE_BUCKET)
      .getPublicUrl(filename);
    const image_url = pub.publicUrl;

    // Insert (unchanged)
    await supabase.from("blooms").insert({
      message: clean,
      image_url,
      seed,
      style_version: 6,
      ip
    });

    return res.status(200).json({ ok: true, image_url, prompt: finalPrompt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}
