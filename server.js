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
const { heroImageUrl, normCategory, normStyle, CATEGORIES } = require('./lib/images');
const { saveSite, loadSite } = require('./lib/store');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'web'), { index: false }));

const PORT = process.env.PORT || 8080;

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

function cleanBrief(body) {
  const s = (v, n) => String(v == null ? '' : v).slice(0, n).trim();
  const brief = {
    business: s(body.business, 120),
    category: normCategory(body.category),
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
  let heroPromise = heroImageUrl(brief.category, brief.style).catch(() => null);
  heroPromise.then(url => { if (url) send({ type: 'image', url }); });

  try {
    send({ type: 'start', brief: { business: brief.business, category: brief.category, lang: brief.lang } });
    let lastPhase = -1;
    const { spec } = await engine.runBuild(brief, (step, phase) => {
      if (phase !== lastPhase) { lastPhase = phase; send({ type: 'phase', n: phase }); }
      send({ type: 'step', agent: step.agent, text: step.text });
    });
    const heroImage = await Promise.race([heroPromise, new Promise(r => setTimeout(() => r(null), 20000))]);
    const html = render(spec, { heroImage });
    send({ type: 'site', spec, heroImage: heroImage || null, html });
  } catch (e) {
    send({ type: 'error', message: String((e && e.message) || e).slice(0, 400) });
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
    const html = render(spec, { heroImage }); // always server-rendered — never client HTML
    const id = await saveSite(html, { business: String(spec.business).slice(0, 120) });
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0];
    const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    res.json({ id, url: `${proto}://${host}/sites/${id}` });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
});

app.get(['/sites/:id', '/sites/:id/'], async (req, res) => {
  const html = await loadSite(req.params.id);
  if (!html) return res.status(404).type('text/plain').send('Site not found');
  res.set('Cache-Control', 'public, max-age=300').type('html').send(html);
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
    const he = (req.body && req.body.lang) === 'he';
    const prompt =
      'You are Theo, the orchestrator of the AI web team that built and now operates the client\'s website' +
      (business ? ` ("${business}"${url ? ', live at ' + url : ''})` : '') + '. ' +
      'The client just sent you this request. Reply DIRECTLY to the client in 2-4 warm, plain-language sentences: ' +
      'say which of your agents (Leo layout, Noa copy, Sam SEO, Vera monitoring, Gil security, Uri updates) you would route it to and what will happen next. ' +
      'Do not call any tools, do not transfer to another agent, do not publish anything — just answer the client.' +
      (he ? ' Reply in Hebrew.' : ' Reply in English only.') +
      '\n\nClient request: ' + msg;
    const reply = await engine.oneTurn(prompt);
    res.json({ reply: reply.slice(0, 1200) });
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
