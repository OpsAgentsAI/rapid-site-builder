'use strict';
// Where newly minted PUBLIC media URLs point (card 7KlXAiW0).
//
// By default, objects on the public image bucket are linked directly
// (https://storage.googleapis.com/<bucket>/<object>). A direct GCS object URL
// can NEVER carry a real `X-Content-Type-Options: nosniff` RESPONSE header —
// custom object metadata only surfaces as `x-goog-meta-*`, which browsers
// ignore. When the operator fronts the bucket with the external HTTPS LB +
// Cloud CDN layer (scripts/setup_media_cdn.sh, runbook
// docs/RUNBOOKS/public-media-nosniff.md), PUBLIC_MEDIA_BASE_URL points at that
// layer (e.g. https://media.example.com) and every NEW public media URL is
// minted through it, picking up the real nosniff header the LB injects.
// Unset/empty → prior direct-URL behavior; the feature is fully off.
//
// Env:
//   PUBLIC_MEDIA_BASE_URL   https origin of the fronting layer (optional)
//
// https-origin-only: anything else (http, a value with a path, garbage) is
// IGNORED rather than half-applied — a misconfigured base must fail back to
// the known-good direct URLs, never mint mixed-content or broken links into
// published pages. The LB serves the bucket at its root (backend bucket), so
// the object path is identical in both forms; only the authority changes.
const RAW = String(process.env.PUBLIC_MEDIA_BASE_URL || '').trim().replace(/\/+$/, '');
const PUBLIC_MEDIA_BASE_URL = /^https:\/\/[^/\s]+$/.test(RAW) ? RAW : '';

function publicObjectUrl(bucket, objectName) {
  return PUBLIC_MEDIA_BASE_URL
    ? `${PUBLIC_MEDIA_BASE_URL}/${objectName}`
    : `https://storage.googleapis.com/${bucket}/${objectName}`;
}

module.exports = { PUBLIC_MEDIA_BASE_URL, publicObjectUrl };
