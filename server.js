'use strict';
// Rapid Site Builder — one-line brief in, a live AI agent crew out.
//
// The build runs on a Google Cloud Agent Builder (ADK) crew deployed to Vertex
// AI Agent Engine; every agent turn streams to the browser over SSE. Images
// come from Gemini image generation behind a GCS cache. There is NO non-Google
// AI path in this app.
//
// Routes:
//   GET  /              landing — intake + the live agents show
//   GET  /board         operate-board dashboard
//   POST /api/build     SSE: phases, agent steps, hero image, final site
//   POST /api/publish   re-render server-side, store to GCS → public URL
//   GET  /sites/:id     serve a published site
//   GET  /api/health    liveness + config flags

const express = require('express');
const path = require('path');
const engine = require('./lib/engine');
const { render } = require('./lib/renderer');
const { heroImageUrl, normCategory, normStyle, inferCategory, CATEGORIES } = require('./lib/images');
const { saveSite, loadSite, rememberDeviceSite, listDeviceSites } = require('./lib/store');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'web'), { index: false }));

const PORT = process.env.PORT || 8080;
// Long SSE builds must bypass the Hosting→Cloud Run proxy (it caps streaming
// around 60s), so the frontend calls this service's own URL cross-origin.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://rapid-site-builder.web.app')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use('/api', (req, res, next) => {
  const origin = req.get('origin') || '';
  if (ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
// Pretty public base for published-site URLs (the Hosting domain serves
// /sites/* fine — those are quick GETs, not streams).
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

// ---- simple per-IP rate limit (builds are the expensive op) -------------------
const RATE = new Map(); // ip -> [timestamps]
const RATE_MAX = Number(process.env.BUILDS_PER_HOUR_PER_IP) || 12;
function rateOk(req) {
  const ip = (req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const arr = (RATE.get(ip) || []).filter(t => now - t < 3600_000);
  if (arr.length >= RATE_MAX) return false;
  arr.push(now);
  RATE.set(ip, arr);
  if (RATE.size > 5000) RATE.clear(); // crude memory guard
  return true;
}

// For English builds, drop Hebrew lines from streamed agent text — the deployed
// crew's copy agent drafts bilingually by instruction; the English-only surface
// shows only the English lines (the final spec/site are English regardless).
const HEBREW_RE = /[֐-׿יִ-ﭏ]/;
function englishOnly(text) {
  if (!HEBREW_RE.test(text)) return text;
  const kept = String(text).split('\n').filter(l => !HEBREW_RE.test(l)).join('\n').trim();
  return kept;
}

// Last-resort spec when the crew's final JSON turn fails twice: a clean,
// category-aware draft assembled from the intake, so a build always ends in a
// rendered site instead of an error.
const CAT_DEFAULTS = {
  food_beverage: { vibe: 'warm', layout: 'catalog', heading: 'What we serve', items: ['Signature favorites', 'Fresh every morning', 'Made to order'] },
  retail: { vibe: 'bold', layout: 'catalog', heading: 'What we carry', items: ['Curated picks', 'New arrivals', 'Customer favorites'] },
  beauty: { vibe: 'warm', layout: 'booking', heading: 'Our treatments', items: ['Signature treatments', 'Express sessions', 'Memberships'] },
  health: { vibe: 'trust', layout: 'booking', heading: 'Our care', items: ['Consultations', 'Treatments', 'Follow-up care'] },
  fitness: { vibe: 'fresh', layout: 'booking', heading: 'Our classes', items: ['Group classes', 'Personal training', 'Beginner programs'] },
  professional: { vibe: 'trust', layout: 'services', heading: 'What we do', items: ['Consulting', 'Done-for-you delivery', 'Ongoing support'] },
  tech: { vibe: 'modern', layout: 'services', heading: 'What we build', items: ['The product', 'Integrations', 'Support that answers'] },
  real_estate: { vibe: 'trust', layout: 'services', heading: 'How we help', items: ['Buying', 'Selling', 'Guidance end to end'] },
  education: { vibe: 'fresh', layout: 'services', heading: 'What we teach', items: ['Core programs', 'Small groups', 'Personal mentoring'] },
  events: { vibe: 'bold', layout: 'services', heading: 'What we host', items: ['Private events', 'Celebrations', 'Full production'] }
};
function fallbackSpec(brief) {
  const cat = CAT_DEFAULTS[brief.category] || CAT_DEFAULTS[inferCategory(brief.business + ' ' + brief.description)] || CAT_DEFAULTS.professional;
  const name = brief.business || 'Your Business';
  const desc = brief.description || 'Something good is coming.';
  return {
    business: name,
    tagline: desc.slice(0, 90),
    vibe: brief.style !== 'default' && brief.style ? brief.style : cat.vibe,
    layout: cat.layout,
    about_heading: 'About ' + name,
    about: desc.charAt(0).toUpperCase() + desc.slice(1) + '. We keep it simple: do it well, treat people right, and be worth coming back to.',
    items_heading: cat.heading,
    items: cat.items.map(n => ({ emoji: '', name: n, desc: 'Ask us — this is what we love doing.', price: '' })),
    why_heading: 'Why ' + name,
    why: [
      { emoji: '', title: 'We care about the details', text: 'Small things done right, every single time.' },
      { emoji: '', title: 'Local and personal', text: 'You talk to people who know your name.' },
      { emoji: '', title: 'Easy to reach', text: 'Questions answered fast, no runaround.' }
    ],
    cta_heading: 'Come say hello',
    cta_text: 'We would love to meet you.',
    cta_button: 'Get in touch',
    contact: { address: '', phone: '', email: '', hours: '' }
  };
}

function cleanBrief(body) {
  const s = (v, n) => String(v == null ? '' : v).slice(0, n).trim();
  // "other" passes through to the crew untouched — classifying the business is
  // the research agent's job; only the image cache needs a concrete category.
  const rawCat = String(body.category || '').toLowerCase().trim();
  const brief = {
    business: s(body.business, 120),
    category: rawCat === 'other' ? 'other' : normCategory(body.category),
    description: s(body.description, 400),
    lang: body.lang === 'he' ? 'he' : 'en',
    style: normStyle(body.style)
  };
  if (!brief.business && !brief.description) return null;
  return brief;
}

// ---- SSE build -----------------------------------------------------------------
app.post('/api/build', async (req, res) => {
  if (!rateOk(req)) return res.status(429).json({ error: 'Rate limit reached — try again in a bit.' });
  const brief = cleanBrief(req.body || {});
  if (!brief) return res.status(400).json({ error: 'Tell us at least a business name or a one-line description.' });
  if (!engine.ENABLED) return res.status(503).json({ error: 'Agent Engine is not configured on this deployment.' });

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);

  // Hero image resolves in parallel with the crew run — a cache hit lands in
  // milliseconds; a miss generates without ever blocking the build.
  const imageCategory = brief.category === 'other'
    ? inferCategory(brief.business + ' ' + brief.description)
    : brief.category;
  let heroPromise = heroImageUrl(imageCategory, brief.style).catch(() => null);
  heroPromise.then(url => { if (url) send({ type: 'image', url }); });

  try {
    send({ type: 'start', brief: { business: brief.business, category: brief.category, lang: brief.lang } });
    // Instant first draft — the deterministic spec renders in milliseconds and the
    // crew then refines it live; a cache-hit hero (≤1.2s) rides along when ready.
    try {
      const draftHero = await Promise.race([heroPromise, new Promise(r => setTimeout(() => r(null), 1200))]);
      const draftSpec = fallbackSpec(brief);
      send({ type: 'draft', spec: draftSpec, html: render(draftSpec, { heroImage: draftHero || null }) });
    } catch { /* draft is best-effort — never blocks the real build */ }
    let lastPhase = -1;
    const result = await engine.runBuild(brief, (step, phase) => {
      if (phase !== lastPhase) { lastPhase = phase; send({ type: 'phase', n: phase }); }
      const text = brief.lang === 'he' ? step.text : englishOnly(step.text);
      // skip leftovers with no real content (e.g. a bare "---" divider after filtering)
      if (text && /[a-zA-Z0-9]/.test(text)) send({ type: 'step', agent: step.agent, text });
    });
    let spec = result.spec;
    if (!spec) {
      spec = fallbackSpec(brief);
      send({ type: 'step', agent: 'opsagents_builder_orchestrator', text: 'Pulling the final draft together from the team\'s notes — one more moment.' });
    }
    const heroImage = await Promise.race([heroPromise, new Promise(r => setTimeout(() => r(null), 20000))]);
    const html = render(spec, { heroImage });
    send({ type: 'site', spec, heroImage: heroImage || null, html });
  } catch (e) {
    // Reliability floor (charter): a build never ends in a bare error. The
    // spec-parse fallback above only covers a crew run that FINISHED without a
    // usable spec — this path covers total engine failure (throw mid-run,
    // engine outage, zero events). Same deterministic category-aware draft,
    // flagged with an honest system line. Witnessed live 2026-06-11 17:31 UTC:
    // start → image → error → done left the user at a dead end (card aAp5r5af).
    console.warn('[build] engine failed, serving deterministic fallback:', String((e && e.message) || e).slice(0, 300));
    try {
      send({ type: 'step', agent: 'opsagents_builder_orchestrator', text: 'The engine hit turbulence mid-run — assembling your draft from the team\'s playbook instead.' });
      const spec = fallbackSpec(brief);
      const heroImage = await Promise.race([heroPromise, new Promise(r => setTimeout(() => r(null), 8000))]);
      const html = render(spec, { heroImage });
      send({ type: 'site', spec, heroImage: heroImage || null, html });
    } catch (e2) {
      // render of the deterministic spec failing is a code bug, not a flake —
      // only here may the stream end in an error event.
      send({ type: 'error', message: String((e2 && e2.message) || e2).slice(0, 400) });
    }
  } finally {
    clearInterval(ping);
    send({ type: 'done' });
    res.end();
  }
});

// ---- publish --------------------------------------------------------------------
app.post('/api/publish', async (req, res) => {
  try {
    const spec = req.body && req.body.spec;
    if (!spec || !spec.business) return res.status(400).json({ error: 'Missing site spec to publish.' });
    if (JSON.stringify(spec).length > 100_000) return res.status(413).json({ error: 'Spec too large.' });
    const heroImage = String(req.body.heroImage || '');
    // No-sign-in memory (card jvsQp6cS): a well-formed device id gets stamped
    // into the site's meta and a devices/<id>/<site> marker so /api/my-sites
    // can find it again. Malformed ids are simply ignored — never an error.
    const deviceId = /^[a-f0-9]{32}$/.test(String(req.body.deviceId || '')) ? String(req.body.deviceId) : '';
    const html = render(spec, { heroImage }); // always server-rendered — never client HTML
    const id = await saveSite(html, {
      business: String(spec.business).slice(0, 120),
      ...(deviceId ? { deviceId } : {})
    });
    if (deviceId) await rememberDeviceSite(deviceId, id).catch(() => { /* memory is best-effort */ });
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0];
    const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    const base = PUBLIC_BASE_URL || `${proto}://${host}`;
    res.json({ id, url: `${base}/sites/${id}` });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
});

app.get(['/sites/:id', '/sites/:id/'], async (req, res) => {
  const html = await loadSite(req.params.id);
  if (!html) return res.status(404).type('text/plain').send('Site not found');
  res.set('Cache-Control', 'public, max-age=300').type('html').send(html);
});

// This device's published sites — convenience memory, not authentication (the
// 128-bit random id is unguessable; possession of it IS the lookup key, same
// as knowing the site URLs themselves, which are public pages anyway).
app.get('/api/my-sites', async (req, res) => {
  const device = String(req.query.device || '');
  if (!/^[a-f0-9]{32}$/.test(device)) return res.status(400).json({ error: 'Bad device id.' });
  try {
    const sites = await listDeviceSites(device);
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0];
    const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    const base = PUBLIC_BASE_URL || `${proto}://${host}`;
    res.set('Cache-Control', 'no-store').json({
      sites: sites.map(s => ({ ...s, url: `${base}/sites/${s.id}` }))
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
});

// ---- ask the orchestrator ---------------------------------------------------------
// The client never HAS to come here — but when they wish, one real turn goes to
// the live orchestrator on the Agent Engine and Theo answers in plain language.
app.post('/api/ask', async (req, res) => {
  if (!rateOk(req)) return res.status(429).json({ error: 'Rate limit reached — try again in a bit.' });
  if (!engine.ENABLED) return res.status(503).json({ error: 'Agent Engine is not configured.' });
  try {
    const msg = String((req.body && req.body.message) || '').slice(0, 300).trim();
    if (!msg) return res.status(400).json({ error: 'Empty message.' });
    const business = String((req.body && req.body.business) || '').slice(0, 120);
    const url = String((req.body && req.body.url) || '').slice(0, 200);
    // Mirror the question's language; the message text wins over the client's lang
    // field (a mislabeled client must not strip a legit Hebrew answer or vice versa).
    const he = HEBREW_RE.test(msg) || (req.body && req.body.lang) === 'he';
    const prompt =
      'You are Theo, the orchestrator of the AI web team that built and now operates the client\'s website' +
      (business ? ` ("${business}"${url ? ', live at ' + url : ''})` : '') + '. ' +
      'The client just sent you this request. Reply DIRECTLY to the client in 2-4 warm, plain-language sentences: ' +
      'say which of your agents (Leo layout, Noa copy, Sam SEO, Vera monitoring, Gil security, Uri updates) you would route it to and what will happen next. ' +
      'Do not call any tools, do not transfer to another agent, do not publish anything — just answer the client.' +
      (he ? ' Reply in Hebrew.' : ' Reply in English only.') +
      '\n\nClient request: ' + msg;
    const reply = await engine.oneTurn(prompt);
    let out = he ? reply : englishOnly(reply);
    if (!he && !out) {
      // The bilingual-by-instruction crew can answer fully in Hebrew even when asked
      // for English — then englishOnly() strips every line and the old `|| reply`
      // fallback shipped the raw Hebrew verbatim. One translate retry keeps a real
      // answer; the fixed line below is the last resort, never the Hebrew.
      try {
        out = englishOnly(await engine.oneTurn(
          'Translate this to English for the client. Keep the warm tone. Reply with the translation only:\n\n' + reply
        ));
      } catch { /* fall through to the fixed line */ }
      if (!out) out = 'Theo here — the team drafted that answer in Hebrew and I couldn’t translate it just now. Ask me again in a moment.';
    }
    res.json({ reply: out.slice(0, 1200) });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
});

// ---- cache warm (operator-only; WARM_KEY is set at deploy time) -------------------
app.post('/api/warm-images', async (req, res) => {
  const key = process.env.WARM_KEY || '';
  if (!key || req.get('x-warm-key') !== key) return res.status(404).end();
  const out = {};
  for (const c of Object.keys(CATEGORIES)) {
    try { out[c] = await heroImageUrl(c, 'default'); } catch (e) { out[c] = 'ERR ' + e.message; }
  }
  res.json(out);
});

// ---- pages + health ---------------------------------------------------------------
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'web', 'index.html')));
app.get(['/board', '/board/'], (_req, res) => res.sendFile(path.join(__dirname, 'web', 'board', 'index.html')));
app.get(['/campfire', '/campfire/'], (_req, res) => res.sendFile(path.join(__dirname, 'web', 'campfire', 'index.html')));
app.get('/api/health', (_req, res) => res.json({
  ok: true,
  agentEngine: engine.ENABLED,
  imagesBucket: !!process.env.SITE_IMAGES_BUCKET,
  sitesBucket: !!process.env.PUBLISHED_SITES_BUCKET,
  categories: Object.keys(CATEGORIES)
}));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`rapid-site-builder on :${PORT}`));
}

module.exports = { app, cleanBrief };
