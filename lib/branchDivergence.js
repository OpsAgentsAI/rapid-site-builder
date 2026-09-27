'use strict';
/**
 * IS ANY MERGED, FINISHED WORK UNABLE TO REACH THE SURFACE THAT SERVES USERS?
 * Card xe1q8uHa — the standing alarm the one-shot forward-port (card o0Yoqup8,
 * 2026-07-19) never became.
 *
 * ── WHAT WENT WRONG WITHOUT IT ──────────────────────────────────────────────
 * `main` and `real-app` diverged for five weeks and NOTHING said so. Every
 * surface was green the entire time: CI passed on both branches, both deploy
 * workflows succeeded, and prod simply never changed. The gap was invisible
 * because nothing was ever measuring it — a staleness that produces no red is
 * indistinguishable from a system at rest. Two DONE features (PRs #58 and #59,
 * reviewed, merged, green) turned out to be sitting on a branch nothing
 * deploys from, with no action available to any lane that would change that.
 *
 * Measured on the real refs the day this file was written: `main` was **43
 * commits** ahead of `real-app`, **32 of them touching product source**.
 *
 * ── WHY THIS MEASURES *UNREACHABLE WORK*, NOT "DIVERGENCE" ──────────────────
 * The obvious alarm — "the branches have diverged" — is the wrong one, and it
 * is wrong in a way that would get it deleted within a week:
 *
 *  1. Divergence is EXPECTED here. `real-app` carries 14 auth-ON commits that
 *     `main` deliberately lacks (Michal's 2026-06-16 guardrail: the login gate
 *     lives on a different branch and a different URL). An alarm that fires on
 *     "ahead/behind != 0" is red on day one, red forever, and teaches its
 *     reader to ignore it.
 *  2. Not every unreachable commit matters. The card's own evidence turned on
 *     exactly this: the one undeployed commit on the prod branch touched TWO
 *     files, both `.github/workflows/*`, and therefore **changed no served
 *     byte**. A CI-only commit that never reaches prod is not an outage.
 *  3. It survives the topology decision either way. The open question on card
 *     xe1q8uHa is whether these branches reconcile or `real-app` is a permanent
 *     fork. Under BOTH answers, "product work merged to `main` that the served
 *     surface does not have" is the thing a human needs to know. A permanent
 *     fork does not make unreachable features acceptable; it just changes the
 *     remedy. So this file takes no position on the topology — deliberately.
 *
 * ── "COULD NOT MEASURE" IS NOT A PASS ───────────────────────────────────────
 * The same three-way rule as lib/deployRefPolicy.js, for the same reason, and
 * here the dangerous direction is a FALSE GREEN: `actions/checkout` defaults to
 * `fetch-depth: 1`, and on a shallow clone `rev-list A..B` happily returns
 * NOTHING. An alarm that reports "no unreachable work" because it could not see
 * the history is worse than no alarm — it is a control that measures nothing
 * and reports green, which is the failure this whole card is about.
 *
 * So the instrument is checked before its output is believed:
 *   • both refs must resolve, and
 *   • two DIFFERENT tips cannot have an empty symmetric difference. If
 *     `sourceSha !== targetSha` and the symmetric count is 0, the measurement
 *     is impossible and the answer is `cannot-verify`, never `ok`.
 * That is a positive control on the instrument, not on the subject.
 *
 * ── THE BASELINE (card s0qMA0O7) — WHY A DETECTOR NEEDED ONE ────────────────
 * Measured 2026-09-07: this alarm was RED on five consecutive runs. Not wrong —
 * red for a TRUE reason, the 39-commit backlog card xe1q8uHa owns. But a verdict
 * that cannot come back green has stopped carrying information: the next real
 * divergence is line 40 of a list nobody is draining, indistinguishable from the
 * 39 above it. This file's own header already names that outcome — "an alarm that
 * cannot un-ring becomes noise, and noise is how the next one gets muted".
 *
 * So the question changes from "is anything unreachable?" (permanently yes) to
 * "has anything become unreachable SINCE the acknowledged snapshot?".
 *
 * ⚠️ The obvious way to build that is a mute, and a mute is the same defect
 * pointed the other way. Three properties keep it a detector:
 *   1. The baseline is a PINNED LIST, so it can only ever cover work that was
 *      already measured. It cannot pre-acknowledge a commit that does not exist.
 *   2. The acknowledged backlog is still COUNTED AND REPORTED in every verdict,
 *      including green ones. "Quiet" must never mean "the backlog went away".
 *   3. Baseline entries that no longer apply are reported as STALE, so a drained
 *      backlog prunes the file instead of leaving it to grow into a blanket
 *      exemption that silently covers future work.
 */

