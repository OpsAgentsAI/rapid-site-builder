'use strict';
/**
 * Decide whether a `deploy-realapp.yml` dispatch is allowed to proceed.
 * Card LEBxGF5d.
 *
 * ── THE GAP ─────────────────────────────────────────────────────────────────
 * `deploy-realapp.yml` is `workflow_dispatch`-only and deploys whatever ref it
 * is handed. Its own header already states the rule:
 *
 *     "this lives on the `real-app` branch + a SEPARATE URL and is NEVER
 *      deployed from `main`"
 *
 * Nothing enforced it. That is the sharper version of the card's finding: the
 * file does not merely lack a rule, it DECLARES one and leaves it to prose.
 *
 * Measured on the live refs before a line was written:
 *
 *     git rev-list --left-right --count origin/main...origin/real-app  ->  40  14
 *     git merge-base --is-ancestor origin/main origin/real-app         ->  rc 1
 *
 * So `main` is not an ancestor of `real-app`: a prod dispatch handed `main`
 * rolls builder.opsagents.agency back past the ns341yIF cutover, both GA4
 * wirings and connect-your-domain — and reports success. Two of the last six
 * dispatches of this workflow did run on `main`.
 *
 * ── WHY THE EXIT CODE IS THE INPUT, NOT A BOOLEAN ───────────────────────────
 * `git merge-base --is-ancestor A B` has THREE outcomes, not two:
 *
 *     0    A is an ancestor of (or equal to) B      -> ALLOW
 *     1    A is definitively NOT an ancestor        -> REFUSE
 *     128  git could not answer (shallow clone,     -> CANNOT VERIFY
 *          unknown ref, corrupt repo, no fetch)
 *
 * Collapsing 128 into "refuse" is SAFE and still wrong, and it is wrong in the
 * cry-wolf direction: `actions/checkout` defaults to `fetch-depth: 1`, so on a
 * shallow clone EVERY dispatch — including a correct one on `real-app` — would
 * be refused with "not an ancestor". The operator's next move under that red is
 * to weaken or delete the guard, because the message accuses a ref that is
 * actually fine. A distinct `cannot-verify` verdict is what makes the real
 * remedy (`fetch-depth: 0`) the obvious one.
 *
 * Collapsing 128 into "allow" is the failure this card exists to prevent, one
 * level up: *"could not measure" is not a pass.*
 *
 * ── WHY EQUALITY COUNTS AS AN ANCESTOR ──────────────────────────────────────
 * `--is-ancestor X X` exits 0. The normal, correct dispatch — on `real-app`
 * itself — must pass, and it passes through the same branch as a legitimate
 * older commit on that line. A guard that demanded strict descent would refuse
 * the only ref anyone is supposed to use.
 */

/** The ONE ref this workflow may deploy from. Named once, read by both halves. */
const EXPECTED_REF = 'real-app';

/**
 * Turn the raw exit code of `git merge-base --is-ancestor <HEAD> <EXPECTED_REF>`
 * into a deploy verdict.
 *
 * @param {number|string} exitCode raw exit status from git
 * @param {{dispatchedRef?: string}} [ctx] for the operator-facing message
 * @returns {{allow: boolean, verdict: 'allow'|'refuse'|'cannot-verify', message: string}}
 */
function refDeployVerdict(exitCode, ctx = {}) {
  const dispatched = String(ctx.dispatchedRef || '').trim() || '(unknown ref)';
  // Number('') is 0 and Number(null) is 0 — either would read as ALLOW, which is
  // the one verdict a missing input must never produce. Absent/blank is
  // cannot-verify, deliberately, and a test pins each of those inputs.
  const raw = exitCode;
  const code =
    raw === null || raw === undefined || raw === '' || typeof raw === 'boolean'
      ? NaN
      : Number(raw);

  if (code === 0) {
    return {
      allow: true,
      verdict: 'allow',
      message: `ref check OK: ${dispatched} is an ancestor of (or equal to) ${EXPECTED_REF}.`,
    };
  }
  if (code === 1) {
    return {
      allow: false,
      verdict: 'refuse',
      message:
        `REFUSED: ${dispatched} is not an ancestor of ${EXPECTED_REF}. ` +
        `This workflow deploys PROD (rapid-builder-app / builder.opsagents.agency) and may only ` +
        `run from ${EXPECTED_REF}. Re-dispatch with ref "${EXPECTED_REF}".`,
    };
  }
  // Everything else — 128, a negative code, a non-numeric, an absent value.
  return {
    allow: false,
    verdict: 'cannot-verify',
    message:
      `CANNOT VERIFY the dispatched ref against ${EXPECTED_REF} (git exit ${String(raw)}). ` +
      `Aborting rather than deploying: "could not measure" is not a pass. ` +
      `Most likely cause is a shallow clone — actions/checkout needs fetch-depth: 0 ` +
      `so ${EXPECTED_REF} and the full history are present.`,
  };
}

module.exports = { EXPECTED_REF, refDeployVerdict };
