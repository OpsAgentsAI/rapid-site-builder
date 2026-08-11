'use strict';
// "Bring my own website" — import an existing site's homepage and turn it into
// intake-brief suggestions (card OWIBIIsu). The visitor pastes the address of
// the site they already have; we fetch it SERVER-SIDE, extract business-name /
// description / language signals, and hand back a pre-filled brief. The human
// still reviews the form and clicks Build — the crew and the renderer never see
// the client-supplied URL or raw HTML, only the short extracted strings this
// module returns (same posture as lib/uploads.js: nothing client-shaped crosses
// into the build path).
//
// SSRF is the whole threat model here (an attacker-controlled URL fetched from
// inside Cloud Run), so the fetcher is deliberately strict:
//   • http/https only, no userinfo, default ports only (80/443)
//   • the hostname is DNS-resolved first and EVERY resolved address must be
//     public — loopback, RFC1918, link-local (169.254.* = GCP metadata), CGNAT,
//     ULA/IPv6-mapped ranges are all rejected
//   • redirects are followed manually (≤ MAX_REDIRECTS) and every hop repeats
//     the full scheme+DNS validation — a public host 302ing to
//     http://169.254.169.254/ dies on the hop, not after
//   • text/html only, response body capped (MAX_BYTES) and time-boxed
// fetch/DNS are injectable so the unit tests exercise all of this offline.

const dns = require('dns');

const MAX_REDIRECTS = 3;
const MAX_BYTES = 1.5 * 1024 * 1024; // homepage HTML cap
const TIMEOUT_MS = 8000;

// ---- address screening -----------------------------------------------------------

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

const V4_BLOCKED = [
  ['0.0.0.0', 8],       // "this network"
  ['10.0.0.0', 8],      // RFC1918
  ['100.64.0.0', 10],   // CGNAT
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local — includes the GCP metadata server
  ['172.16.0.0', 12],   // RFC1918
  ['192.0.0.0', 24],    // IETF protocol assignments
  ['192.168.0.0', 16],  // RFC1918
  ['198.18.0.0', 15],   // benchmarking
  ['224.0.0.0', 3]      // multicast + reserved + broadcast
].map(([base, bits]) => [ipv4ToInt(base), bits]);

function isPrivateV4(ip) {
  const n = ipv4ToInt(ip);
  if (n == null) return true; // unparseable → treat as unsafe
  return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
}

// Private/unsafe check for anything dns.lookup can return. IPv6 coverage is
// prefix-based: loopback, unspecified, link-local fe80::/10, ULA fc00::/7,
// and IPv4-mapped addresses (screened as their embedded IPv4).
function isPrivateIp(addr) {
  const ip = String(addr || '').trim().toLowerCase();
  if (!ip) return true;
  if (ip.includes(':')) {
    if (ip === '::' || ip === '::1') return true;
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateV4(mapped[1]);
    if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local
    if (/^f[cd]/.test(ip)) return true;    // fc00::/7 ULA
    return false;
  }
  return isPrivateV4(ip);
}

// Validate one URL hop: scheme, shape, then DNS. Returns { url } or { error }.
// `lookup` is dns.promises.lookup-shaped (injectable for tests).
async function checkHop(rawUrl, lookup) {
  let u;
  try {
    u = new URL(String(rawUrl || '').trim());
  } catch {
    return { error: 'That does not look like a web address.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { error: 'Only http(s) addresses are supported.' };
  }
  if (u.username || u.password) return { error: 'That address is not supported.' };
  if (u.port && u.port !== '80' && u.port !== '443') {
    return { error: 'That address is not supported.' };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // Literal IPs skip DNS but get the same screen.
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) return { error: 'That address is not reachable from here.' };
    return { url: u };
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    return { error: 'We could not find that website — check the address?' };
  }
  if (!Array.isArray(addrs) || addrs.length === 0) {
    return { error: 'We could not find that website — check the address?' };
  }
  if (addrs.some(a => isPrivateIp(a.address))) {
    return { error: 'That address is not reachable from here.' };
  }
  return { url: u };
}

// ---- extraction ------------------------------------------------------------------

const HEBREW_RE = /[֐-׿]/;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    });
}

