'use strict';
// Sign-in for Publish + per-user "My Sites" (card VI673sym).
//
// Build stays OPEN — the one-line-brief hook must never see a login wall.
// Publish is the gate: the browser signs in with Google (Firebase Auth),
// POSTs the ID token to /api/session, we verify it here with Node's built-in
// crypto only (no firebase-admin — keeps the image dependency-free), and mint
// our own HMAC session cookie. Published sites are stamped ownerUid so
// GET /api/my-sites can return only the caller's sites.
//
// Fail-closed by configuration: per-user (uid-bearing) sessions exist only
// when an independent high-entropy SESSION_SECRET is set alongside the
// Firebase client config. With any of the three env vars missing the app
// behaves exactly like the pre-auth build — anonymous publish, no ownerUid —
// so a judge cloning the public repo runs it with zero Firebase setup.
//
// Cookie name is `__session` ON PURPOSE: Firebase Hosting strips every other
// cookie when proxying through the rewrite to Cloud Run, in both directions.

const crypto = require('crypto');

// ---- configuration ---------------------------------------------------------
const FB_PROJECT = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
const FB_API_KEY = process.env.FIREBASE_API_KEY || '';
const FB_AUTH_DOMAIN = process.env.FIREBASE_AUTH_DOMAIN || (FB_PROJECT ? `${FB_PROJECT}.firebaseapp.com` : '');
const SESSION_SECRET = process.env.SESSION_SECRET || '';

const AUTH_ENABLED = !!(FB_PROJECT && FB_API_KEY && SESSION_SECRET);
if ((FB_PROJECT || FB_API_KEY) && !AUTH_ENABLED) {
  console.warn('[auth] Firebase env is partially set (need FIREBASE_PROJECT_ID + FIREBASE_API_KEY + SESSION_SECRET) — ' +
    'sign-in is DISABLED (fail-closed) and publish stays anonymous. uid sessions are only ever signed by SESSION_SECRET.');
}

// 24h sessions: this is a consumer surface where the cost of expiry is one
// extra Google popup at publish time, not a tenant-revocation window.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COOKIE = '__session';

// ---- Firebase ID-token verification (dependency-free) -----------------------
// A Firebase ID token is a JWT signed RS256 by Google's securetoken service;
// we fetch the matching X.509 cert by `kid`, verify the signature, and validate
// the standard claims (aud == projectId, iss, exp/iat, sub). `sub` is the uid.

const CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function decodeSegment(s) {
  return JSON.parse(b64urlToBuf(s).toString('utf8'));
}

// module-level cert cache (honors the endpoint's Cache-Control max-age).
// `fetchedAt` backs a refetch cooldown so a flood of tokens with bogus `kid`s
// can't bust the cache and amplify outbound fetches to Google's cert endpoint.
let _cache = { certs: null, exp: 0, fetchedAt: 0 };
function _resetCache() { _cache = { certs: null, exp: 0, fetchedAt: 0 }; }

// A genuinely rotated key is still picked up within this window via the normal
// max-age expiry, and Google overlaps old+new certs for hours — so serving
// slightly-stale certs to an unknown kid is safe, while bogus-kid spam costs
// at most one fetch per gap.
const MIN_REFETCH_MS = 5 * 60 * 1000;

// own-property cert lookup — never resolve `__proto__`/`constructor`/etc. from
// an attacker-controlled `kid` to an inherited Object member.
function ownCert(certs, kid) {
  return Object.prototype.hasOwnProperty.call(certs, kid) ? certs[kid] : null;
}

async function fetchGoogleCerts(fetchImpl) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('no fetch available');
  const r = await f(CERT_URL);
  if (!r.ok) throw new Error('cert fetch ' + r.status);
  const certs = await r.json();
  let ttl = 3600;
  const cc = r.headers && typeof r.headers.get === 'function' ? r.headers.get('cache-control') : '';
  if (cc) { const m = /max-age=(\d+)/.exec(cc); if (m) ttl = Number(m[1]); }
  return { certs, ttl };
}

async function getCerts(opts, force) {
  const t = opts.now ? opts.now() : Date.now();
  if (!force && _cache.certs && _cache.exp > t) return _cache.certs;
  if (force && _cache.certs && (t - _cache.fetchedAt) < MIN_REFETCH_MS) return _cache.certs;
  const { certs, ttl } = await fetchGoogleCerts(opts.fetchImpl);
  _cache = { certs, exp: t + ttl * 1000, fetchedAt: t };
  return certs;
}

// Verify a Firebase ID token. Resolves to the decoded payload (with `sub` = uid,
// `email`, …) or throws an Error with a short reason. `opts.projectId` required.
// `opts.fetchImpl` / `opts.now` are injectable for tests.
async function verifyFirebaseIdToken(token, opts) {
  opts = opts || {};
  const projectId = opts.projectId;
  if (!projectId) throw new Error('projectId required');
  if (!token || typeof token !== 'string') throw new Error('missing token');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, sig] = parts;

  let header, payload;
  try { header = decodeSegment(h); payload = decodeSegment(p); }
  catch { throw new Error('undecodable token'); }

  if (header.alg !== 'RS256') throw new Error('bad alg');
  if (!header.kid) throw new Error('no kid');

  const nowSec = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const skew = opts.clockSkewSec != null ? opts.clockSkewSec : 60;
  if (payload.aud !== projectId) throw new Error('bad aud');
  if (payload.iss !== 'https://securetoken.google.com/' + projectId) throw new Error('bad iss');
  if (typeof payload.exp !== 'number' || payload.exp + skew < nowSec) throw new Error('token expired');
  if (typeof payload.iat !== 'number' || payload.iat - skew > nowSec) throw new Error('token issued in future');
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('no sub');

  let certs = await getCerts(opts);
  let pem = ownCert(certs, header.kid);
  if (!pem) {
    // kid not in cached certs — may be a freshly-rotated key. Refetch ONCE,
    // rate-limited by the cooldown so bogus-kid floods can't amplify fetches.
    certs = await getCerts(opts, true);
    pem = ownCert(certs, header.kid);
    if (!pem) throw new Error('unknown kid');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(h + '.' + p);
  verifier.end();
  if (!verifier.verify(pem, b64urlToBuf(sig))) throw new Error('bad signature');

  return payload;
}

// ---- HMAC session cookie ----------------------------------------------------
// Payload: { exp, uid, email }. Only ever signed with SESSION_SECRET — there is
// no fallback key, so with auth disabled no session can exist at all.

function signSession(payload) {
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET unset');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

// Returns the decoded payload object when valid (truthy), else null.
function verifySession(token) {
  if (!SESSION_SECRET || !token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig || ''), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return (data && data.exp > Date.now()) ? data : null;
  } catch { return null; }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function setSessionCookie(res, token, maxAgeMs) {
  // SameSite=Lax works because every auth call rides the Firebase Hosting
  // rewrite (first-party on the site's own domain); only the long SSE build
  // goes cross-origin, and it carries no cookie.
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; ${attrs.join('; ')}`);
}

function sessionFromReq(req) {
  return verifySession(readCookie(req, COOKIE));
}

module.exports = {
  AUTH_ENABLED, FB_PROJECT, FB_API_KEY, FB_AUTH_DOMAIN, SESSION_TTL_MS, COOKIE,
  verifyFirebaseIdToken, signSession, verifySession, readCookie, setSessionCookie,
  sessionFromReq, decodeSegment, _resetCache
};
