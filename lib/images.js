'use strict';
// Hero images: Gemini image generation ("Nano Banana") on Vertex AI with a GCS
// cache in front, keyed by business CATEGORY + STYLE — never by business name —
// so generated art is recycled across builds and a demo run is normally a pure
// cache hit. On any failure the caller renders a gradient fallback; an image
// problem can never block a build.
//
// Env:
//   SITE_IMAGES_BUCKET  public-read GCS bucket for the cache       (required)
//   IMAGE_PROJECT       GCP project for Vertex image generation    (required to generate)
//   IMAGE_REGION        Vertex region                              (default us-central1)
//   IMAGE_MODEL         image model id                             (default gemini-2.5-flash-image)

const { Storage } = require('@google-cloud/storage');
const { getAccessToken } = require('./token');

const BUCKET = process.env.SITE_IMAGES_BUCKET || '';
const IMAGE_PROJECT = process.env.IMAGE_PROJECT || '';
const IMAGE_REGION = process.env.IMAGE_REGION || 'us-central1';
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gemini-2.5-flash-image';
const GEN_TIMEOUT_MS = Number(process.env.IMAGE_GEN_TIMEOUT_MS) || 45000;

const storage = new Storage();

// The 10 intake categories. Prompts are category-generic on purpose: a cached
// hero must look right for ANY business in the category (that's what makes the
// cache recyclable).
const CATEGORIES = {
  food_beverage:  'a warm inviting specialty cafe interior, espresso bar, pastries on a wooden counter, soft morning light',
  retail:         'a bright modern boutique retail store interior, clean shelving with curated products, warm spotlights',
  beauty:         'a serene high-end beauty and wellness studio, soft neutral tones, plants, natural light',
  health:         'a calm modern medical clinic reception, friendly and clean, soft blue tones, natural light',
  fitness:        'a modern light-filled fitness studio, minimal equipment, energetic but clean composition',
  professional:   'a confident modern office workspace, glass and warm wood, a team collaborating, depth of field',
  tech:           'an abstract modern technology illustration, soft gradients, geometric shapes, optimistic, no text',
  real_estate:    'a beautiful bright modern home exterior at golden hour, clean architecture, inviting',
  education:      'a bright welcoming learning space, books and warm light, optimistic and clean',
  events:         'an elegant softly lit event venue set for a celebration, warm bokeh lights, festive but refined'
};
const STYLE_HINTS = {
  default: 'photorealistic, professional photography, high detail',
  warm:    'photorealistic, golden warm tones, cozy professional photography',
  fresh:   'photorealistic, airy natural greens and light, crisp professional photography',
  modern:  'sleek, moody, high-contrast professional photography with deep tones',
  trust:   'clean corporate professional photography, cool balanced tones',
  bold:    'vivid, energetic, saturated professional photography'
};

function normCategory(c) {
  const k = String(c || '').toLowerCase().trim();
  return CATEGORIES[k] ? k : 'professional';
}
function normStyle(s) {
  const k = String(s || '').toLowerCase().trim();
  return STYLE_HINTS[k] ? k : 'default';
}
function cacheKey(category, style) {
  return `${normCategory(category)}/${normStyle(style)}/hero-1.png`;
}
function publicUrl(key) {
  return `https://storage.googleapis.com/${BUCKET}/${key}`;
}

async function generatePng(category, style) {
  if (!IMAGE_PROJECT) throw new Error('IMAGE_PROJECT not configured');
  const prompt =
    `Wide website hero banner photograph: ${CATEGORIES[normCategory(category)]}. ` +
    `${STYLE_HINTS[normStyle(style)]}. Wide 16:9 composition with calm negative space, ` +
    'no people looking at camera, absolutely no text, no logos, no watermarks.';
  const token = await getAccessToken();
  const url = `https://${IMAGE_REGION}-aiplatform.googleapis.com/v1/projects/${IMAGE_PROJECT}/locations/${IMAGE_REGION}/publishers/google/models/${IMAGE_MODEL}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'] }
    }),
    signal: AbortSignal.timeout(GEN_TIMEOUT_MS)
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`image-gen ${r.status}: ${t.slice(0, 200)}`); }
  const d = await r.json();
  const part = d.candidates?.[0]?.content?.parts?.find(p => p.inlineData || p.inline_data);
  const inline = part && (part.inlineData || part.inline_data);
  if (!inline || !inline.data) throw new Error('no image in response');
  return Buffer.from(inline.data, 'base64');
}

// Cache-first hero URL. Returns a public https URL, or null when no image can
// be served (caller falls back to gradient art).
async function heroImageUrl(category, style, { allowGenerate = true } = {}) {
  if (!BUCKET) return null;
  const key = cacheKey(category, style);
  const file = storage.bucket(BUCKET).file(key);
  try {
    const [exists] = await file.exists();
    if (exists) return publicUrl(key);
  } catch (e) {
    console.warn('[images] cache check failed:', e.message);
    return null;
  }
  // miss on the styled key → try the category default before generating
  if (normStyle(style) !== 'default') {
    try {
      const dKey = cacheKey(category, 'default');
      const [dExists] = await storage.bucket(BUCKET).file(dKey).exists();
      if (dExists && !allowGenerate) return publicUrl(dKey);
      if (dExists) {
        // serve the default now-ish; still generate the styled one
        try {
          const png = await generatePng(category, style);
          await file.save(png, { contentType: 'image/png', resumable: false });
          return publicUrl(key);
        } catch { return publicUrl(dKey); }
      }
    } catch { /* fall through to generate */ }
  }
  if (!allowGenerate) return null;
  try {
    const png = await generatePng(category, style);
    await file.save(png, { contentType: 'image/png', resumable: false });
    return publicUrl(key);
  } catch (e) {
    console.warn('[images] generate failed:', e.message);
    return null;
  }
}

module.exports = { heroImageUrl, cacheKey, generatePng, CATEGORIES, STYLE_HINTS, normCategory, normStyle };
