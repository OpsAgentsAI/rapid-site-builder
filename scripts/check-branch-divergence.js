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
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { classifyUnreachableWork } = require('../lib/branchDivergence');

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

const verdict = classifyUnreachableWork({
  sourceSha,
  targetSha,
  symmetricCount,
  unreachable,
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
];
if (verdict.productCommits.length) {
  lines.push('', 'Product commits that cannot reach the served surface:');
  for (const c of verdict.productCommits.slice(0, 40)) {
    lines.push(`  ${c.sha.slice(0, 8)}  ${c.subject}`);
  }
  if (verdict.productCommits.length > 40) {
    // Never truncate silently — a capped list that looks complete is how a
    // report understates the very thing it exists to surface.
    lines.push(`  … and ${verdict.productCommits.length - 40} more (list capped at 40 for readability)`);
  }
}
const report = lines.join('\n');
console.log(report);

const title = `🔀 Merged work cannot reach ${TARGET} (${verdict.productCommits.length} product commit(s))`;
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
