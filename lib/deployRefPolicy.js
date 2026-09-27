'use strict';
/**
 * WHICH REF EACH DISPATCHABLE DEPLOY WORKFLOW IS ALLOWED TO RUN FROM.
 * Card eKfog19I — the pattern behind card LEBxGF5d.
 *
 * ── THE PATTERN ─────────────────────────────────────────────────────────────
 * `workflow_dispatch` runs a workflow against whatever ref the operator picks
 * in the dropdown. Measured 2026-08-24 with comments stripped, ALL THREE of
 * this repo's deploy workflows accepted an arbitrary ref, and a wrong-ref run
 * reports SUCCESS on what is really a rollback:
 *
 *   deploy-realapp.yml  dispatch-only   PROD (builder.opsagents.agency)   <- PR #67
 *   deploy.yml          push:main + dispatch   RETIRED + APP-STAGING      <- here
 *   deploy-engine.yml   dispatch-only   mints a NEW Agent Engine          <- here
 *
 * PR #67 closed the first instance and left its decision in
 * lib/realappRefGuard.js. This file is that same decision with the ref it
 * compares against turned into an argument, plus the per-workflow policy. It is
 * deliberately ONE decision with three call sites and not three decisions: a
 * duplicate ancestry parser is how two guards eventually disagree about what
 * "on the line" means.
 *
 * ── WHY THE EXIT CODE IS THE INPUT, NOT A BOOLEAN ───────────────────────────
 * `git merge-base --is-ancestor A B` has THREE outcomes, not two:
 *
 *     0    A is an ancestor of (or equal to) B      -> ALLOW
 *     1    A is definitively NOT an ancestor        -> REFUSE
 *     128  git could not answer (shallow clone,     -> CANNOT VERIFY
 *          unknown ref, corrupt repo, no fetch)
 *
 * Collapsing 128 into "allow" is the failure these cards exist to prevent:
 * *"could not measure" is not a pass.* Collapsing it into "refuse" is SAFE and
 * still wrong, in the cry-wolf direction — `actions/checkout` defaults to
 * `fetch-depth: 1`, so on a shallow clone every dispatch, including a correct
 * one, is refused with "not an ancestor", and the fix a reader reaches for
 * under that red is to weaken the guard, because the message accuses a ref that
 * is fine. `cannot-verify` names the real remedy instead.
 *
 * Equality counts as ancestry on purpose: `--is-ancestor X X` exits 0, and the
 * normal correct dispatch is on the expected ref itself.
 *
 * ── ⚠️ THE HALF THIS FILE CANNOT REACH, STATED RATHER THAN GLOSSED ──────────
 * `workflow_dispatch` runs the workflow file **from the dispatched ref**. So a
 * guard only ever sees a dispatch whose ref carries it. That asymmetry lands
 * differently on each row and it is NOT the same story as PR #67's:
 *
 *   deploy-realapp.yml expects `real-app`, so its dangerous ref is `main` —
 *   and a dispatch on `main` runs MAIN's copy. Its guard is fully load-bearing.
 *
 *   deploy.yml and deploy-engine.yml expect `main`, so their dangerous ref is
 *   `real-app` — and a dispatch on `real-app` runs REAL-APP's copy, which has
 *   no guard until this lands there too. What the guard on `main` DOES cover is
 *   the common wrong-ref: any unmerged branch cut from `main` (a `card/*`
 *   branch tip is not an ancestor of `main`, so it is refused), because such a
 *   branch carries main's workflow. That is a real, frequent operator mistake —
 *   dispatching a deploy from unreviewed code — and it is caught here.
 *
 * The `real-app` half needs a forward-port. Card xe1q8uHa owns the branch
 * reconciliation; this file's job is to make sure the rule exists to port.
 */

/**
 * Per-workflow deploy-ref policy. The ONLY place any of these ref names is
 * written down: the workflows read `expectedRef` from here via `node -p`, and
 * test/deploy-ref-policy.test.js asserts they do rather than re-typing it.
 *
 * `why` is not decoration — it is what a reader needs in order to change a row
 * deliberately rather than because a deploy went red once.
 */