/**
 * Paths whose changes cannot alter a served byte. Everything else counts as
 * product source. The list is deliberately SHORT and the default is "product":
 * a new top-level directory should count as product until someone argues
 * otherwise, because the failure mode of guessing wrong here is a silent
 * false green — precisely what this alarm exists to end.
 */
/**
 * ⚠️ `test/` AND `scripts/` ARE DELIBERATELY *NOT* HERE, and that is the line a
 * future reader is most likely to "fix". A stranded test is stranded regression
 * coverage on the branch that deploys PROD — the branch that most needs it. The
 * cost of including them is measured and small: of the 43 unreachable commits
 * the day this landed, 32 counted as product and only 3 were test/scripts-only.
 * If you exclude them, say what you are trading away.
 */
const NON_PRODUCT_PATTERNS = [
  /^\.github\//, // CI, deploy workflows, issue templates
  /^docs\//,
  /(^|\/)[^/]*\.md$/, // READMEs, runbooks, notes anywhere in the tree
  /^LICENSE$/,
  /^\.gitignore$/,
];

/** True when a changed path can alter what a user is served. */
function isProductPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  return !NON_PRODUCT_PATTERNS.some((re) => re.test(p));
}

/**
 * Any product commit that cannot reach the serving surface is already the
 * failure — PRs #58 and #59 were ONE each. A higher threshold would only be
 * choosing how much finished, invisible work is acceptable, and the answer to
 * that is none. Overridable so a deliberate, temporary tolerance is an argument
 * at the call site rather than an edit to this line.
 */
const DEFAULT_MAX_UNREACHABLE_PRODUCT_COMMITS = 0;

/** Normalise the committed baseline into two lookup sets. Absent/garbled → empty. */
function normalizeBaseline(baseline) {
  const b = baseline && typeof baseline === 'object' ? baseline : {};
  const commits = new Set((Array.isArray(b.commits) ? b.commits : []).filter((x) => typeof x === 'string' && x));
  const paths = new Set((Array.isArray(b.paths) ? b.paths : []).filter((x) => typeof x === 'string' && x));
  return { commits, paths };
}

/**
 * @param {object} m raw measurement — no git is run in here, on purpose: this
 *   file is pure so its verdicts are testable without a repo.
 * @param {string|null} m.sourceSha  tip of the branch work merges INTO (`main`)
 * @param {string|null} m.targetSha  tip of the branch that is DEPLOYED (`real-app`)
 * @param {number} m.symmetricCount  total commits on either side of the fork point
 * @param {Array<{sha: string, subject: string, paths: string[]}>} m.unreachable
 *   commits present on source and absent from target
 * @param {string[]} [m.sourceOnlyPaths] files present on source and absent on
 *   target — TREE presence, a signal distinct from commit reachability. A file
 *   deleted on target, or a workflow that only ever existed on source, does not
 *   show up as its own commit in the list above.
 * @param {object} [m.baseline] the committed acknowledged set: {commits, paths}
 * @param {number} [m.threshold]
 */
