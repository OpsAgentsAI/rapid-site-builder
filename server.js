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
const crypto = require('crypto');
const engine = require('./lib/engine');
const { render } = require('./lib/renderer');
const { heroImageUrl, normCategory, normStyle, inferCategory, CATEGORIES } = require('./lib/images');
const { saveSite, loadSite, rememberDeviceSite, listDeviceSites, saveLlms, loadLlms, listSitesByOwner, listAllSites, loadSiteMeta, saveSiteDomain } = require('./lib/store');
const domains = require('./lib/domains');
const { llmsTxt } = require('./lib/llmeo');
const auth = require('./lib/auth');
const { adminKeyOk, sessionIsAdmin } = require('./lib/admin');
const uploads = require('./lib/uploads');
const p2b = require('./lib/p2b-media');
const analytics = require('./lib/analytics');
const importSite = require('./lib/importSite');
const posthog = require('./lib/posthog');
const { PUBLIC_MEDIA_BASE_URL: MEDIA_BASE } = require('./lib/publicMedia');

const app = express();
// Exactly one trusted hop (Cloud Run's front end, which appends the real
// client IP as the LAST X-Forwarded-For entry) — req.ip then resolves to that
// entry instead of the client-controlled leftmost one. Without this, rotating
// XFF per request mints unlimited rate-limit identities (PR #3 security
// review, finding 1).
app.set('trust proxy', 1);

// ---- PostHog ingest reverse-proxy (card u4xmePAo) --------------------------------
// The browser sends events to a same-origin opaque path (/rp) so ad-blockers that
// block the PostHog domain don't drop our analytics. This forwards them upstream:
// /rp/static/* → the assets host, everything else → the ingest host. Mounted
// BEFORE express.json() so the raw request body (posthog-js sends its own JSON /
// form encodings) is streamed through untouched. No-op-friendly: if POSTHOG_HOST
// is a bad value the fetch simply fails and posthog-js drops the event.
const PH_INGEST_HOST = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/$/, '');
const PH_ASSETS_HOST = PH_INGEST_HOST.replace('.i.posthog.com', '-assets.i.posthog.com');
app.use('/rp', async (req, res) => {
  const upstreamBase = req.path.startsWith('/static/') ? PH_ASSETS_HOST : PH_INGEST_HOST;
  const target = upstreamBase + req.originalUrl.replace(/^\/rp/, '');
  try {
    const headers = {};
    // Forward content-type and the real client IP; strip hop-by-hop + host so the
    // upstream sees its own host and doesn't choke on our proxy chain.
    if (req.get('content-type')) headers['content-type'] = req.get('content-type');
    if (req.ip) headers['x-forwarded-for'] = String(req.ip);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? 'half' : undefined,
      signal: AbortSignal.timeout(15000)
    });
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('content-type', ct);
    const cc = upstream.headers.get('cache-control');
    if (cc) res.set('cache-control', cc);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    // Analytics ingest failing must never surface to the user as an app error.
    res.status(502).end();
  }
});

