'use strict';
// Server-side PostHog product analytics + error tracking (card u4xmePAo).
//
// A thin, ALWAYS-SAFE wrapper around posthog-node. When POSTHOG_KEY is unset
// (a judge cloning the public repo, or local dev) this is a complete no-op:
// no client is constructed and every method silently does nothing. So analytics
// NEVER throws and NEVER blocks the build flow — the site is the product.
//
// Config (env, read at deploy time — values are operator-bound, never committed):
//   POSTHOG_KEY   the PROJECT api key (phc_… — a project key, NOT a personal
//                 phx_ key) for an OpsAgents/our-products PostHog project.
//   POSTHOG_HOST  ingest host (default https://us.i.posthog.com). This is the
//                 UPSTREAM the /rp reverse-proxy forwards to (see server.js).
//
// The browser sends its events to a same-origin opaque path (/rp) that this
// service reverse-proxies to POSTHOG_HOST for ad-blocker survival; server-side
// events below go straight to POSTHOG_HOST via posthog-node.

let PostHog = null;
try { ({ PostHog } = require('posthog-node')); } catch { /* dep absent → stay a no-op */ }

const POSTHOG_KEY = process.env.POSTHOG_KEY || '';
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const ENABLED = !!(POSTHOG_KEY && PostHog);

// One shared client per process. flushAt:1 keeps latency-insensitive server
// events flushing promptly; posthog-node batches + retries internally.
let _client = null;
function client() {
  if (!ENABLED) return null;
  if (!_client) {
    _client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 3000
    });
  }
  return _client;
}

// capture(distinctId, event, properties) — a no-op when disabled. distinctId is
// an anonymous per-build id (never PII); PostHog groups the funnel by it.
function capture(distinctId, event, properties) {
  const c = client();
  if (!c) return;
  try {
    c.capture({ distinctId: String(distinctId || 'anon'), event, properties: properties || {} });
  } catch { /* analytics must never break a request */ }
}

// captureException(error, distinctId, extra) — server-side error tracking on the
// Express API routes. posthog-node exposes captureException; guard for older/absent.
function captureException(error, distinctId, extra) {
  const c = client();
  if (!c) return;
  try {
    if (typeof c.captureException === 'function') {
      c.captureException(error, distinctId ? String(distinctId) : undefined, extra || {});
    } else {
      // Fallback path for a client without the helper: emit a plain event so the
      // error is still visible in PostHog rather than lost.
      c.capture({
        distinctId: String(distinctId || 'server'),
        event: '$exception',
        properties: {
          $exception_message: String((error && error.message) || error).slice(0, 500),
          $exception_type: (error && error.name) || 'Error',
          ...(extra || {})
        }
      });
    }
  } catch { /* never throw from the error path */ }
}

// $ai_generation — LLM-analytics event for one Agent Engine generation/phase,
// emitted SERVER-SIDE. traceId groups a whole build run (derive it from the
// existing session/run id — we make NO extra Agent Engine calls for this).
function captureAiGeneration(distinctId, traceId, properties) {
  const c = client();
  if (!c) return;
  try {
    c.capture({
      distinctId: String(distinctId || 'anon'),
      event: '$ai_generation',
      properties: {
        $ai_trace_id: String(traceId || ''),
        $ai_provider: 'vertex',
        ...(properties || {})
      }
    });
  } catch { /* never throw */ }
}

// Flush + release on serverless/exit paths so events survive the Cloud Run
// instance freezing (a container that freezes mid-batch drops un-flushed events).
async function shutdown() {
  if (!_client) return;
  try { await _client.shutdown(); } catch { /* best-effort flush */ }
  _client = null;
}

module.exports = {
  ENABLED, POSTHOG_HOST,
  capture, captureException, captureAiGeneration, shutdown
};
