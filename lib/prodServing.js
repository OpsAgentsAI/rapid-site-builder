'use strict';
/**
 * IS WHAT PRODUCTION SERVES DERIVED FROM `real-app`'s CURRENT HEAD?
 * Card 65pcQtze — GAP B, the gap the divergence alarm never measured.
 *
 * ── TWO GAPS, AND UNTIL THIS FILE ONLY ONE WAS MEASURED ─────────────────────
 * `.github/workflows/divergence-alarm.yml` is titled "merged work that cannot
 * reach PROD", but its predicate compares two git REFS:
 *
 *   GAP A  main -> real-app     "cannot reach the prod branch"   measured (lib/branchDivergence.js)
 *   GAP B  real-app -> PROD     "cannot reach what users get"    measured by NOTHING
 *
 * Measured 2026-09-15 (card 65pcQtze): real-app was 7 commits / 15 files ahead
 * of the last deployed head, and both prod hosts had served the same object,
 * unchanged, for 29 DAYS. The alarm was red the whole time — for gap A — so a
 * reader saw "red, already tracked" and gap B stayed invisible. A permanently-red
 * alarm that is red for a different reason is worse than no alarm.
 *
 * ── WHAT "DEPLOYED" MEANS HERE, AND WHY IT IS SOUND ─────────────────────────
 * `deploy-realapp.yml` is the ONLY path to the prod tier (it is dispatch-only
 * and ref-guarded to the real-app line). A SUCCESSFUL run of it has, in order:
 * deployed Cloud Run synchronously, promoted traffic, smoke-tested Cloud Run,
 * run `gcloud builds submit` for Hosting WITHOUT `--async` (so a failed build
 * fails the step), and smoke-tested Hosting. So the `head_sha` of the last
 * SUCCESSFUL run is what prod serves.
 * ⚠️ Stated blind spot: a deploy performed OUTSIDE that workflow (a hand-run
 * `gcloud run deploy`) is invisible to this. The card cross-checked the proxy
 * once (run finished 06:49Z; both hosts' last-modified 06:51:55Z) — agreement,
 * not proof.
 *
 * ── ONE DECISION, ONE SITE ──────────────────────────────────────────────────
 * "Which commits could change a served byte" is decided ONCE, in
 * lib/branchDivergence.js `isProductPath`. It is imported, not copied: a second
 * list would let gap A and gap B disagree about what counts, and a CI-only
 * commit sitting undeployed must not make this red — that is the exact
 * cry-wolf the divergence lib's header was written against.
 *
 * ── FOUR STATES, AND "COULD NOT MEASURE" IS NEVER CURRENT ───────────────────
 *   CURRENT        prod serves real-app's head, or nothing undeployed is product
 *   WITHIN_BUDGET  product work is undeployed, but for less than the budget
 *   STALE          product work has waited longer than the budget      -> RED
 *   UNKNOWN        any input missing or impossible                     -> RED
 * UNKNOWN is red on purpose: "I could not read the deploy history" must never
 * render as "prod is current".
 */

const { isProductPath } = require('./branchDivergence');

/**
 * ⚠️ A PROPOSED DEFAULT, NOT A DECIDED ONE (card 65pcQtze AC-5).
 * The card's point is that 29 days was nobody's decision. This number is a
 * starting proposal, chosen so the measured 29-day gap reds while a normal
 * release cadence does not. It is overridable (`--budget-days`) so an owner's
 * decision is an argument at the call site, not an edit here — and every
 * verdict reports the ACTUAL age, so the number never hides the measurement.
 */
const DEFAULT_BUDGET_DAYS = 7;

const DAY_MS = 86_400_000;

const EXIT = Object.freeze({ CURRENT: 0, WITHIN_BUDGET: 0, STALE: 1, UNKNOWN: 2 });

/** Exit code for a status. Unknown statuses are treated as UNKNOWN, never as a pass. */
function exitCodeFor(status) {
  return Object.prototype.hasOwnProperty.call(EXIT, status) ? EXIT[status] : EXIT.UNKNOWN;
}

/**
 * @param {object} m
 * @param {string|null} m.deployedSha   head_sha of the last SUCCESSFUL deploy-realapp run
 * @param {string|null} m.headSha       current tip of real-app
 * @param {Array|null}  m.undeployed    commits in deployedSha..headSha: [{sha, dateISO, files: [path]}]
 * @param {string}      m.nowISO
 * @param {number}      [m.budgetDays]
 */
function classifyProdServing(m) {
  const { deployedSha, headSha, undeployed, nowISO, budgetDays = DEFAULT_BUDGET_DAYS } = m || {};
  const unknown = (reason) => ({ status: 'UNKNOWN', reason, productCommits: [], ageDays: null, budgetDays });

  if (!deployedSha) return unknown('no successful deploy-realapp run was found — the deployed head is unmeasured');
  if (!headSha) return unknown('real-app did not resolve — the target head is unmeasured');
  const now = Date.parse(String(nowISO ?? ''));
  if (Number.isNaN(now)) return unknown('no valid "now" — age cannot be computed');
  if (!(typeof budgetDays === 'number' && budgetDays > 0)) return unknown(`budgetDays must be a positive number, got ${budgetDays}`);

  if (deployedSha === headSha) {
    return { status: 'CURRENT', reason: 'prod serves real-app\'s current head', productCommits: [], ageDays: 0, budgetDays };
  }

  // Two DIFFERENT tips with an empty or unreadable commit list is impossible —
  // the same positive control lib/branchDivergence.js applies to gap A.
  if (!Array.isArray(undeployed) || undeployed.length === 0) {
    return unknown(
      `deployed ${deployedSha.slice(0, 8)} and real-app ${headSha.slice(0, 8)} differ, yet no undeployed ` +
        'commits were read — the instrument is not seeing history, so this cannot be "current"',
    );
  }

  const productCommits = undeployed.filter(
    (c) => Array.isArray(c?.files) && c.files.some((f) => isProductPath(f)),
  );
  if (productCommits.length === 0) {
    return {
      status: 'CURRENT',
      reason: `${undeployed.length} undeployed commit(s), none of which can change a served byte`,
      productCommits,
      ageDays: 0,
      budgetDays,
    };
  }

  const dates = productCommits.map((c) => Date.parse(String(c?.dateISO ?? '')));
  if (dates.some((d) => Number.isNaN(d))) return unknown('an undeployed product commit carries no readable date');
  const ageDays = Math.floor((now - Math.min(...dates)) / DAY_MS);

  if (ageDays > budgetDays) {
    return {
      status: 'STALE',
      reason:
        `${productCommits.length} product commit(s) on real-app have NOT reached prod; the oldest has ` +
        `waited ${ageDays} day(s), past the ${budgetDays}-day budget`,
      productCommits,
      ageDays,
      budgetDays,
    };
  }
  return {
    status: 'WITHIN_BUDGET',
    reason: `${productCommits.length} product commit(s) undeployed for ${ageDays} day(s), within the ${budgetDays}-day budget`,
    productCommits,
    ageDays,
    budgetDays,
  };
}

module.exports = { DEFAULT_BUDGET_DAYS, EXIT, exitCodeFor, classifyProdServing };
