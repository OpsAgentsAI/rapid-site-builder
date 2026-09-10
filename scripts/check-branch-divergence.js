#!/usr/bin/env node
'use strict';
/**
 * Runs lib/branchDivergence.js against the REAL refs and reports.
 * Card xe1q8uHa. Driven by .github/workflows/divergence-alarm.yml.
 *
 * Exit 0 = no product work is stranded. Exit 1 = alarm OR cannot-verify —
 * both are failures on purpose, because "I could not measure" must never read
 * as "all clear" (see the lib header).
 *
 *   node scripts/check-branch-divergence.js [--source main] [--target real-app]
 *
 * Writes a human report to stdout, a markdown block to $GITHUB_STEP_SUMMARY,
 * and `alarm` / `title` / `body` to $GITHUB_OUTPUT so the workflow can route it
 * to a human without re-deriving anything.
 *
 * Card s0qMA0O7: the verdict is now measured against divergence-baseline.json —
 * "has anything become unreachable SINCE the acknowledged snapshot?" — because a
 * detector that was red on every run for a true-but-known reason had stopped
 * being able to report a new one. Re-baselining is deliberate and by hand:
 * scripts/write-divergence-baseline.js.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { classifyUnreachableWork } = require('../lib/branchDivergence');

const BASELINE_PATH = path.join(__dirname, '..', 'divergence-baseline.json');
/**
 * A MISSING baseline must not read as "nothing is acknowledged" — that would put
 * the whole outstanding backlog back into the alarm and restore the permanent red
 * this card exists to end. It is reported loudly instead, and the run still
 * measures, so the failure is visible rather than silent either way.
 */
function loadBaseline() {
  try {
    const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const commits = Array.isArray(parsed.commits) ? parsed.commits.length : 0;
    const paths = Array.isArray(parsed.paths) ? parsed.paths.length : 0;
    return { baseline: parsed, note: `baseline: ${commits} commit(s), ${paths} path(s) acknowledged ${parsed.acknowledgedAt ? `on ${parsed.acknowledgedAt}` : ''}`.trim() };
  } catch (e) {
    return {
      baseline: null,
      note: `baseline: NONE READABLE (${e.code === 'ENOENT' ? 'divergence-baseline.json missing' : e.message}) — every unreachable item counts as new`,
    };
  }
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SOURCE = arg('source', 'main');
const TARGET = arg('target', 'real-app');

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });

function resolveRef(ref) {
  for (const cand of [`refs/remotes/origin/${ref}`, ref]) {
    const r = git('rev-parse', '--verify', '--quiet', cand);
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

const sourceSha = resolveRef(SOURCE);
const targetSha = resolveRef(TARGET);
const { baseline, note: baselineNote } = loadBaseline();

/** Files present on source and absent on target — TREE presence, not reachability. */
function sourceOnlyPathsFor(a, b) {
  if (!a || !b) return [];
  const ls = (sha) => {
    const r = git('ls-tree', '-r', '--name-only', sha);
    return r.status === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : null;
  };
  const src = ls(a);
  const tgt = ls(b);
  // A failed ls-tree must not masquerade as "no files missing" — same
  // cannot-verify discipline as the reachability half.
  if (!src || !tgt) return null;
  const have = new Set(tgt);
  return src.filter((p) => !have.has(p));
}

let symmetricCount = 0;
let unreachable = [];
if (sourceSha && targetSha) {
  const counts = git('rev-list', '--left-right', '--count', `${sourceSha}...${targetSha}`);
  if (counts.status === 0) {
    const [a, b] = counts.stdout.trim().split(/\s+/).map(Number);
    symmetricCount = (a || 0) + (b || 0);
  }
  const list = git('rev-list', `${targetSha}..${sourceSha}`);
  if (list.status === 0) {
    unreachable = list.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((sha) => ({
        sha,
        subject: (git('log', '-1', '--format=%s', sha).stdout || '').trim(),
        // --name-only on a merge commit prints nothing, which would misclassify
        // it as CI-only. -m --first-parent makes a merge report the files it
        // actually brought in.
        paths: (git('show', '--pretty=format:', '--name-only', '-m', '--first-parent', sha).stdout || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      }));
  }
}

const sourceOnlyPaths = sourceOnlyPathsFor(sourceSha, targetSha);
const verdict = classifyUnreachableWork({
  sourceSha,
  targetSha,
  symmetricCount,
  unreachable,
  sourceOnlyPaths: sourceOnlyPaths || [],
  baseline,
  sourceName: SOURCE,
  targetName: TARGET,
});

// The cannot-verify message already announces itself; don't stutter.
const head = verdict.message.startsWith('CANNOT VERIFY')
  ? verdict.message
  : `${verdict.verdict.toUpperCase()}: ${verdict.message}`;
const lines = [
  head,
  '',
  `${SOURCE} = ${sourceSha ? sourceSha.slice(0, 8) : '(unresolved)'}`,
  `${TARGET} = ${targetSha ? targetSha.slice(0, 8) : '(unresolved)'}`,
  `symmetric difference = ${symmetricCount} commit(s)`,
  `unreachable from ${TARGET}: ${unreachable.length} total · ${verdict.productCommits.length} product · ${verdict.ciOnlyCount} CI-only`,
  baselineNote,
  sourceOnlyPaths === null
    ? 'tree presence: UNREADABLE (git ls-tree failed) — reported, never treated as "no files missing"'
    : `tree presence: ${sourceOnlyPaths.length} file(s) on ${SOURCE} only · ${verdict.newProductPaths.length} NEW product file(s)`,
];
// NEW work leads the report — it is the reason to read it. The acknowledged
// backlog is summarised, never re-listed in full: re-printing 41 known commits
// every run is how the one new line gets lost, which is this card's own defect.
if (verdict.newProductCommits.length) {
  lines.push('', `NEW product commits that cannot reach the served surface (since baseline):`);
  for (const c of verdict.newProductCommits.slice(0, 40)) {
    lines.push(`  ${c.sha.slice(0, 8)}  ${c.subject}`);
  }
  if (verdict.newProductCommits.length > 40) {
    // Never truncate silently — a capped list that looks complete is how a
    // report understates the very thing it exists to surface.
    lines.push(`  … and ${verdict.newProductCommits.length - 40} more (list capped at 40 for readability)`);
  }
}
if (verdict.newProductPaths.length) {
  lines.push('', `NEW product files present on ${SOURCE} and absent from ${TARGET} (since baseline):`);
  for (const p of verdict.newProductPaths.slice(0, 40)) lines.push(`  ${p}`);
  if (verdict.newProductPaths.length > 40) {
    lines.push(`  … and ${verdict.newProductPaths.length - 40} more (list capped at 40 for readability)`);
  }
}
if (verdict.acknowledgedProductCount || verdict.acknowledgedPathCount) {
  lines.push(
    '',
    `Acknowledged backlog (card xe1q8uHa, NOT alarming): ${verdict.acknowledgedProductCount} product commit(s), ` +
      `${verdict.acknowledgedPathCount} product file(s).`,
  );
}
if (verdict.staleBaselineCommits.length || verdict.staleBaselinePaths.length) {
  lines.push(
    `Baseline drift: ${verdict.staleBaselineCommits.length} commit(s) and ${verdict.staleBaselinePaths.length} path(s) ` +
      'in the baseline no longer apply — prune with scripts/write-divergence-baseline.js.',
  );
}
const report = lines.join('\n');
console.log(report);

const title =
  `🔀 NEW work cannot reach ${TARGET} (${verdict.newProductCommits.length} commit(s), ` +
  `${verdict.newProductPaths.length} file(s) since baseline)`;
const body = [
  `**${head}**`,
  '',
  '```',
  report,
  '```',
  '',
  `Opened automatically by \`.github/workflows/divergence-alarm.yml\` (card xe1q8uHa).`,
  'It closes itself when the condition clears. If this is noise, fix the alarm — do not mute it.',
].join('\n');

const out = (file, text) => {
  if (file) fs.appendFileSync(file, text);
};
out(process.env.GITHUB_STEP_SUMMARY, `### Branch divergence alarm\n\n\`\`\`\n${report}\n\`\`\`\n`);
const d = `EOF_${Date.now()}`;
out(
  process.env.GITHUB_OUTPUT,
  `alarm=${verdict.alarm ? 'true' : 'false'}\nverdict=${verdict.verdict}\ntitle=${title}\nbody<<${d}\n${body}\n${d}\n`,
);

process.exit(verdict.alarm ? 1 : 0);
