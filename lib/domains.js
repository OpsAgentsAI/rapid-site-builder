'use strict';
// Connect-your-domain (card DYE9159z) — attach an owned domain to a published
// RSB site via the Firebase Hosting REST customDomains API, then poll cert +
// DNS state so the /board UI can guide the user through the DNS records.
//
// Dependency-free by design (matches lib/auth.js, lib/token.js): the Google
// access token comes from lib/token.js (metadata server on Cloud Run, gcloud
// locally) and every REST call is a plain global fetch. No firebase-admin, no
// google-api client — the image stays lean.
//
// Auto-TLS is Firebase's job: once the domain's ownership + host DNS records
// verify, Hosting provisions and renews the certificate. We surface the cert
// STATE (we never mint TLS ourselves) and translate requiredDnsUpdates into a
// small, copy-paste-friendly record list for the guided-DNS path.
//
// Feature-gated + fail-closed: with FIREBASE_HOSTING_SITE unset the whole
// feature reports DISABLED and the routes 503, exactly like a fresh clone that
// hasn't wired Hosting. No project id, engine name, or internal host is ever
// embedded here — all environment-specific values come from env vars.
//
// API shape verified against the Firebase Hosting v1beta1 discovery document
// (https://firebasehosting.googleapis.com/$discovery/rest?version=v1beta1):
//   create: POST v1beta1/{parent=projects/*/sites/*}/customDomains
//           ?customDomainId={host}   body: {} (state is read-only, server-set)
//   get:    GET  v1beta1/{name=projects/*/sites/*/customDomains/*}
// The CustomDomain resource carries hostState, ownershipState, cert.state and
// requiredDnsUpdates.desired[].records[] ({type, rdata, requiredAction}).

const { getAccessToken } = require('./token');

const API_ROOT = 'https://firebasehosting.googleapis.com/v1beta1';

// Which Hosting site the custom domains attach to. On the real-app deploy this
// is the site backing the app's own Firebase project (e.g. "rapid-site-builder").
// FIREBASE_PROJECT_ID reuses the auth module's variable when present.
const HOSTING_SITE = (process.env.FIREBASE_HOSTING_SITE || '').trim();
const HOSTING_PROJECT =
  (process.env.FIREBASE_HOSTING_PROJECT || process.env.FIREBASE_PROJECT_ID ||
   process.env.GOOGLE_CLOUD_PROJECT || '').trim();