function classifyUnreachableWork(m) {
  const {
    sourceSha,
    targetSha,
    symmetricCount,
    unreachable,
    sourceOnlyPaths,
    baseline,
    threshold = DEFAULT_MAX_UNREACHABLE_PRODUCT_COMMITS,
    sourceName = 'main',
    targetName = 'real-app',
  } = m || {};

  if (!sourceSha || !targetSha) {
    return {
      verdict: 'cannot-verify',
      alarm: true,
      productCommits: [],
      ciOnlyCount: 0,
      newProductCommits: [],
      acknowledgedProductCount: 0,
      newProductPaths: [],
      acknowledgedPathCount: 0,
      staleBaselineCommits: [],
      staleBaselinePaths: [],
      message:
        `CANNOT VERIFY: ${!sourceSha ? sourceName : targetName} did not resolve. ` +
        'Aborting rather than reporting "no unreachable work": on a shallow clone ' +
        'the measurement returns empty for the same reason a healthy repo does. ' +
        'actions/checkout needs fetch-depth: 0 and both refs fetched.',
    };
  }

  if (sourceSha !== targetSha && Number(symmetricCount) === 0) {
    return {
      verdict: 'cannot-verify',
      alarm: true,
      productCommits: [],
      ciOnlyCount: 0,
      newProductCommits: [],
      acknowledgedProductCount: 0,
      newProductPaths: [],
      acknowledgedPathCount: 0,
      staleBaselineCommits: [],
      staleBaselinePaths: [],
      message:
        `CANNOT VERIFY: ${sourceName} and ${targetName} are different commits ` +
        `(${sourceSha.slice(0, 8)} vs ${targetSha.slice(0, 8)}) yet the symmetric ` +
        'difference measured 0 — that is impossible, so the instrument is not ' +
        'reading real history. Treating it as a failure, not as "all clear".',
    };
  }

  const list = Array.isArray(unreachable) ? unreachable : [];
  const productCommits = list.filter((c) => (c.paths || []).some(isProductPath));
  const ciOnlyCount = list.length - productCommits.length;

  const ack = normalizeBaseline(baseline);

  // Commit reachability, split against the acknowledged snapshot.
  const newProductCommits = productCommits.filter((c) => !ack.commits.has(c.sha));
  const acknowledgedProductCount = productCommits.length - newProductCommits.length;

  // TREE presence — a distinct signal. A file can be missing from the target
  // without any single unreachable commit naming it (deleted there, or born on
  // source before the fork point), so this is measured, not inferred.
  const srcOnly = (Array.isArray(sourceOnlyPaths) ? sourceOnlyPaths : []).filter(isProductPath);
  const newProductPaths = srcOnly.filter((p) => !ack.paths.has(p));
  const acknowledgedPathCount = srcOnly.length - newProductPaths.length;

  // Baseline hygiene: an acknowledgement that no longer applies. Reported so a
  // drained backlog PRUNES the file, instead of leaving a growing blanket
  // exemption behind that would quietly cover future work.
  const unreachableShas = new Set(list.map((c) => c.sha));
  const srcOnlySet = new Set(Array.isArray(sourceOnlyPaths) ? sourceOnlyPaths : []);
  const staleBaselineCommits = [...ack.commits].filter((sha) => !unreachableShas.has(sha));
  const staleBaselinePaths = [...ack.paths].filter((p) => !srcOnlySet.has(p));

  // The acknowledged backlog is stated in EVERY verdict, green ones included:
  // "the alarm is quiet" must never be readable as "the backlog went away".
  const backlogNote =
    acknowledgedProductCount || acknowledgedPathCount
      ? ` Acknowledged backlog still outstanding: ${acknowledgedProductCount} product commit(s)` +
        `, ${acknowledgedPathCount} product file(s) absent from ${targetName} (card xe1q8uHa owns draining it).`
      : '';
  const staleNote = staleBaselineCommits.length || staleBaselinePaths.length
    ? ` ${staleBaselineCommits.length} baselined commit(s) and ${staleBaselinePaths.length} baselined path(s) ` +
      'no longer apply — re-run scripts/write-divergence-baseline.js to prune them.'
    : '';

  const common = {
    productCommits,
    ciOnlyCount,
    newProductCommits,
    acknowledgedProductCount,
    newProductPaths,
    acknowledgedPathCount,
    staleBaselineCommits,
    staleBaselinePaths,
  };

  if (newProductCommits.length > threshold || newProductPaths.length > 0) {
    const parts = [];
    if (newProductCommits.length > threshold) {
      parts.push(
        `${newProductCommits.length} NEW product commit(s) merged to ${sourceName} cannot reach ` +
          `${targetName}, the branch the served surface is deployed from`,
      );
    }
    if (newProductPaths.length) {
      parts.push(
        `${newProductPaths.length} NEW product file(s) present on ${sourceName} and absent from ${targetName}`,
      );
    }
    return {
      ...common,
      verdict: 'alarm',
      alarm: true,
      message:
        `${parts.join('; ')}. This is work that became unreachable AFTER the acknowledged ` +
        'baseline, so it is a new event, not the known backlog.' +
        (ciOnlyCount ? ` (${ciOnlyCount} CI-only commit(s) also unreachable, which change no served byte.)` : '') +
        backlogNote +
        staleNote,
    };
  }

  return {
    ...common,
    verdict: 'ok',
    alarm: false,
    message:
      `Nothing NEW is stranded: every product commit and file on ${sourceName} that ${targetName} ` +
      'lacks was already acknowledged in the baseline.' +
      (ciOnlyCount
        ? ` ${ciOnlyCount} CI-only commit(s) are unreachable, which is not an outage — they change no served byte.`
        : '') +
      backlogNote +
      staleNote,
  };
}

module.exports = {
  NON_PRODUCT_PATTERNS,
  normalizeBaseline,
  DEFAULT_MAX_UNREACHABLE_PRODUCT_COMMITS,
  isProductPath,
  classifyUnreachableWork,
};
