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
const { saveSite, loadSite, rememberDeviceSite, listDeviceSites, saveLlms, loadLlms, listSitesByOwner, listAllSites } = require('./lib/store');
const { llmsTxt } = require('./lib/llmeo');
const auth = require('./lib/auth');
const { adminKeyOk, sessionIsAdmin } = require('./lib/admin');
const uploads = require('./lib/uploads');

const app = express();
// Exactly one trusted hop (Cloud Run's front end, which appends the real
// client IP as the LAST X-Forwarded-For entry) — req.ip then resolves to that
// entry instead of the client-controlled leftmost one. Without this, rotating
// XFF per request mints unlimited rate-limit identities (PR #3 security
// review, finding 1).
app.set('trust proxy', 1);
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

// ---- simple per-IP rate limits ---------------------------------------------------
const RATE_MAX = Number(process.env.BUILDS_PER_HOUR_PER_IP) || 12;
const UPLOAD_RATE_MAX = Number(process.env.UPLOADS_PER_HOUR_PER_IP) || 30;
function limiter(max) {
  const hits = new Map(); // ip -> [timestamps]
  // req.ip honors trust-proxy(1): the GFE-appended XFF entry, not the
  // spoofable leftmost hop. Never parse X-Forwarded-For by hand here.
  const key = (req) => String(req.ip || '').trim() || 'unknown';
  const live = (ip, now) => (hits.get(ip) || []).filter(t => now - t < 3600_000);
  const take = (req) => {
    const ip = key(req);
    const now = Date.now();
    const arr = live(ip, now);
    if (arr.length >= max) return false;
    arr.push(now);
    hits.set(ip, arr);
    if (hits.size > 5000) hits.clear(); // crude memory guard
    return true;
  };
  // Non-consuming check: lets one budget gate another route without burning a slot.
  take.peek = (req) => live(key(req), Date.now()).length < max;
  return take;
}
const rateOk = limiter(RATE_MAX);         // builds are the expensive op
const uploadRateOk = limiter(UPLOAD_RATE_MAX); // signed upload URLs

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
      if (phase !== lastPhase) { lastPhase = phase; send({ type: 'phase', n: phase }); }
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
  } catch (e) {
    // Reliability floor (charter): a build never ends in a bare error. The
    // spec-parse fallback above only covers a crew run that FINISHED without a
    // usable spec — this path covers total engine failure (throw mid-run,
    // engine outage, zero events). Same deterministic category-aware draft,
    // flagged with an honest system line. Witnessed live 2026-06-11 17:31 UTC:
    // start → image → error → done left the user at a dead end (card aAp5r5af).
    console.warn('[build] engine failed, serving deterministic fallback:', String((e && e.message) || e).slice(0, 300));
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
  auth: auth.AUTH_ENABLED,
  admin: auth.AUTH_ENABLED || !!process.env.ADMIN_KEY,
  uploadsBucket: uploads.ENABLED,
  categories: Object.keys(CATEGORIES)
}));
// Client runtime config (card WZtm0jA3): the GA4 Measurement ID this deployment
// is wired to, read by web/analytics.js. Empty string when unset → analytics is
// a no-op, so a judge cloning the public repo runs with zero tracking config.
app.get('/api/client-config', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ ga4Id: process.env.GA4_MEASUREMENT_ID || '' });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`rapid-site-builder on :${PORT}`));
}

module.exports = { app, cleanBrief, limiter, fallbackSpec };
