'use strict';
// ── Is the CANONICAL product still un-retired? (card sMdKZ7pQ) ────────────────
//
// deploy.yml already asserts, after every deploy, that the two retired hackathon
// hosts STAY retired: /api/build 410, / 301 → CANONICAL_APP_URL. That is one
// direction. Nothing anywhere asserts the OTHER one — that the place all those
// redirects point at, and the URL every client demo deck now closes with, is
// alive and NOT itself retired.
//
// The failure that closes: RETIRE_UNGATED=1 is a single token inside a
// fifteen-key single-line --set-env-vars in deploy.yml, and rule #20 forces that
// whole line to be rewritten on every deploy. deploy-realapp.yml carries the
// same shape of line for the canonical service. One copy-paste between them and
// builder.opsagents.agency starts 410-ing its own /api/build and 301-ing / to
// CANONICAL_APP_URL — which for the canonical service is ITSELF. An infinite
// redirect on the URL in every deck.
//
// ⚠️ AND EVERY EXISTING SIGNAL STAYS GREEN THROUGH THAT.  The retirement
// middleware in server.js deliberately exempts monitoring:
//     "Everything else keeps serving: … /api/health + /healthz (monitoring)"
// and /api/health is the ONLY thing deploy-realapp.yml asserts after its deploy
// (`"agentEngine":true`, `"auth":true`, then a bare `curl -sf …/api/health`).
// So the one endpoint the pipeline watches is the one endpoint the retirement is
// written to leave alone. That is why health is accepted here as CONTEXT and is
// structurally incapable of producing a pass — see healthIsContextOnly below.

const RETIRED_STATUS = 410;

/** Origin of a URL, or null. Compared as an ORIGIN so a trailing slash, a
 *  query, or a path cannot make a self-redirect look like a real one. */
function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/**
 * Verdict over already-collected probe results. Pure on purpose: the state this
 * guards is the HEALTHY one, so a check whose only evidence is the live tree it
 * happens to run against can never be shown to fail on demand.
 *
 * probes: [{ origin, path, method, status, location? }]
 * expectedOrigins: the origins that MUST be covered — declared, never derived
 *   from the probes (derived, a run that probed nothing covers everything).
 */
function canonicalFindings({ expectedOrigins, probes, minProbes = 2 }) {
  const findings = [];
  const origins = Array.isArray(expectedOrigins) ? expectedOrigins.filter(Boolean) : [];
  const rows = Array.isArray(probes) ? probes : [];

  // ── R0 vacuity floor ───────────────────────────────────────────────────────
  // "no findings" is the same output when the surface is healthy and when the
  // scan never ran, the host list was emptied, or curl returned nothing. Those
  // must not share a verdict. Short-circuits so a broken scan does not also
  // emit C-rule noise a reader would go and chase.
  if (origins.length === 0) {
    return { broken: true, findings: ['SCAN LOOKS BROKEN, NOT CLEAN: no canonical origin was declared'] };
  }
  if (rows.length < minProbes) {
    return { broken: true, findings: [`SCAN LOOKS BROKEN, NOT CLEAN: ${rows.length} probe(s), expected at least ${minProbes}`] };
  }
  for (const r of rows) {
    if (!Number.isInteger(r.status)) {
      return { broken: true, findings: [`SCAN LOOKS BROKEN, NOT CLEAN: ${r.method || 'GET'} ${r.origin}${r.path} produced no status code`] };
    }
  }

  for (const origin of origins) {
    const mine = rows.filter((r) => r.origin === origin);
    // C3 — every declared origin must actually have been probed. Without this,
    // dropping builder.opsagents.agency from the target list (leaving only the
    // *.web.app host) silently stops checking the URL the decks link.
    if (mine.length === 0) {
      findings.push(`${origin} is declared canonical but was never probed — the deck URL is unchecked`);
      continue;
    }

    // C1 — the front door must serve, and must not redirect to itself. A
    // self-redirect is precisely what RETIRE_UNGATED does to the canonical
    // service, because its CANONICAL_APP_URL is its own address.
    const root = mine.find((r) => r.path === '/');
    if (root) {
      if (root.status >= 300 && root.status < 400 && originOf(root.location) === origin) {
        findings.push(
          `${origin}/ answered ${root.status} redirecting to itself (${root.location}) — ` +
          `RETIRE_UNGATED is set on the CANONICAL service. Every demo deck links this URL.`
        );
      } else if (root.status !== 200) {
        findings.push(`${origin}/ answered ${root.status}, expected 200 — the product every deck links is not serving`);
      }
    }

    // C2 — the engine endpoint must not be GONE. Only 410 means retired: any
    // other status proves the request reached the app, and demanding a specific
    // one (400) would red the day someone changes brief validation. That is the
    // cry-wolf direction and it is the one nobody tests.
    const build = mine.find((r) => r.path === '/api/build');
    if (build && build.status === RETIRED_STATUS) {
      findings.push(
        `${origin}/api/build answered 410 Gone — the canonical engine is RETIRED. ` +
        `The decks state "type a brief and watch it built, in the meeting"; it cannot.`
      );
    }
  }
  return { broken: false, findings };
}

/**
 * Health is echoed so a reader can see it was known and deliberately not used.
 * It is a separate function returning a STRING because a verdict input is a
 * value the caller can act on, and this one must never be that. /api/health is
 * exempt from the retirement middleware by design — it is green in exactly the
 * state this module exists to catch.
 */
function healthIsContextOnly(healthByOrigin) {
  return Object.entries(healthByOrigin || {})
    .map(([o, h]) => `context (NOT a verdict input): ${o}/api/health -> ${h}`)
    .join('\n');
}

module.exports = { canonicalFindings, healthIsContextOnly, originOf, RETIRED_STATUS };
