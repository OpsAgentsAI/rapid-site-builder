'use strict';
// Card EGVHefy0 — the builder's own sitemap.
//
// Measured 2026-10-17 04:5xZ: GET builder.opsagents.agency/sitemap.xml was a 404
// ("Cannot GET /sitemap.xml"), robots.txt named no sitemap, and Search Console
// showed 0 impressions for the host across Aug, Sep and Oct 1-14.
//
// SCOPE — the builder's OWN public pages, nothing else. Published customer
// sites live under /sites/{id}; they belong to the customer, and listing them
// here would make this host vouch for (and leak an index of) every tenant's
// site. sitemapXml() REFUSES such a path rather than filtering it, so a future
// edit that adds one fails loudly instead of shipping quietly.
//
// Not listed on purpose:
//   /admin  — carries <meta name="robots" content="noindex,nofollow">.
//   /board  — the signed-in ops console for a site the visitor already built;
//             it has no canonical and no content for a first-time visitor.

const CANONICAL_ORIGIN = 'https://builder.opsagents.agency';

// Paths served by explicit page routes in server.js that a first-time visitor
// can land on. Keep in sync with server.js § pages.
//
// List the FINAL URL, never one that redirects (card QL20pSu3). A page that is
// a directory with an index.html under web/ is served by Firebase Hosting, which
// 301s `/campfire` to `/campfire/` before Express sees the request, so the
// sitemap names `/campfire/`. Search Console reports a listed redirect as
// "Page with redirect". test/sitemap-host-gate.test.js pins this.
const SITEMAP_PAGES = Object.freeze(['/', '/campfire/']);

const FORBIDDEN_PREFIXES = Object.freeze(['/sites', '/api', '/admin', '/rp']);

// The path the forbidden-prefix guard judges: what a router would resolve, not the raw string.
// Drops a query or fragment, percent-decodes once (`/sites%2Fabc` is `/sites/abc`), collapses
// leading and repeated slashes (`//sites/abc`), and lower-cases. Returns null for a malformed
// percent-escape, which the guard treats as forbidden (fail closed).
function normalizePath(p) {
  let s = String(p);
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  try {
    s = decodeURIComponent(s);
  } catch {
    return null;
  }
  return `/${s.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`.toLowerCase();
}

function isForbiddenPath(p) {
  const norm = normalizePath(p);
  if (norm === null) return true;
  return FORBIDDEN_PREFIXES.some((pre) => norm === pre || norm.startsWith(`${pre}/`));
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the sitemap document.
 * @param {object} [opts]
 * @param {string} [opts.origin]  absolute https origin the URLs are written on
 * @param {string[]} [opts.pages] site-relative paths (each must start with '/')
 * @returns {string} sitemaps.org 0.9 urlset XML
 */
function sitemapXml(opts = {}) {
  const origin = String(opts.origin || CANONICAL_ORIGIN).replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(origin)) {
    throw new Error(`sitemap origin must be a bare https origin, got ${JSON.stringify(origin)}`);
  }
  const pages = opts.pages || SITEMAP_PAGES;
  const urls = pages.map((p) => {
    if (typeof p !== 'string' || !p.startsWith('/')) {
      throw new Error(`sitemap page must be a site-relative path, got ${JSON.stringify(p)}`);
    }
    if (isForbiddenPath(p)) {
      throw new Error(`sitemap must never list ${p} — only the builder's own public pages`);
    }
    return `  <url><loc>${xmlEscape(origin + p)}</loc></url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    ''
  ].join('\n');
}

module.exports = { CANONICAL_ORIGIN, SITEMAP_PAGES, FORBIDDEN_PREFIXES, isForbiddenPath, sitemapXml };