// ---- retirement mode (card KjHpbn3J, steps 1–2 — REVERSIBLE) ---------------------
// The hackathon demo surface is retired: RETIRE_UNGATED=1 (set only on the ungated
// rapid-builder-proxy deploy, never on the real app) flips this surface to
//   • 410 Gone on the anonymous engine endpoints (/api/build, /api/publish,
//     /api/ask) — stops anonymous Vertex/engine burn immediately, and
//   • 301 on the pages (/ , /board , /campfire) → the canonical product surface.
// Everything else keeps serving: published demo sites /sites/** (step 3 — public
// links must not break), /api/health + /healthz (monitoring), /rp analytics,
// static assets, /admin. Revert = remove RETIRE_UNGATED from deploy.yml and
// redeploy (or unset the env var on the service) — no data or routes are deleted.
const RETIRE_UNGATED = process.env.RETIRE_UNGATED === '1';
const CANONICAL_APP_URL = (process.env.CANONICAL_APP_URL || 'https://builder.opsagents.agency').replace(/\/$/, '');
if (RETIRE_UNGATED) {
  const GONE_API = new Set(['/api/build', '/api/publish', '/api/ask', '/api/import-site']);
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next(); // CORS preflight → the /api handler
    const p = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
    if (GONE_API.has(p)) {
      return res.status(410).json({
        error: 'This hackathon demo surface is retired. The product now lives at ' + CANONICAL_APP_URL + '.',
        canonical: CANONICAL_APP_URL
      });
    }
    if (p === '/' || p === '/index.html') return res.redirect(301, CANONICAL_APP_URL + '/');
    if (p === '/board' || p.startsWith('/board/') || p === '/campfire' || p.startsWith('/campfire/')) {
      return res.redirect(301, CANONICAL_APP_URL + p);
    }
    return next();
  });
}

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
    // exact-origin echo only, never * — required for the cookie-bearing auth
    // calls if a page ever talks to this service's own URL instead of the
    // Hosting rewrite (the normal, first-party path).
    res.set('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
// Pretty public base for published-site URLs (the Hosting domain serves
// /sites/* fine — those are quick GETs, not streams).
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

// ---- simple per-IP / per-uid rate limits -----------------------------------------
const RATE_MAX = Number(process.env.BUILDS_PER_HOUR_PER_IP) || 12;
const UPLOAD_RATE_MAX = Number(process.env.UPLOADS_PER_HOUR_PER_IP) || 30;
const PUBLISH_RATE_MAX = Number(process.env.PUBLISHES_PER_DAY_PER_UID) || 10;
function limiter(max, windowMs = 3600_000) {
  const hits = new Map(); // key -> [timestamps]
  // req.ip honors trust-proxy(1): the GFE-appended XFF entry, not the
  // spoofable leftmost hop. Never parse X-Forwarded-For by hand here.
  // A plain string keys the bucket directly (per-uid budgets, card ns341yIF).
  const key = (r) => typeof r === 'string' ? r : String((r && r.ip) || '').trim() || 'unknown';
  const live = (k, now) => (hits.get(k) || []).filter(t => now - t < windowMs);
  const take = (r) => {
    const k = key(r);
    const now = Date.now();
    const arr = live(k, now);
    if (arr.length >= max) return false;
    arr.push(now);
    hits.set(k, arr);
    if (hits.size > 5000) hits.clear(); // crude memory guard
    return true;
  };
  // Non-consuming check: lets one budget gate another route without burning a slot.
  take.peek = (r) => live(key(r), Date.now()).length < max;
  return take;
}
/**
 * A single hourly budget shared by ALL anonymous callers — card WWGnAZUR.
 *
 * WHY THE PER-IP LIMITER IS NOT ENOUGH ANY MORE
 * `limiter()` above is per-IP, and until now it was the only thing between an
 * unauthenticated request and a real Vertex-billed build. That was sized for a
 * hackathon surface nobody had been handed a link to. It no longer is: every
 * client demo deck now CLOSES on https://builder.opsagents.agency/ and invites
 * the recipient to "type a brief and watch it build" — so the link goes to
 * client-side decision makers, their phones, their colleagues, and every
 * crawler that follows a link in a deck. A per-IP budget bounds one visitor and
 * says nothing about a thousand of them: N unique IPs cost N × RATE_MAX builds.
 *
 * WHAT THIS IS, EXACTLY
 * A ceiling on anonymous spend per instance-hour. It is deliberately generous —
 * a live meeting demo runs one to three builds — and it is env-tunable, so the
 * answer to "it fired during a demo" is a number, not a redeploy of new logic.
 *
 * WHAT IT IS NOT: fleet-wide. Like `limiter`, the counter lives in this
 * process's memory, so the real ceiling is ANON_BUILDS_PER_HOUR × live
 * instances, and it resets when an instance recycles. Stated plainly rather
 * than implied away: it converts "unbounded, given enough IPs" into "bounded
 * per instance", which is the difference that matters here. A fleet-wide budget
 * needs shared state and is its own card.
 *
 * SIGNED-IN CALLERS ARE EXEMPT. The operator running the meeting demo is signed
 * in; deck traffic is not. Capping the anonymous pool therefore cannot cost
 * Michal a demo — which is the property that makes shipping this safe without
 * waiting on the anonymous-first-touch product decision the card also raises.
 */
function hourlyBudget(max) {
  let hits = [];
  const live = (now) => hits.filter((t) => now - t < 3600_000);
  const take = () => {
    const now = Date.now();
    hits = live(now);
    if (hits.length >= max) return false;
    hits.push(now);
    return true;
  };
  take.peek = () => live(Date.now()).length < max;
  take.max = max;
  return take;
}
const ANON_BUILDS_PER_HOUR = Number(process.env.ANON_BUILDS_PER_HOUR) || 60;
const anonBuildBudget = hourlyBudget(ANON_BUILDS_PER_HOUR);

/** Is this caller signed in? False whenever auth is off — then nobody is. */
function isSignedIn(req) {
  if (!auth.AUTH_ENABLED) return false;
  const s = auth.sessionFromReq(req);
  return !!(s && s.uid);
}

const rateOk = limiter(RATE_MAX);         // builds are the expensive op
const uploadRateOk = limiter(UPLOAD_RATE_MAX); // signed upload URLs
// Publishing writes durable objects to the public sites bucket — cap it per
// rolling day. Keyed per-uid on the auth-ON surface (the signed-in account is
// the stable identity there); falls back to per-IP when auth is off (local
// dev, judge clone), so the cap holds on every deployment shape (ns341yIF).
const publishRateOk = limiter(PUBLISH_RATE_MAX, 86_400_000);
const IMPORT_RATE_MAX = Number(process.env.IMPORTS_PER_HOUR_PER_IP) || 20;
const importRateOk = limiter(IMPORT_RATE_MAX); // outbound homepage fetches (bring-my-own-website)

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
// Hebrew twin of CAT_DEFAULTS — the deterministic draft/fallback must speak the
// brief's language. Business-to-visitor voice is masculine plural (MSApps house
// style); vibe/layout stay identical to the English table so the visual draft
// is the same site in either language.
const CAT_DEFAULTS_HE = {
  food_beverage: { heading: 'מה מגישים אצלנו', items: ['המנות האהובות', 'טרי כל בוקר', 'בהכנה אישית'] },
  retail: { heading: 'מה תמצאו אצלנו', items: ['נבחרו בקפידה', 'חדש על המדף', 'האהובים על הלקוחות'] },
  beauty: { heading: 'הטיפולים שלנו', items: ['טיפולי דגל', 'טיפולי אקספרס', 'מנויים'] },
  health: { heading: 'הטיפול שלנו', items: ['ייעוץ ואבחון', 'טיפולים', 'מעקב והמשך טיפול'] },
  fitness: { heading: 'השיעורים שלנו', items: ['שיעורים קבוצתיים', 'אימון אישי', 'תוכניות למתחילים'] },
  professional: { heading: 'מה אנחנו עושים', items: ['ייעוץ', 'ביצוע מקצה לקצה', 'ליווי שוטף'] },
  tech: { heading: 'מה אנחנו בונים', items: ['המוצר', 'אינטגרציות', 'תמיכה שעונה'] },
  real_estate: { heading: 'איך אנחנו עוזרים', items: ['קנייה', 'מכירה', 'ליווי מקצה לקצה'] },
  education: { heading: 'מה אנחנו מלמדים', items: ['תוכניות ליבה', 'קבוצות קטנות', 'חונכות אישית'] },
  events: { heading: 'מה אנחנו מארחים', items: ['אירועים פרטיים', 'חגיגות', 'הפקה מלאה'] }
};
function fallbackSpec(brief) {
  const catKey = CAT_DEFAULTS[brief.category] ? brief.category
    : (CAT_DEFAULTS[inferCategory(brief.business + ' ' + brief.description)] ? inferCategory(brief.business + ' ' + brief.description) : 'professional');
  const cat = CAT_DEFAULTS[catKey];
  const he = brief.lang === 'he';
  const vibe = brief.style !== 'default' && brief.style ? brief.style : cat.vibe;
  if (he) {
    // Hebrew brief → Hebrew draft, stamped lang/dir so the renderer goes RTL
    // with Hebrew chrome. Before this branch existed, a Hebrew build's instant
    // draft (and any engine-failure fallback) shipped a full English LTR site.
    const heCat = CAT_DEFAULTS_HE[catKey] || CAT_DEFAULTS_HE.professional;
    const name = brief.business || 'העסק שלך';
    const desc = brief.description || 'משהו טוב בדרך.';
    return {
      business: name,
      tagline: desc.slice(0, 90),
      vibe,
      layout: cat.layout,
      about_heading: 'על ' + name,
      about: desc + '. אנחנו שומרים על זה פשוט: לעשות את זה טוב, להתייחס לאנשים יפה, ולהיות שווים עוד ביקור.',
      items_heading: heCat.heading,
      items: heCat.items.map(n => ({ emoji: '', name: n, desc: 'שאלו אותנו — זה בדיוק מה שאנחנו אוהבים לעשות.', price: '' })),
      why_heading: 'למה ' + name,
      why: [
        { emoji: '', title: 'אכפת לנו מהפרטים', text: 'דברים קטנים שנעשים נכון, בכל פעם מחדש.' },
        { emoji: '', title: 'מקומיים ואישיים', text: 'אתם מדברים עם אנשים שיודעים איך קוראים לכם.' },
        { emoji: '', title: 'קל להשיג אותנו', text: 'עונים מהר, בלי סחבת ובלי לרדוף.' }
      ],
      cta_heading: 'בואו להגיד שלום',
      cta_text: 'נשמח להכיר אתכם.',
      cta_button: 'דברו איתנו',
      contact: { address: '', phone: '', email: '', hours: '' },
      lang: 'he',
      dir: 'rtl'
    };
  }
  const name = brief.business || 'Your Business';
  const desc = brief.description || 'Something good is coming.';
  return {
    business: name,
    tagline: desc.slice(0, 90),
    vibe,
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
    contact: { address: '', phone: '', email: '', hours: '' },
    lang: 'en'
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
  // upload names the intake collected — strictly server-shaped, capped, optional
  const rawMedia = Array.isArray(body.media) ? body.media : [];
  brief.media = rawMedia
    .filter(n => typeof n === 'string' && uploads.NAME_RE.test(n))
    .slice(0, uploads.MAX_FILES_PER_BUILD);
  if (!brief.business && !brief.description) return null;
  return brief;
}

// ---- bring my own website (card OWIBIIsu) ----------------------------------------
// The visitor pastes the address of the site they already have; we fetch it
// server-side (SSRF-screened in lib/importSite.js) and answer with a pre-filled
// brief. The human reviews the form and clicks Build — nothing here reaches the
// crew or the renderer directly, and no site is built or published by this call.
app.post('/api/import-site', async (req, res) => {
  if (!importRateOk(req)) return res.status(429).json({ error: 'Rate limit reached — try again in a bit.' });
  const rawUrl = String((req.body || {}).url || '').slice(0, 2048);
  if (!rawUrl.trim()) return res.status(400).json({ error: 'Paste your website address first.' });
  const result = await importSite.importFromUrl(rawUrl);
  if (!result.ok) return res.status(result.status || 422).json({ error: result.error });
  const { business, description, lang, textSample } = result.brief;
  const category = inferCategory([business, description, textSample].join(' '));
  posthog.capture('import_' + Date.now().toString(36), 'site_import_suggested', {
    source_host: result.sourceHost, lang, category
  });
  res.json({ ok: true, sourceHost: result.sourceHost, brief: { business, description, lang, category } });
});

// ---- SSE build -----------------------------------------------------------------
app.post('/api/build', async (req, res) => {
  if (!rateOk(req)) return res.status(429).json({ error: 'Rate limit reached — try again in a bit.' });
  // Card WWGnAZUR — the anonymous pool's own ceiling, checked AFTER the per-IP
  // budget so one noisy visitor spends their own slots first. Signed-in callers
  // (the operator demoing in a meeting) never reach this gate.
  if (!isSignedIn(req) && !anonBuildBudget()) {
    // Loud, not silent: an exhausted budget is either a demo that outgrew the
    // number or someone pointing a crawler at the engine, and both are things
    // to see rather than infer from a bill.
    console.warn('anon build budget exhausted', { max: ANON_BUILDS_PER_HOUR });
    posthog.capture('anon_budget_' + Date.now().toString(36), 'anon_build_budget_exhausted', {
      max_per_hour: ANON_BUILDS_PER_HOUR
    });
    return res.status(429).json({
      error: 'The free demo has reached its hourly limit. Sign in to keep building, or try again shortly.',
      code: 'anon_engine_budget_exhausted'
    });
  }
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

  // PostHog server-side (card u4xmePAo): an anonymous per-build id + a trace id
  // that groups every $ai_generation of this run. No PII; no extra Agent Engine
  // calls — the trace id is a locally-minted run id. NO-OP when POSTHOG_KEY unset.
  const phId = 'build_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const aiTraceId = phId;
  posthog.capture(phId, 'site_build_requested', {
    category: brief.category, lang: brief.lang, has_media: brief.media.length > 0
  });

  // Hero image resolves in parallel with the crew run — a cache hit lands in
  // milliseconds; a miss generates without ever blocking the build.
  const imageCategory = brief.category === 'other'
    ? inferCategory(brief.business + ' ' + brief.description)
    : brief.category;
  let heroPromise = heroImageUrl(imageCategory, brief.style).catch(() => null);

  try {
    send({ type: 'start', brief: { business: brief.business, category: brief.category, lang: brief.lang } });
// Instant first draft — the deterministic spec renders in milliseconds and the
    // crew then refines it live; a cache-hit hero (≤1.2s) rides along when ready.
    try {
      const draftHero = await Promise.race([heroPromise, new Promise(r => setTimeout(() => r(null), 1200))]);
      const draftSpec = fallbackSpec(brief);
      send({ type: 'draft', spec: draftSpec, html: render(draftSpec, { heroImage: draftHero || null }) });
    } catch { /* draft is best-effort — never blocks the real build */ }

    // The visitor's own photos/videos: verify + publish copies BEFORE the crew
    // runs, so the first image can take over as the hero and the crew designs
    // around real client media. Generated imagery stays the fallback. (Runs
    // after the instant draft so the ≤3s draft promise holds even while
    // uploads are being verified.)
    let userMedia = [];
    if (brief.media.length) {
      userMedia = await uploads.prepareUserMedia(brief.media).catch(() => []);
      if (userMedia.length) {
        send({ type: 'media', items: userMedia });
        send({
          type: 'step', agent: 'layout_agent',
          text: brief.lang === 'he'
            ? `הלקוחה שלחה ${userMedia.length === 1 ? 'קובץ אחד משלה' : userMedia.length + ' קבצים משלה'} — מעצבים סביב תמונות אמיתיות במקום סטוק.`
            : `The client sent ${userMedia.length} of their own ${userMedia.length === 1 ? 'file' : 'files'} — designing around real imagery instead of stock.`
        });
      }
    }
    const userHero = (userMedia.find(m => m.kind === 'image') || {}).url || null;
    if (userHero) send({ type: 'image', url: userHero });
    else heroPromise.then(url => { if (url) send({ type: 'image', url }); });

    const crewBrief = {
      business: brief.business, category: brief.category, description: brief.description,
      lang: brief.lang, style: brief.style,
      ...(userMedia.length ? {
        user_photos: userMedia.filter(m => m.kind === 'image').length,
        user_videos: userMedia.filter(m => m.kind === 'video').length
      } : {})
    };
    let lastPhase = -1;
    const result = await engine.runBuild(crewBrief, (step, phase) => {
      if (phase !== lastPhase) {
        lastPhase = phase;
        send({ type: 'phase', n: phase });
        // One $ai_generation per crew phase (LLM analytics, card u4xmePAo). The
        // trace id is the local run id — this rides the callback the engine
        // already fires; it makes NO extra Agent Engine calls. No-op if disabled.
        posthog.captureAiGeneration(phId, aiTraceId, { $ai_span_name: 'agent_engine_phase_' + phase, phase, lang: brief.lang });
      }
      const text = brief.lang === 'he' ? step.text : englishOnly(step.text);
      // skip leftovers with no real content (e.g. a bare "---" divider after
      // filtering). Unicode-aware on purpose: the old /[a-zA-Z0-9]/ check
      // silently dropped every pure-Hebrew line from Hebrew builds' live feed.
      if (text && /[\p{L}\p{N}]/u.test(text)) send({ type: 'step', agent: step.agent, text });
    });
    let spec = result.spec;
    if (!spec) {
      spec = fallbackSpec(brief);
      send({
        type: 'step', agent: 'opsagents_builder_orchestrator',
        text: brief.lang === 'he'
          ? 'מרכיבים את הטיוטה הסופית מהרשימות של הצוות — עוד רגע.'
          : 'Pulling the final draft together from the team\'s notes — one more moment.'
      });
    }
    const heroImage = userHero
      || await Promise.race([heroPromise, new Promise(r => setTimeout(() => r(null), 20000))]);
    const html = render(spec, { heroImage, userMedia });
    send({ type: 'site', spec, heroImage: heroImage || null, userMedia, html });
    posthog.capture(phId, 'site_build_completed', { category: brief.category, lang: brief.lang, used_fallback: !result.spec });
  } catch (e) {
    // Reliability floor (charter): a build never ends in a bare error. The
    // spec-parse fallback above only covers a crew run that FINISHED without a
    // usable spec — this path covers total engine failure (throw mid-run,
    // engine outage, zero events). Same deterministic category-aware draft,
    // flagged with an honest system line. Witnessed live 2026-06-11 17:31 UTC:
    // start → image → error → done left the user at a dead end (card aAp5r5af).
    console.warn('[build] engine failed, serving deterministic fallback:', String((e && e.message) || e).slice(0, 300));
    // Server-side error tracking (card u4xmePAo) — no-op when PostHog is off.
    posthog.captureException(e, phId, { route: '/api/build', category: brief.category });
    try {
      send({
        type: 'step', agent: 'opsagents_builder_orchestrator',
        text: brief.lang === 'he'
          ? 'המנוע נתקל במערבולת באמצע הריצה — מרכיבים לך את הטיוטה מהפלייבוק של הצוות.'
          : 'The engine hit turbulence mid-run — assembling your draft from the team\'s playbook instead.'
      });
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

// ---- auth (card VI673sym) ---------------------------------------------------------
// Build stays open; Publish is the gate. All four routes ride the Firebase
// Hosting rewrite (first-party cookie); responses are never CDN-cacheable.

// Public client config so the browser can boot the Firebase Web SDK; apiKey /
// authDomain are public by design. `me` reflects the caller's session.
app.get('/api/auth-config', (req, res) => {
  const session = auth.sessionFromReq(req);
  res.set('Cache-Control', 'private, no-store').json({
    authEnabled: auth.AUTH_ENABLED,
    firebase: auth.AUTH_ENABLED
      ? { apiKey: auth.FB_API_KEY, authDomain: auth.FB_AUTH_DOMAIN, projectId: auth.FB_PROJECT }
      : null,
    me: session ? { uid: session.uid || null, email: session.email || '' } : null
  });
});

// Public analytics config (card u4xmePAo). The PROJECT key is public by
// design — write-only, browser-safe — but it is served rather than baked into
// the HTML so that (a) nothing is committed to this Apache-2.0 repo, and (b)
// an unbound deployment answers `enabled:false` instead of shipping a page
// wired to a key that does not exist.
//
// `reason` travels even when disabled, deliberately: "nobody bound a key",
// "somebody pasted a personal key" and "the key is truncated" are three
// different operator actions, and `enabled:false` alone reads as opt-out.
app.get('/api/analytics-config', (_req, res) => {
  const v = analytics.VERDICT;
  res.set('Cache-Control', 'no-store').json({
    enabled: v.enabled,
    reason: v.reason,
    apiHost: v.apiHost,
    projectKey: v.projectKey,
  });
});

// Exchange a verified Firebase ID token for our HMAC session cookie.
app.post('/api/session', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  if (!auth.AUTH_ENABLED) return res.status(503).json({ error: 'Sign-in is not configured on this deployment.' });
  const idToken = (req.body && req.body.idToken) || '';
  try {
    const claims = await auth.verifyFirebaseIdToken(idToken, { projectId: auth.FB_PROJECT });
    // Carry email_verified into the session so privileged gates (admin) can
    // require a verified identity — a Firebase token can match an allowlisted
    // email string while email_verified:false (e.g. Email/Password provider).
    auth.setSessionCookie(res, auth.signSession({
      exp: Date.now() + auth.SESSION_TTL_MS, uid: claims.sub,
      email: claims.email || '', email_verified: claims.email_verified === true
    }), auth.SESSION_TTL_MS);
    res.json({ ok: true, uid: claims.sub, email: claims.email || '' });
  } catch (e) {
    // generic to the client (no verifier-internal oracle); detail to server logs.
    console.warn('[auth] /api/session verify rejected:', String((e && e.message) || e));
    res.status(401).json({ error: 'Sign-in failed.' });
  }
});

app.post('/api/logout', (_req, res) => {
  auth.setSessionCookie(res, '', 0);
  res.set('Cache-Control', 'private, no-store').json({ ok: true });
});

// My Sites — one route, two behaviors so the auth-off and auth-on deploys share
// a codebase. Signed in (auth-enabled deploy): the caller's own sites from the
// owners/{uid}/ index, never a cross-user list. Otherwise: the anonymous device
// memory (card jvsQp6cS) answers by ?device= — the 128-bit random id IS the
// lookup key (possession only, same as knowing the public site URLs).
app.get('/api/my-sites', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0];
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  const base = PUBLIC_BASE_URL || `${proto}://${host}`;
  // Account path — only reachable when sign-in is configured AND the caller has
  // a valid session. Never returns another user's sites.
  if (auth.AUTH_ENABLED) {
    const session = auth.sessionFromReq(req);
    if (session && session.uid) {
      try {
        const sites = (await listSitesByOwner(session.uid)).map(s => ({ ...s, url: `${base}/sites/${s.id}` }));
        return res.json({ sites });
      } catch (e) {
        return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
      }
    }
  }
  // Anonymous device path (no session). A malformed/absent id is an invite to
  // sign in on the auth-on deploy, or a plain bad request on the auth-off one.
  const device = String(req.query.device || '');
  if (!/^[a-f0-9]{32}$/.test(device)) {
    return auth.AUTH_ENABLED
      ? res.status(401).json({ error: 'Sign in to see your sites.' })
      : res.status(400).json({ error: 'Bad device id.' });
  }
  try {
    const sites = await listDeviceSites(device);
    res.json({ sites: sites.map(s => ({ ...s, url: `${base}/sites/${s.id}` })) });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
});

// ---- media uploads ----------------------------------------------------------------
// The browser asks for a short-lived signed PUT URL, then sends the file
// straight to the private uploads bucket — file bytes never pass through this
// service at intake time. Type + size are bound into the signature and
// re-verified from object metadata before anything is used in a build.
app.post('/api/uploads/sign', async (req, res) => {
  if (!uploads.ENABLED) return res.status(503).json({ error: 'Uploads are not enabled on this deployment.' });
  // Signed URLs are write-capable — they live under the BUILD budget too: an
  // IP that exhausted its builds has no legitimate reason to keep minting
  // them (review finding 1). peek() doesn't consume a build slot, so a normal
  // pre-build upload burst never eats into the visitor's builds.
  if (!rateOk.peek(req)) return res.status(429).json({ error: 'Rate limit reached — try again in a bit.' });
  if (!uploadRateOk(req)) return res.status(429).json({ error: 'Upload limit reached — try again in a bit.' });
  try {
    const body = req.body || {};
    const signed = await uploads.signUpload(String(body.contentType || ''), Number(body.size));
    res.json(signed);
  } catch (e) {
    res.status((e && e.status) || 500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
});

// P2b (card RzaCDxAa): a signed-in owner sends new photos to one of THEIR
// sites. Ownership is verified server-side (session uid vs the site meta's
// ownerUid) and a re-render request lands on the site meta; the engine is
// NEVER called from this path — see lib/p2b-media.js.
app.post('/api/site-media', p2b.siteMediaRoute({ auth, rateOk, uploadRateOk }));

// ---- connect-your-domain (card DYE9159z) ----------------------------------------
// A paid-tier owner attaches an owned domain to one of THEIR published sites via
// the Firebase Hosting customDomains REST API, then polls attach/DNS/TLS state.
// Auto-TLS is Firebase's — we only surface cert state and translate the required
// DNS records for the guided copy-paste flow (see lib/domains.js + the runbook).
//
// Gate order is deliberate and fail-closed:
//   1. auth configured + valid session (never anonymous — a domain needs an owner)
//   2. paid tier (custom domains are a paid capability)
//   3. ownership: the session uid must equal the site meta's ownerUid
// so an unauthenticated or non-owning probe can never touch another user's domain.
async function resolveDomainOwner(req, res, siteId) {
  if (!domains.ENABLED) {
    res.status(503).set('Cache-Control', 'private, no-store')
      .json({ error: 'Custom domains are not configured on this deployment.' });
    return null;
  }
  if (!auth.AUTH_ENABLED) {
    res.status(503).set('Cache-Control', 'private, no-store')
      .json({ error: 'Sign-in must be configured to connect a domain.' });
    return null;
  }
  const session = auth.sessionFromReq(req);
  if (!session || !session.uid) {
    res.status(401).set('Cache-Control', 'private, no-store')
      .json({ error: 'Sign in to connect a domain.', signin: true });
    return null;
  }
  if (!domains.isPaid(session.uid)) {
    res.status(403).set('Cache-Control', 'private, no-store')
      .json({ error: 'Connecting a custom domain is a paid-plan feature.', upgrade: true });
    return null;
  }
  if (!/^[a-f0-9]{8}$/.test(String(siteId))) {
    res.status(400).set('Cache-Control', 'private, no-store').json({ error: 'Bad site id.' });
    return null;
  }
  const meta = await loadSiteMeta(siteId);
  if (!meta || meta.ownerUid !== session.uid) {
    // Same 404 for "no such site" and "not yours" — never reveal another
    // owner's site exists (mirrors p2b-media ownership handling).
    res.status(404).set('Cache-Control', 'private, no-store').json({ error: 'Site not found.' });
    return null;
  }
  return { session, meta };
}

app.post('/api/domains/connect', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const siteId = String((req.body && req.body.siteId) || '');
  const ctx = await resolveDomainOwner(req, res, siteId);
  if (!ctx) return;
  const host = domains.normalizeHost((req.body && req.body.domain) || '');
  if (!host) return res.status(400).json({ error: 'Enter a valid domain you own, e.g. shop.example.com.' });
  try {
    const summary = await domains.attachCustomDomain(host);
    // Persist the attach state on the site meta so /board can paint it without
    // re-hitting Hosting; best-effort — the live summary is what we return.
    await saveSiteDomain(siteId, summary).catch(() => { /* meta stamp is best-effort */ });
    res.json({ ok: true, domain: summary });
  } catch (e) {
    res.status((e && e.status) || 502).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
});

app.get('/api/domains/status', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const siteId = String(req.query.siteId || '');
  const ctx = await resolveDomainOwner(req, res, siteId);
  if (!ctx) return;
  // Which domain to poll: the explicit query wins, else the one on record.
  const onRecord = ctx.meta.domain && ctx.meta.domain.host;
  const host = domains.normalizeHost(req.query.domain || onRecord || '');
  if (!host) return res.json({ ok: true, domain: null }); // nothing connected yet
  try {
    const summary = await domains.getCustomDomain(host);
    await saveSiteDomain(siteId, summary).catch(() => { /* best-effort refresh */ });
    res.json({ ok: true, domain: summary });
  } catch (e) {
    // A not-yet-created domain reads as 404 from Hosting — report "none" rather
    // than an error so the board shows the connect form, not a failure.
    if (e && e.status === 404) return res.json({ ok: true, domain: null });
    res.status((e && e.status) || 502).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
});

// ---- publish --------------------------------------------------------------------
app.post('/api/publish', async (req, res) => {
  try {
    // The gate: when sign-in is configured, publishing requires a session so
    // every published site has an owner. When it isn't (local dev, judge
    // clone), publish stays anonymous — exactly the pre-auth behavior.
    const session = auth.AUTH_ENABLED ? auth.sessionFromReq(req) : null;
    if (auth.AUTH_ENABLED && (!session || !session.uid)) {
      return res.status(401).set('Cache-Control', 'private, no-store')
        .json({ error: 'Sign in to publish your site.', signin: true });
    }
    // Abuse cap (ns341yIF): checked after the auth gate so an unauthenticated
    // probe can never burn a signed-in user's bucket slot.
    if (!publishRateOk(session && session.uid ? `uid:${session.uid}` : req)) {
      return res.status(429).json({ error: 'Publish limit reached for today — try again tomorrow.' });
    }
    const spec = req.body && req.body.spec;
    if (!spec || !spec.business) return res.status(400).json({ error: 'Missing site spec to publish.' });
    if (JSON.stringify(spec).length > 100_000) return res.status(413).json({ error: 'Spec too large.' });
    const heroImage = String(req.body.heroImage || '');
    // No-sign-in memory (card jvsQp6cS): a well-formed device id gets stamped
    // into the site's meta and a devices/<id>/<site> marker so /api/my-sites
    // can find it again. Malformed ids are simply ignored — never an error.
    const deviceId = /^[a-f0-9]{32}$/.test(String(req.body.deviceId || '')) ? String(req.body.deviceId) : '';
    // media URLs are re-validated against our own public-bucket shape (card 0wdldq3z) —
    // the published page never embeds an arbitrary client-supplied URL
    const userMedia = uploads.sanitizeUserMedia(req.body.userMedia);
    const html = render(spec, { heroImage, userMedia }); // always server-rendered — never client HTML
    // Stamp ownership two ways, both optional and independent: an owner record
    // (signed-in publish, card VI673sym) and a device marker (anonymous memory,
    // card jvsQp6cS). On the auth-off deploy `session` is always null; on the
    // auth-on deploy a publish without a session is rejected above.
    const id = await saveSite(
      html,
      {
        business: String(spec.business).slice(0, 120),
        ...(deviceId ? { deviceId } : {})
      },
      session ? { uid: session.uid, email: session.email || '' } : null
    );
    if (deviceId) await rememberDeviceSite(deviceId, id).catch(() => { /* memory is best-effort */ });
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0];
    const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    const base = PUBLIC_BASE_URL || `${proto}://${host}`;
    // LLM-EO: publish llms.txt next to the HTML so AI assistants can read the
    // business at a glance (llmstxt.org). Non-fatal — the site is the product.
    try { await saveLlms(id, llmsTxt(spec, `${base}/sites/${id}`)); } catch { /* best-effort */ }
    // P2b (card RzaCDxAa): keep the spec on file next to the HTML so "send the
    // team new photos" can re-render this site later WITHOUT an engine run.
    try { await p2b.saveSpec(id, spec); } catch { /* best-effort */ }
    // Publish activation event, server-side (card u4xmePAo). The client also
    // emits site_published (rsbPH) — both fire so the funnel is covered even if
    // the browser closes right after the request lands. No-op when disabled.
    posthog.capture('publish_' + id, 'site_published', { id, business: String(spec.business).slice(0, 120), signed_in: !!session });
    res.json({ id, url: `${base}/sites/${id}` });
  } catch (e) {
    posthog.captureException(e, 'publish', { route: '/api/publish' });
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
});

app.get(['/sites/:id', '/sites/:id/'], async (req, res) => {
  const html = await loadSite(req.params.id);
  if (!html) return res.status(404).type('text/plain').send('Site not found');
  res.set('Cache-Control', 'public, max-age=300').type('html').send(html);
});

app.get('/sites/:id/llms.txt', async (req, res) => {
  const txt = await loadLlms(req.params.id);
  if (!txt) return res.status(404).type('text/plain').send('Not found');
  res.set('Cache-Control', 'public, max-age=300').type('text/plain; charset=utf-8').send(txt);
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
    posthog.captureException(e, 'ask', { route: '/api/ask' });
    res.status(502).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
});

// ---- agent actions: the client's approve/decline decision (card 7uOa4dJ8) ---------
// The board's approval gate used to be pure in-page demo state. This is its real
// counterpart: the decision is RECORDED (structured audit line + PostHog event)
// and, when the engine is configured, DELIVERED to the live orchestrator as one
// real turn — the same transport /api/ask uses. This endpoint never publishes,
// never mutates a site, and rides the build rate budget like /api/ask.
const ACTION_AGENTS = new Set([
  'aria', 'leo', 'noa', 'sam', 'max', 'phoenix',
  'vera', 'ben', 'uri', 'gil', 'tova', 'cara'
]);
app.post('/api/agent-actions', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  if (!rateOk(req)) return res.status(429).json({ error: 'Rate limit reached — try again in a bit.' });
  const body = req.body || {};
  const agent = String(body.agent || '').toLowerCase().trim();
  const action = body.action === 'approve' ? 'approve' : body.action === 'decline' ? 'decline' : null;
  if (!ACTION_AGENTS.has(agent) || !action) {
    return res.status(400).json({ error: 'Unknown agent or action.' });
  }
  const business = String(body.business || '').slice(0, 120);
  const siteUrl = String(body.siteUrl || '').slice(0, 200);
  const deviceId = /^[a-f0-9]{32}$/.test(String(body.deviceId || '')) ? String(body.deviceId) : '';
  const session = auth.AUTH_ENABLED ? auth.sessionFromReq(req) : null;
  // who/what/when — the audit line the whole feature hangs on. `who` prefers the
  // signed-in identity; the anonymous device id is possession-scoped like the
  // rest of the device-memory flow; a bare visitor is honestly 'anonymous'.
  const who = (session && session.email) || (deviceId ? 'device:' + deviceId : 'anonymous');
  const at = new Date().toISOString();
  const id = 'act_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  console.log(JSON.stringify({ audit: 'agent_action', id, who, agent, action, business, siteUrl, at }));
  posthog.capture(id, 'agent_action_recorded', { who, agent, action, business, at });

  // Deliver the decision to the live orchestrator — a real Agent Engine turn.
  // Failure here never voids the request: the decision is already recorded, so
  // the client keeps an honest `engineNotified:false` instead of a rollback.
  let ack = '';
  if (engine.ENABLED) {
    const he = body.lang === 'he';
    const prompt =
      'You are Theo, the orchestrator of the AI web team operating the client\'s website' +
      (business ? ` ("${business}"${siteUrl ? ', live at ' + siteUrl : ''})` : '') + '. ' +
      `The client just ${action === 'approve' ? 'APPROVED' : 'DECLINED'} the pending proposal from your ${agent} agent. ` +
      (action === 'approve'
        ? 'Acknowledge the approval to the client in 1-2 warm sentences and say the team will proceed carefully.'
        : 'Acknowledge the decision to the client in 1-2 warm sentences and confirm nothing will change without them.') +
      ' Do not call any tools, do not transfer to another agent, do not publish anything.' +
      (he ? ' Reply in Hebrew.' : ' Reply in English only.');
    try {
      const reply = await engine.oneTurn(prompt, 20000);
      ack = (he ? reply : englishOnly(reply)).slice(0, 400);
    } catch (e) {
      posthog.captureException(e, id, { route: '/api/agent-actions', agent, action });
    }
  }
  res.json({ ok: true, id, at, engineNotified: !!ack, ack });
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

// ---- admin: all published sites (card fp7wXxjb, mandatory baseline #1) -------------
// Two gates, both env-driven (see lib/admin.js): an allowlisted signed-in email
// (browser) or an x-admin-key header (automation). Non-admins get 404 — never a
// 403 — so the surface's existence isn't confirmed, and the cross-tenant list is
// only ever assembled for an authorized caller (never a client-side bucket read).
function adminFromReq(req) {
  if (adminKeyOk(req.get('x-admin-key'))) return { via: 'key' };
  if (auth.AUTH_ENABLED) {
    const s = auth.sessionFromReq(req);
    // Verified-email allowlist check (lib/admin.sessionIsAdmin): a matching
    // email string is not enough — a token can carry an allowlisted email with
    // email_verified:false. Pre-plumbing sessions lack the field → unverified.
    if (sessionIsAdmin(s)) return { via: 'session', email: s.email };
  }
  return null;
}

app.get('/api/admin/sites', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  if (!adminFromReq(req)) return res.status(404).json({ error: 'Not found.' });
  try {
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0];
    const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    const base = PUBLIC_BASE_URL || `${proto}://${host}`;
    const sites = (await listAllSites()).map(s => ({ ...s, url: `${base}/sites/${s.id}` }));
    res.json({ sites, count: sites.length });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
});

// ---- admin: tenant-grouped multi-tenant board (card 1BzUR9n2, Dash-E) --------------
// Same gate + 404 posture as /api/admin/sites. The cross-tenant list is only ever
// assembled server-side behind adminFromReq — the client NEVER reads the bucket
// (it is private; every read in this app goes through this service). Grouping is
// pure and unit-tested. Tenant identity: signed-in owner email → hashed device
// key (the raw device id is a possession credential and stays server-side, like
// ownerUid) → the anonymous bucket. lastActivity is the tenant's newest publish —
// publishing is the only per-site activity this app records, so nothing richer
// is claimed here.
function groupTenants(sites) {
  const by = new Map();
  for (const s of sites || []) {
    let kind, key, label;
    if (s.ownerEmail) { kind = 'account'; key = 'acct:' + s.ownerEmail.toLowerCase(); label = s.ownerEmail; }
    else if (s.deviceKey) { kind = 'device'; key = 'dev:' + s.deviceKey; label = 'device · ' + s.deviceKey; }
    else { kind = 'anonymous'; key = 'anon'; label = 'anonymous publishes'; }
    let t = by.get(key);
    if (!t) { t = { key, kind, label, sites: [], lastActivity: '' }; by.set(key, t); }
    t.sites.push({ id: s.id, business: s.business || '', createdAt: s.createdAt || '', url: s.url || '' });
    if ((s.createdAt || '') > t.lastActivity) t.lastActivity = s.createdAt || '';
  }
  const tenants = [...by.values()];
  for (const t of tenants) {
    t.sites.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    t.siteCount = t.sites.length;
  }
  tenants.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  return tenants;
}

app.get('/api/admin/tenants', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  if (!adminFromReq(req)) return res.status(404).json({ error: 'Not found.' });
  try {
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0];
    const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    const base = PUBLIC_BASE_URL || `${proto}://${host}`;
    const all = (await listAllSites()).map(s => ({ ...s, url: `${base}/sites/${s.id}` }));
    const tenants = groupTenants(all);
    res.json({ tenants, tenantCount: tenants.length, siteCount: all.length });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
});

// ---- pages + health ---------------------------------------------------------------
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'web', 'index.html')));
app.get(['/board', '/board/'], (_req, res) => res.sendFile(path.join(__dirname, 'web', 'board', 'index.html')));
app.get(['/campfire', '/campfire/'], (_req, res) => res.sendFile(path.join(__dirname, 'web', 'campfire', 'index.html')));
// The admin shell carries no data and no auth-scheme detail — it just runs the
// standard Google sign-in and calls /api/admin/sites, which is the real gate.
app.get(['/admin', '/admin/'], (_req, res) => res.sendFile(path.join(__dirname, 'web', 'admin', 'index.html')));
app.get('/api/health', (_req, res) => res.json({
  ok: true,
  agentEngine: engine.ENABLED,
  imagesBucket: !!process.env.SITE_IMAGES_BUCKET,
  sitesBucket: !!process.env.PUBLISHED_SITES_BUCKET,
  // true only when PUBLIC_MEDIA_BASE_URL passed lib/publicMedia's https-origin
  // validation — the operator's post-flip verification signal (card 7KlXAiW0).
  publicMediaBase: !!MEDIA_BASE,
  auth: auth.AUTH_ENABLED,
  admin: auth.AUTH_ENABLED || !!process.env.ADMIN_KEY,
  uploadsBucket: uploads.ENABLED,
  customDomains: domains.ENABLED,
  posthog: analytics.ENABLED,
  categories: Object.keys(CATEGORIES)
}));
// Client runtime config (card WZtm0jA3): the GA4 Measurement ID this deployment
// is wired to, read by web/analytics.js. Empty string when unset → analytics is
// a no-op, so a judge cloning the public repo runs with zero tracking config.
// PostHog (card u4xmePAo): the project key + ingest host read by web/posthog.js.
// Empty key → posthog-js stays a no-op. NEVER a personal phx_ key — a project
// key (phc_…) for an OpsAgents PostHog project, bound at deploy by an operator.
// Card uLLFw04n: the post-publish offer's price, read from the products server
// (/v1/products) — never a literal. 503 means "hide the offer".
const readRsbPrice = require('./lib/pricing').makePriceReader();
app.get('/api/price', async (_req, res) => {
  const price = await readRsbPrice();
  res.set('Cache-Control', 'no-store');
  if (!price) return res.status(503).json({ error: 'price_unavailable' });
  res.json(price);
});

app.get('/api/client-config', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    ga4Id: process.env.GA4_MEASUREMENT_ID || '',
    posthogKey: process.env.POSTHOG_KEY || '',
    posthogHost: process.env.POSTHOG_HOST || 'https://us.i.posthog.com'
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`rapid-site-builder on :${PORT}`));
  // Flush buffered PostHog events before the Cloud Run instance freezes/exits
  // (card u4xmePAo AC #6). Both signals so SIGTERM (Cloud Run scale-down) and
  // SIGINT (local Ctrl-C) drain. No-op when PostHog is disabled.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => { await posthog.shutdown(); process.exit(0); });
  }
}

module.exports = { app, cleanBrief, limiter, hourlyBudget, fallbackSpec, groupTenants };
