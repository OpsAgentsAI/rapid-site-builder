#!/usr/bin/env node
'use strict';
/**
 * Re-baseline the divergence alarm — card s0qMA0O7.
 *
 * ── WHY RE-BASELINING IS A SEPARATE, DELIBERATE ACT ─────────────────────────
 * The alarm answers "has anything NEW become unreachable since the baseline?".
 * That question is only worth asking if the baseline moves when a HUMAN decides
 * it should, never as a side effect of a run. An alarm that re-baselined itself
 * on every execution would be green forever by construction — the same defect
 * this card was filed about, wearing the opposite hat.
 *
 * So: this script is NOT wired into the workflow. It is run by hand, its output
 * is committed, and the diff is the audit trail of what was acknowledged and
 * when.
 *
 *   node scripts/write-divergence-baseline.js [--source main] [--target real-app]
 *
 * Writes divergence-baseline.json in the repo root.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SOURCE = arg('source', 'main');
const TARGET = arg('target', 'real-app');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const resolve = (ref) => {
  for (const cand of [`refs/remotes/origin/${ref}`, ref]) {
    try {
      const out = git('rev-parse', '--verify', '--quiet', cand).trim();
      if (out) return out;
    } catch { /* try the next candidate */ }
  }
  return null;
};

const sourceSha = resolve(SOURCE);
const targetSha = resolve(TARGET);
if (!sourceSha || !targetSha) {
  // Refusing beats writing an EMPTY baseline: an empty acknowledged set silently
  // means "nothing is acknowledged", which would turn the whole outstanding
  // backlog back into a permanent red — the state this card exists to end.
  console.error(`Cannot resolve ${!sourceSha ? SOURCE : TARGET}. Fetch both branches with full history first.`);
  process.exit(2);
}

const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const commits = lines(git('rev-list', `${targetSha}..${sourceSha}`));
const srcFiles = new Set(lines(git('ls-tree', '-r', '--name-only', sourceSha)));
const tgtFiles = new Set(lines(git('ls-tree', '-r', '--name-only', targetSha)));
const paths = [...srcFiles].filter((p) => !tgtFiles.has(p)).sort();

const baseline = {
  _comment:
    'Acknowledged divergence — card s0qMA0O7. The alarm reds only on work that becomes ' +
    'unreachable AFTER this snapshot. Everything listed here is already known and is owned ' +
    'by card xe1q8uHa. Draining that backlog does NOT require editing this file; it only ' +
    'makes entries here stale, which the alarm reports so they can be pruned.',
  _regenerate: 'node scripts/write-divergence-baseline.js  (deliberate, by hand, committed)',
  source: SOURCE,
  target: TARGET,
  acknowledgedAt: new Date().toISOString().slice(0, 10),
  acknowledgedSourceSha: sourceSha,
  acknowledgedTargetSha: targetSha,
  commits,
  paths,
};

const out = path.join(__dirname, '..', 'divergence-baseline.json');
fs.writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(
  `wrote ${path.relative(process.cwd(), out)}: ${commits.length} commit(s), ${paths.length} path(s) acknowledged ` +
    `(${SOURCE} ${sourceSha.slice(0, 8)} vs ${TARGET} ${targetSha.slice(0, 8)})`,
);
