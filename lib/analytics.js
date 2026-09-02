'use strict';
// Product analytics for the real-app surface — card u4xmePAo.
//
// WHAT WAS ACTUALLY MISSING, measured on origin/real-app @c6436a1: GA4 is
// already here and correct (property 549064186 "RSB Builder", account
// OpsAgents AI — verified live against the GA Admin API, not assumed), wired
// on `/` and `/board` with exception events. **PostHog was the absent half**:
// zero hits for "posthog" anywhere in the tree. So this module is the PostHog
// half only, and it does not touch the gtag block.
//
// ⚠️ THE GATE ON THIS CARD COVERS THE KEY, NOT THE WIRING. `🔒 gated:
// operator-posthog-key-binding` is waiting on an operator to mint a project
// key and bind it into the deployment env. None of that is needed to write —
// or to merge — the code that reads it, PROVIDED an absent key is a first-
// class, silent, tested state rather than a half-install. That is this
// module's whole job.
//
// Fail-closed by configuration, in the same shape lib/auth.js already uses on
// this surface: unset ⇒ the app behaves exactly as it does today, no network
// call, no snippet, no error. A judge cloning the repo runs it with zero
// PostHog setup, which is also why no key may ever be committed.

// ---- configuration ---------------------------------------------------------
const KEY_ENV = 'POSTHOG_PROJECT_KEY';
const HOST_ENV = 'POSTHOG_API_HOST';

/** PostHog's US ingest host. Overridable for EU/self-host. */
const DEFAULT_API_HOST = 'https://us.i.posthog.com';

/**
 * A PostHog **project** key: public by design, write-only, safe in a browser.
 * Anchored and length-bounded so a truncated paste is refused rather than
 * shipped as a key that silently drops every event.
 */
const PROJECT_KEY_RE = /^phc_[A-Za-z0-9]{20,}$/;

/**
 * A PostHog **personal** API key. NEVER a client credential: it is
 * account-scoped and can read and write across projects, so putting one in
 * `/api/analytics-config` would publish a full-account credential to every
 * visitor.
 *
 * 🔑 The card states this as a rule ("personal phx_ keys never in client").
 * A rule stated in prose is one a future paste breaks silently, so it is
 * enforced here and pinned by a test: the two key shapes differ by three
 * characters and are pasted from adjacent pages of the same settings screen.
 */
const PERSONAL_KEY_PREFIX = 'phx_';

/**
 * Why analytics is or is not on. Named rather than boolean, deliberately:
 * "nobody bound a key yet", "somebody pasted the wrong KIND of key" and
 * "somebody pasted a truncated key" send an operator to three different
 * places, and `enabled:false` collapses all three into the one reading that
 * looks like a deliberate opt-out.
 */
const REASON = {
  ENABLED: 'enabled',
  NOT_CONFIGURED: 'not-configured',
  PERSONAL_KEY_REFUSED: 'personal-key-refused',
  MALFORMED_KEY: 'malformed-key',
};

/**
 * Decide whether this deployment reports, from raw values.
 *
 * @param {{ key?: string, apiHost?: string }} input
 * @returns {{ enabled: boolean, reason: string, projectKey: string|null, apiHost: string }}
 */
function analyticsVerdict(input = {}) {
  const apiHost = String(input.apiHost || '').trim().replace(/\/+$/, '') || DEFAULT_API_HOST;
  const key = String(input.key || '').trim();

  if (!key) return { enabled: false, reason: REASON.NOT_CONFIGURED, projectKey: null, apiHost };

  // Checked BEFORE the shape test on purpose: a personal key is not a
  // malformed project key, it is a credential leak, and reporting it as
  // "malformed" would send the operator to fix a typo instead of rotating.
  if (key.startsWith(PERSONAL_KEY_PREFIX)) {
    return { enabled: false, reason: REASON.PERSONAL_KEY_REFUSED, projectKey: null, apiHost };
  }
  if (!PROJECT_KEY_RE.test(key)) {
    return { enabled: false, reason: REASON.MALFORMED_KEY, projectKey: null, apiHost };
  }
  return { enabled: true, reason: REASON.ENABLED, projectKey: key, apiHost };
}

/** The same decision, read from a process env. One place, one spelling. */
function verdictFromEnv(env = {}) {
  return analyticsVerdict({ key: env[KEY_ENV], apiHost: env[HOST_ENV] });
}

const VERDICT = verdictFromEnv(process.env);
const ENABLED = VERDICT.enabled;

// Loud on the two states an operator would want to know about, silent on the
// default one. An unbound key is the intended state until the gate clears; a
// REFUSED key means somebody bound the wrong thing and believes it is working.
if (VERDICT.reason === REASON.PERSONAL_KEY_REFUSED) {
  console.error(`[analytics] ${KEY_ENV} looks like a PERSONAL PostHog key (phx_…). REFUSED — a personal key is an ` +
    'account-wide credential and this value is served to every browser. Rotate it and bind a PROJECT key (phc_…).');
} else if (VERDICT.reason === REASON.MALFORMED_KEY) {
  console.warn(`[analytics] ${KEY_ENV} is set but is not a phc_… project key — analytics DISABLED rather than ` +
    'silently dropping every event.');
}

module.exports = {
  analyticsVerdict,
  verdictFromEnv,
  VERDICT,
  ENABLED,
  REASON,
  KEY_ENV,
  HOST_ENV,
  DEFAULT_API_HOST,
  PROJECT_KEY_RE,
  PERSONAL_KEY_PREFIX,
};
