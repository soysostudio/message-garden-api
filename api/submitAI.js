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

// 🔒 Prompt seguro por defecto (no usa contenido del usuario)
const SAFE_FALLBACK_PROMPT =
  "An illustration of a single ethereal flower with translucent pastel petals and a soft luminous core, crafted from abstract glass and silk. In Japanese anime film realism, inspired by Makoto Shinkai. Soft yet vibrant lighting, natural highlights, and atmospheric shading. Poetic, cinematic mood with smooth blending and delicate gradients; no harsh outlines. Surfaces glow subtly under natural light, vivid harmonious colors with gentle pastel depth. Completely isolated on a pure white background, no extra scenery. Square 1:1, high resolution, polished anime realism.";

async function isFlaggedByModeration(text) {
  try {
    const res = await openai.moderations.create({
      model: "omni-moderation-latest",
      input: text
    });
    return !!(res.results && res.results[0]?.flagged);
  } catch (err) {
    // Si falla moderación, no bloqueamos el flujo.
    console.error("Moderation API error (non-blocking):", err);
    return false;
  }
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

    // 🔍 Moderación del input del usuario (sin cambiar tu lógica)
    const userFlagged = await isFlaggedByModeration(clean);

    // 🎨 Generate prompt (solo si el input no está flaggeado; si está flaggeado usamos fallback)
    let flowerPrompt;
    if (!userFlagged) {
      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You only create descriptions of flowers.  
Every output must be a single flower, nothing else.  

The user’s text may inspire only the flower’s **colors, petal shapes, patterns, or mood**.  
- If the text mentions foods, reinterpret them as safe colors or textures (e.g., pizza → golden petals with dotted red speckles).  
- If the text mentions animals, reinterpret them as safe moods or patterns (e.g., cats → soft curved petals, playful arrangement).  
- If the text is abstract, turn it into symbolic petal forms, glowing effects, or colors.  

Never describe people, body parts, animals, unsafe objects, politics, violence, or sexual content.  
If the text is unsafe or irrelevant, ignore it and instead describe a gentle pastel flower.  

Keep your description vivid and poetic, like:  
"A flower with translucent petals that dissolve into light as they open."  

Finally, embed your description (OBJECT) into this style template, replacing (OBJECT):  

"An illustration of (OBJECT) in the style of Japanese anime realism, inspired by Makoto Shinkai.  
The object must be painted with soft yet vibrant lighting, natural highlights, and atmospheric shading.  
The style should feel poetic and cinematic, with smooth color blending and delicate gradients, avoiding harsh outlines.  
Surfaces should glow subtly under natural light, creating a luminous and immersive mood.  
Colors must be vivid and harmonious, with rich depth and subtle pastel tones where needed, evoking the dreamy realism of anime films.  
The object must be completely isolated on a plain pure white background, with no extra scenery, so that the anime-inspired details are the sole focus.  
Square format (1:1), high resolution, polished anime realism."

`
          },
          {
            role: "user",
            content: `Message: "${clean}". Create its flower form.`
          }
        ]
      });
      flowerPrompt = (gpt.choices[0].message.content || "").trim();
    }

    // Si el input estaba flaggeado o el prompt quedó vacío, usar fallback seguro
    if (userFlagged || !flowerPrompt) {
      flowerPrompt = SAFE_FALLBACK_PROMPT;
    }

    // 🔍 Moderación del prompt final (por si GPT metió algo raro)
    const promptFlagged = await isFlaggedByModeration(flowerPrompt);
    if (promptFlagged) {
      flowerPrompt = SAFE_FALLBACK_PROMPT;
    }

    // 🖼️ Generate image con manejo de fallback si la API bloquea
    let actualPromptUsed = flowerPrompt;
    let pngBuffer;

    try {
      const img = await openai.images.generate({
        model: "gpt-image-1",
        prompt: actualPromptUsed,
        size: "1024x1024",
        background: "transparent"
      });
      pngBuffer = Buffer.from(img.data[0].b64_json, "base64");
    } catch (err) {
      // Si el generador de imágenes lo bloquea, reintenta con el prompt seguro
      const code = err?.code || err?.error?.code;
      const status = err?.status;
      const msg = err?.message || err?.error?.message || "";

      const looksLikeModerationBlock =
        code === "moderation_blocked" ||
        (status === 400 && /safety system|moderation/i.test(msg));

      if (looksLikeModerationBlock) {
        try {
          actualPromptUsed = SAFE_FALLBACK_PROMPT;
          const img2 = await openai.images.generate({
            model: "gpt-image-1",
            prompt: actualPromptUsed,
            size: "1024x1024",
            background: "transparent"
          });
          pngBuffer = Buffer.from(img2.data[0].b64_json, "base64");
        } catch (err2) {
          console.error("Images fallback failed:", err2);
          return res
            .status(400)
            .json({ error: "Blocked by safety filter 🌸" });
        }
      } else {
        console.error("Images API error:", err);
        return res.status(500).json({ error: "Image generation error" });
      }
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

    // 🗄️ Insert in Supabase DB
    await supabase.from("blooms").insert({
      message: clean,
      image_url,
      seed,
      style_version: 2,
      ip
    });

    return res
      .status(200)
      .json({ ok: true, image_url, prompt: actualPromptUsed });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}