// Custom domains are a paid-tier capability. The gate here is intentionally
// simple and deploy-configurable: a comma-separated allowlist of uids that have
// the paid plan. An empty allowlist means "no one is paid yet" (fail-closed) —
// the epic's billing integration will replace this with a plan lookup, but the
// route contract (403 for non-paid) stays the same. See runbook.
const PAID_UIDS = new Set(
  (process.env.PAID_TIER_UIDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
// Escape hatch for demos / self-host: PAID_TIER_OPEN=1 treats every signed-in
// user as paid (never set on the hosted product).
const PAID_OPEN = process.env.PAID_TIER_OPEN === '1';

const ENABLED = !!(HOSTING_SITE && HOSTING_PROJECT);

function isPaid(uid) {
  if (!uid) return false;
  return PAID_OPEN || PAID_UIDS.has(uid);
}

// A public hostname the customer can actually own. Rejects protocols, paths,
// ports, wildcards, and the *.web.app / *.firebaseapp.com reserved zones (those
// are never customer-owned custom domains). Lowercased, IDNA left to the caller
// of the browser — we only accept a-z0-9.- LDH labels here.
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
function normalizeHost(input) {
  let h = String(input == null ? '' : input).trim().toLowerCase();
  if (!h) return null;
  if (h.includes('://')) h = h.split('://')[1] || '';
  h = h.split('/')[0].split(':')[0].replace(/\.$/, '');
  if (h.startsWith('*.')) return null; // no wildcard custom domains
  if (!HOST_RE.test(h)) return null;
  if (/\.(web\.app|firebaseapp\.com)$/.test(h)) return null; // reserved Firebase zones
  if (h.length > 253) return null;
  return h;
}

// The customDomainId path segment is the host itself; keep the parent path
// entirely from server-side config so no caller input shapes the resource path
// beyond the validated host.
function sitePath() {
  return `projects/${HOSTING_PROJECT}/sites/${HOSTING_SITE}`;
}

// --- low-level REST (fetchImpl / tokenImpl injectable for tests) --------------
async function hostingFetch(method, url, body, opts) {
  opts = opts || {};
  const f = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('no fetch available');
  const token = await (opts.tokenImpl || getAccessToken)();
  const init = {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await f(url, init);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!r.ok) {
    const msg = (json && json.error && json.error.message) || ('HTTP ' + r.status);
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return json;
}

// Initiate an attach. Idempotent-ish: if the domain already exists (409/ALREADY_EXISTS)
// we fall through to a get() so a re-click just resumes polling instead of erroring.
async function attachCustomDomain(host, opts) {
  if (!ENABLED) throw new Error('Custom domains are not configured on this deployment.');
  const url = `${API_ROOT}/${sitePath()}/customDomains?customDomainId=${encodeURIComponent(host)}`;
  let res;
  try {
    // Body is empty on create — every state field is read-only and server-set.
    res = await hostingFetch('POST', url, {}, opts);
  } catch (e) {
    if (e.status === 409) return getCustomDomain(host, opts);
    throw e;
  }
  // create MAY return either the CustomDomain resource directly or a
  // long-running Operation wrapping it under `response`. summarize() below
  // tolerates both; if neither is populated yet, fall back to an immediate get.
  const summary = summarize(res, host);
  if (summary.hostState === 'UNKNOWN' && summary.ownershipState === 'UNKNOWN') {
    try { return await getCustomDomain(host, opts); } catch { /* return the create summary */ }
  }
  return summary;
}

async function getCustomDomain(host, opts) {
  if (!ENABLED) throw new Error('Custom domains are not configured on this deployment.');
  const url = `${API_ROOT}/${sitePath()}/customDomains/${encodeURIComponent(host)}`;
  const res = await hostingFetch('GET', url, undefined, opts);
  return summarize(res, host);
}

// --- resource → board-friendly summary ----------------------------------------
// Unwrap an Operation envelope if present; otherwise use the resource as-is.
function unwrap(res) {
  if (res && res.response && (res.response.hostState || res.response.name || res.response.cert)) {
    return res.response;
  }
  return res || {};
}

// Overall connect status the board renders as one badge. Order matters: an
// error/conflict beats "still verifying" beats "live".
function overallStatus(cd) {
  const host = cd.hostState || 'UNKNOWN';
  const own = cd.ownershipState || 'UNKNOWN';
  const cert = (cd.cert && cd.cert.state) || 'UNKNOWN';
  if (host === 'HOST_CONFLICT' || own === 'OWNERSHIP_CONFLICT' ||
      host === 'HOST_MISMATCH' || own === 'OWNERSHIP_MISMATCH') return 'conflict';
  if (host === 'HOST_ACTIVE' && cert === 'CERT_ACTIVE') return 'live';
  if (own === 'OWNERSHIP_ACTIVE' && host === 'HOST_ACTIVE') return 'securing'; // domain live, TLS finishing
  if (own === 'OWNERSHIP_PENDING' || host === 'HOST_UNREACHABLE' ||
      own === 'OWNERSHIP_UNREACHABLE' || own === 'OWNERSHIP_MISSING' ||
      host === 'HOST_UNHOSTED') return 'pending';
  return 'pending';
}

// Flatten requiredDnsUpdates.desired[].records[] into the copy-paste list the
// guided-DNS UI shows. Only records the user still needs to ADD (or that carry
// no explicit action) are surfaced as "add these"; REMOVE records are listed
// separately so the guidance is honest about conflicting existing records.
function dnsRecords(cd) {
  const add = [];
  const remove = [];
  const du = cd.requiredDnsUpdates || {};
  for (const set of (du.desired || [])) {
    const domainName = set.domainName || cd.name || '';
    for (const rec of (set.records || [])) {
      const row = {
        domainName: rec.domainName || domainName,
        type: rec.type || '',
        // discovery field is `rdata` on DnsRecord
        value: rec.rdata || rec.rrdata || '',
        action: rec.requiredAction || 'ADD'
      };
      if (row.action === 'REMOVE') remove.push(row);
      else add.push(row); // ADD or NONE — surface as "should be present"
    }
  }
  return { add, remove, checkTime: du.checkTime || null };
}

function summarize(raw, host) {
  const cd = unwrap(raw);
  const hostState = cd.hostState || 'UNKNOWN';
  const ownershipState = cd.ownershipState || 'UNKNOWN';
  const certState = (cd.cert && cd.cert.state) || 'UNKNOWN';
  return {
    host: host || (cd.name ? String(cd.name).split('/').pop() : ''),
    hostState,
    ownershipState,
    certState,
    status: overallStatus(cd),
    reconciling: !!cd.reconciling,
    dns: dnsRecords(cd),
    // pass a trimmed set of any blocking issues (message only — never internals)
    issues: Array.isArray(cd.issues)
      ? cd.issues.map(i => String((i && i.message) || '')).filter(Boolean).slice(0, 5)
      : [],
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  ENABLED, HOSTING_SITE, HOSTING_PROJECT,
  isPaid, normalizeHost,
  attachCustomDomain, getCustomDomain,
  // exported for unit tests
  summarize, dnsRecords, overallStatus, normalizeHostRE: HOST_RE
};