const DEPLOY_REF_POLICY = {
  'deploy-realapp.yml': {
    expectedRef: 'real-app',
    tier: 'PROD (rapid-builder-app / builder.opsagents.agency)',
    why:
      "The workflow's own header says it 'is NEVER deployed from main'. Measured: " +
      'main is not an ancestor of real-app, so a dispatch on main rolls prod back ' +
      'past the ns341yIF cutover, both GA4 wirings and connect-your-domain.',
  },
  'deploy.yml': {
    expectedRef: 'main',
    tier: 'the RETIRED hackathon surface + APP-STAGING (rapid-builder-proxy, rapid-builder-app-stg)',
    why:
      'Both tiers this workflow deploys are the main line — it is push:main triggered. ' +
      'A dispatch on real-app would push the auth-ON product onto the ungated retired ' +
      'surface and then update-traffic --to-latest, which is the inverse mistake to the ' +
      'PROD one and just as green.',
  },
  'deploy-engine.yml': {
    expectedRef: 'main',
    tier: 'a NEW Vertex AI Agent Engine (its printed RESOURCE_NAME is pinned into the app env)',
    why:
      'main owns the crew definition. Measured 2026-08-25: agents/ differs between the ' +
      'branches and real-app is BEHIND — its agent.py/tools.py are missing ~156 lines, ' +
      'including the Dana/Remy/Kai sub-agent split (main e79c7b7, 2026-08-07; real-app ' +
      'last touched agents/ on 2026-06-14, 308dae6 — RE-MEASURED 2026-09-08 for card ' +
      'OtEgCdjR; the previous note said 2026-07-20, so the gap is ~3 months, not ~6 ' +
      'weeks, and neither branch is an ancestor of the other). This workflow mints a ' +
      'FRESH engine every run ' +
      'rather than updating one, so a stale-ref dispatch does not merely deploy wrong: it ' +
      'hands a human an identifier that looks authoritative and gets pinned.',
  },
  'preview.yml': {
    expectedRef: 'main',
    tier: 'PR preview channels (opsagent-staging, gha-deployer)',
    why:
      "Card vpukxEgQ (09PBYCJY rule 2) moved this workflow's deploy off pull_request " +
      'onto workflow_dispatch, which makes it a member of this policy for the first ' +
      "time — it was correctly EXCLUDED before, on the same reasoning this file's own " +
      "test states: 'preview.yml deploys but fires on pull_request only, so no operator " +
      "picks its ref'. That is no longer true. This workflow_dispatch runs the file AS " +
      'IT EXISTS on the dispatched ref, so a dispatch on an unreviewed branch would run ' +
      "that branch's own copy of verify-pr — potentially a weakened one — regardless of " +
      "what the live PR's actual head looks like. main is where the reviewed verify-pr " +
      'logic lives; expect a dispatch from anywhere else.',
  },
};

/**
 * The ref `deploy-realapp.yml` may deploy from.
 * DERIVED from the policy above rather than re-declared, so the two cannot
 * drift. lib/realappRefGuard.js re-exports this for that workflow's call site.
 */
const EXPECTED_REF = DEPLOY_REF_POLICY['deploy-realapp.yml'].expectedRef;

/**
 * Turn the raw exit code of `git merge-base --is-ancestor <HEAD> <expectedRef>`
 * into a deploy verdict.
 *
 * @param {number|string} exitCode raw exit status from git
 * @param {{dispatchedRef?: string, expectedRef?: string, tier?: string}} [ctx]
 * @returns {{allow: boolean, verdict: 'allow'|'refuse'|'cannot-verify', message: string}}
 */
function refDeployVerdict(exitCode, ctx = {}) {
  const dispatched = String(ctx.dispatchedRef || '').trim() || '(unknown ref)';
  // Defaulting to the real-app policy keeps PR #67's call site and its tests
  // byte-identical in behaviour while this becomes the shared decision.
  const expected = String(ctx.expectedRef || '').trim() || EXPECTED_REF;
  const tier =
    String(ctx.tier || '').trim() || DEPLOY_REF_POLICY['deploy-realapp.yml'].tier;

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
      message: `ref check OK: ${dispatched} is an ancestor of (or equal to) ${expected}.`,
    };
  }
  if (code === 1) {
    return {
      allow: false,
      verdict: 'refuse',
      message:
        `REFUSED: ${dispatched} is not an ancestor of ${expected}. ` +
        `This workflow deploys ${tier} and may only ` +
        `run from ${expected}. Re-dispatch with ref "${expected}".`,
    };
  }
  // Everything else — 128, a negative code, a non-numeric, an absent value.
  return {
    allow: false,
    verdict: 'cannot-verify',
    message:
      `CANNOT VERIFY the dispatched ref against ${expected} (git exit ${String(raw)}). ` +
      `Aborting rather than deploying: "could not measure" is not a pass. ` +
      `Most likely cause is a shallow clone — actions/checkout needs fetch-depth: 0 ` +
      `so ${expected} and the full history are present.`,
  };
}

module.exports = { DEPLOY_REF_POLICY, EXPECTED_REF, refDeployVerdict };
