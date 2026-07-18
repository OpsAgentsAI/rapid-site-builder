'use strict';
// P2b — Operate-board media (card RzaCDxAa). "Send the team new photos": a
// signed-in owner attaches freshly verified uploads to one of THEIR published
// sites. The upload path is P2a's exactly (signed PUT URLs into the private
// bucket, metadata re-verification, EXIF strip, public copies via
// uploads.prepareUserMedia) — this module adds the post-login half:
//
//   1. server-side ownership: the session uid must equal the ownerUid stamped
//      into the site's meta at publish — never the client's word;
//   2. a re-render request recorded ON the site meta (status: pending), so the
//      Theo→Leo handoff is durable even when nothing re-renders yet;
//   3. only behind P2B_RERENDER_ENABLED=1 an engine-free re-render: pure
//      render() over the spec persisted at publish time (saveSpec below).
//
// The Vertex Agent Engine is NEVER called from this path — engine runs burn
// quota, so anything that would need a fresh crew run (pre-P2b sites with no
// stored spec) stays a queued request for an explicit operator decision.

const { Storage } = require('@google-cloud/storage');
const uploads = require('./uploads');
const { render } = require('./renderer');

const BUCKET = process.env.PUBLISHED_SITES_BUCKET || '';
const storage = new Storage();

const SITE_RE = /^[a-f0-9]{8}$/;
// Default OFF: flipping the re-render on is a deliberate deploy-time decision,
// never a side effect of merging this card.
const RERENDER_ENABLED = process.env.P2B_RERENDER_ENABLED === '1';

// ---- pure helpers (unit-tested) --------------------------------------------

// The ownership gate. Sites published before login existed carry no ownerUid —
// they belong to nobody, so media updates on them are refused for everyone.
function ownsSite(meta, uid) {
  return !!(meta && uid && typeof uid === 'string'
    && typeof meta.ownerUid === 'string' && meta.ownerUid === uid);
}

// Validate + cap the client's media list: server-shaped upload names only,
// same per-build ceiling as the P2a intake path.
function cleanMediaNames(list) {
  return (Array.isArray(list) ? list : [])
    .filter(n => typeof n === 'string' && uploads.NAME_RE.test(n))
    .slice(0, uploads.MAX_FILES_PER_BUILD);
}

// The re-render request record stamped into the site meta. `media` is the list
// of VERIFIED public copies (prepareUserMedia's output) — never raw client
// input, and re-shaped defensively anyway.
function buildRerenderRequest(uid, media, now) {
  return {
    status: 'pending',
    requestedAt: new Date(now || Date.now()).toISOString(),
    requestedBy: String(uid),
    media: (Array.isArray(media) ? media : [])
      .slice(0, uploads.MAX_FILES_PER_BUILD)
      .filter(m => m && typeof m.url === 'string')
      .map(m => ({ url: m.url, kind: m.kind === 'video' ? 'video' : 'image' }))
  };
}

// ---- GCS I/O ---------------------------------------------------------------

async function readJson(name) {
  try {
    const [buf] = await storage.bucket(BUCKET).file(name).download();
    return JSON.parse(buf.toString('utf8'));
  } catch { return null; }
}
async function writeJson(name, obj) {
  await storage.bucket(BUCKET).file(name).save(JSON.stringify(obj), {
    contentType: 'application/json', resumable: false
  });
}

async function loadSiteMeta(id) {
  if (!BUCKET || !SITE_RE.test(String(id))) return null;
  return readJson(`sites/${id}/meta.json`);
}

// Persist the publish-time spec next to the HTML (called from /api/publish).
// This is what makes an engine-free re-render possible later: render() is a
// pure function of (spec, media) — with the spec on file, "new photos" never
// needs the crew again. Best-effort at the call site; never fails a publish.
async function saveSpec(id, spec) {
  if (!BUCKET || !SITE_RE.test(String(id)) || !spec) return;
  await writeJson(`sites/${id}/spec.json`, spec);
}
async function loadSpec(id) {
  if (!BUCKET || !SITE_RE.test(String(id))) return null;
  return readJson(`sites/${id}/spec.json`);
}

// Engine-free re-render: pure render() over the stored spec with the new
// media. The first new photo takes over as the hero — the same rule the build
// itself applies to client media (server.js userHero).
async function applyRerender(id, spec, media) {
  const hero = (media.find(m => m.kind === 'image') || {}).url || null;
  const html = render(spec, { heroImage: hero, userMedia: media });
  await storage.bucket(BUCKET).file(`sites/${id}/index.html`).save(html, {
    contentType: 'text/html; charset=utf-8', resumable: false
  });
}

// ---- route -----------------------------------------------------------------

// POST /api/site-media — body { siteId, media: [uploadNames] }.
// First-party cookie route (rides the Firebase Hosting rewrite, same as the
// other auth routes); exists only on the auth-ON deploy — the hackathon
// auth-off surface answers 503 and is otherwise untouched.
function siteMediaRoute({ auth, rateOk, uploadRateOk }) {
  return async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!auth.AUTH_ENABLED) return res.status(503).json({ error: 'Sign-in is not configured on this deployment.' });
    const session = auth.sessionFromReq(req);
    if (!session || !session.uid) return res.status(401).json({ error: 'Sign in first.' });
    // Same abuse budgets as the P2a sign route: an IP that exhausted its
    // builds is blocked (peek — no slot burned), and every accepted request
    // consumes an upload slot.
    if (!rateOk.peek(req)) return res.status(429).json({ error: 'Rate limit reached — try again in a bit.' });
    if (!uploadRateOk(req)) return res.status(429).json({ error: 'Upload limit reached — try again in a bit.' });
    const body = req.body || {};
    const siteId = String(body.siteId || '');
    if (!SITE_RE.test(siteId)) return res.status(400).json({ error: 'Bad site id.' });
    const names = cleanMediaNames(body.media);
    if (!names.length) return res.status(400).json({ error: 'No valid uploads in the request.' });
    // Fail closed on configuration AFTER input validation (which is GCS-free)
    // and BEFORE any storage touch.
    if (!uploads.ENABLED || !BUCKET) return res.status(503).json({ error: 'Media updates are not enabled on this deployment.' });
    try {
      const meta = await loadSiteMeta(siteId);
      if (!meta) return res.status(404).json({ error: 'Site not found.' });
      if (!ownsSite(meta, session.uid)) return res.status(403).json({ error: 'Not your site.' });
      // Verify from each object's OWN metadata + copy into the public bucket —
      // the exact P2a pipeline, one shared implementation.
      const media = await uploads.prepareUserMedia(names);
      if (!media.length) return res.status(422).json({ error: 'None of the files passed verification.' });
      const request = buildRerenderRequest(session.uid, media, Date.now());
      if (RERENDER_ENABLED) {
        const spec = await loadSpec(siteId);
        if (spec) {
          await applyRerender(siteId, spec, request.media);
          request.status = 'applied';
          request.appliedAt = new Date().toISOString();
        } else {
          // Pre-P2b site: no stored spec, and a fresh crew run is an operator
          // decision — the request stays pending with an honest note.
          request.note = 'spec-unavailable — re-render needs an operator-approved engine run';
        }
      }
      await writeJson(`sites/${siteId}/meta.json`, { ...meta, rerender: request });
      res.json({ ok: true, siteId, status: request.status, media: request.media });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
    }
  };
}

module.exports = {
  RERENDER_ENABLED, SITE_RE,
  ownsSite, cleanMediaNames, buildRerenderRequest,
  loadSiteMeta, saveSpec, loadSpec, applyRerender, siteMediaRoute
};