function clean(s, max) {
  return decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

function metaContent(html, attr, value) {
  // <meta name="description" content="..."> in either attribute order.
  const re = new RegExp(
    `<meta\\s+[^>]*${attr}\\s*=\\s*["']${value}["'][^>]*>`, 'i');
  const m = html.match(re);
  if (!m) return '';
  const c = m[0].match(/content\s*=\s*["']([^"']*)["']/i);
  return c ? c[1] : '';
}

// Business names arrive as "Cafe Luna | Best coffee in Tel Aviv — Home".
// Keep the leading brand segment, drop the marketing tail.
function brandFrom(title) {
  const first = String(title || '').split(/\s*[|–—·«»]\s*|\s+-\s+/)[0];
  return clean(first, 120);
}

// Pull the brief-shaped signals out of homepage HTML. Pure + exported for tests.
function extractBrief(html) {
  const doc = String(html || '');
  const title = clean((doc.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1], 200);
  const ogSiteName = clean(metaContent(doc, 'property', 'og:site_name'), 120);
  const metaDesc = clean(metaContent(doc, 'name', 'description'), 400);
  const ogDesc = clean(metaContent(doc, 'property', 'og:description'), 400);
  const h1 = clean((doc.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]
    ?.replace(/<[^>]+>/g, ' '), 200);

  // Visible-text sample for category inference: strip scripts/styles/tags,
  // keep the first ~600 chars of real words.
  const textSample = clean(
    doc
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
    600);

  const htmlLang = (doc.match(/<html[^>]*\blang\s*=\s*["']?([a-zA-Z-]+)/i) || [])[1] || '';
  const probe = [title, metaDesc, h1].join(' ');
  const lang = /^he/i.test(htmlLang) || HEBREW_RE.test(probe) ? 'he' : 'en';

  const business = ogSiteName || brandFrom(title) || brandFrom(h1);
  const description = clean(metaDesc || ogDesc || h1, 400);
  return { business, description, lang, textSample };
}

// ---- fetch + orchestrate ---------------------------------------------------------

// Fetch the homepage with per-hop SSRF screening. Options are injectable:
//   fetchImpl — global fetch shape; lookup — dns.promises.lookup shape.
// Resolves { ok:true, brief:{business,description,lang,textSample}, sourceHost }
// or { ok:false, error, status } (status = suggested HTTP status).
async function importFromUrl(rawUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const lookup = opts.lookup || dns.promises.lookup;
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;

  let hop = String(rawUrl || '').trim();
  if (hop && !/^https?:\/\//i.test(hop)) hop = 'https://' + hop; // bare "cafeluna.co.il"
  let sourceHost = '';

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const checked = await checkHop(hop, lookup);
    if (checked.error) return { ok: false, error: checked.error, status: 400 };
    const u = checked.url;
    if (!sourceHost) sourceHost = u.hostname;

    let resp;
    try {
      resp = await fetchImpl(u.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'RapidSiteBuilder-Import/1.0 (+https://builder.opsagents.agency)', Accept: 'text/html' }
      });
    } catch {
      return { ok: false, error: 'We could not reach that website right now.', status: 422 };
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc || i === MAX_REDIRECTS) {
        return { ok: false, error: 'That website redirected too many times.', status: 422 };
      }
      hop = new URL(loc, u).toString(); // next loop iteration re-validates the hop
      continue;
    }
    if (!resp.ok) {
      return { ok: false, error: 'That website answered with an error (' + resp.status + ').', status: 422 };
    }
    const ct = String(resp.headers.get('content-type') || '');
    if (!ct.toLowerCase().includes('text/html')) {
      return { ok: false, error: 'That address is not a web page we can read.', status: 422 };
    }
    const len = Number(resp.headers.get('content-length') || 0);
    if (len > maxBytes) {
      return { ok: false, error: 'That page is too large to import.', status: 422 };
    }
    let buf;
    try {
      buf = Buffer.from(await resp.arrayBuffer());
    } catch {
      return { ok: false, error: 'We could not read that page.', status: 422 };
    }
    // Chunked responses carry no content-length — enforce the cap on the body
    // itself; a page that big is not a homepage we should be parsing anyway.
    if (buf.length > maxBytes) {
      return { ok: false, error: 'That page is too large to import.', status: 422 };
    }
    const brief = extractBrief(buf.toString('utf8'));
    if (!brief.business && !brief.description) {
      return { ok: false, error: 'We could not find business details on that page — fill the form and the team takes it from there.', status: 422 };
    }
    return { ok: true, brief, sourceHost };
  }
  return { ok: false, error: 'That website redirected too many times.', status: 422 };
}

module.exports = { importFromUrl, extractBrief, isPrivateIp, checkHop, MAX_REDIRECTS, MAX_BYTES };
