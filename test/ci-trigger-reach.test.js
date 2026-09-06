/**
 * A workflow's trigger cannot name a branch it does not live on — card ypwU6ylp
 * (items 3+4 of K5YgkNtO).
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * `main`'s ci.yml declared `branches: [main, real-app]` on BOTH `push` and
 * `pull_request`. Both were inert. A workflow file is resolved from the branch
 * that owns the event, and `real-app` has no `ci.yml`:
 *
 *   push to real-app            resolves from real-app       -> never runs
 *   pull_request INTO real-app  resolves from the BASE, which IS real-app
 *                                                            -> never runs
 *
 * MEASURED: PR #82 (base real-app, head 3348cad7) produced exactly one run —
 * `CI (real-app)`, path .github/workflows/ci-realapp.yml.
 *
 * ⭐ AND IT IS INVISIBLE AT THE CHECK LEVEL. ci-realapp.yml emits the SAME two
 * check names — `test` and `Lint workflow files` — so a real-app PR shows the
 * checks a reader expects and they conclude main's ci.yml ran. Only the run's
 * name/path tells them apart. That is why a clause naming an unreachable branch
 * survived: nothing ever contradicted it.
 *
 * This test is the contradiction, made permanent and cheap.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const WF = path.join(REPO, '.github', 'workflows');

/** Branch names a workflow file's `on:` block lists, per event. */
function triggerBranches(yamlText, event) {
  const re = new RegExp(`\\n  ${event}:\\n(?:[^\\n]*\\n)*?    branches:\\s*\\[([^\\]]*)\\]`);
  const m = re.exec(yamlText);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/** Which workflow FILES exist on a git ref. Returns null when the ref is absent. */
function workflowsOn(ref) {
  try {
    return execFileSync('git', ['ls-tree', '--name-only', ref, '.github/workflows/'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean)
      .map((p) => path.basename(p));
  } catch {
    return null;
  }
}

const ci = fs.readFileSync(path.join(WF, 'ci.yml'), 'utf8');

test('ci.yml no longer claims to gate real-app on either event', () => {
  for (const event of ['push', 'pull_request']) {
    const branches = triggerBranches(ci, event);
    assert.ok(branches, `ci.yml has no ${event}.branches list to check`);
    assert.ok(
      !branches.includes('real-app'),
      `ci.yml ${event}.branches names real-app, which cannot resolve this file — ` +
        'real-app has no ci.yml. It is gated by its own ci-realapp.yml (card ypwU6ylp).',
    );
    // CONTROL: the assertion above passes on an EMPTY list too. main must stay.
    assert.ok(branches.includes('main'), `ci.yml ${event}.branches lost main`);
  }
});

test('the reason it cannot: real-app genuinely has no ci.yml', () => {
  // ⚠️ Skips LOUDLY rather than passing on nothing when the ref is absent (a
  // shallow clone or a fork), matching this repo's existing deploy-ref tests.
  const files = workflowsOn('origin/real-app');
  if (!files) {
    console.log('SKIP: origin/real-app not present — cannot verify (needs fetch-depth: 0)');
    return;
  }
  assert.ok(files.length > 0, 'origin/real-app has no workflows at all — measurement is wrong');
  assert.ok(
    !files.includes('ci.yml'),
    'real-app now HAS a ci.yml — the premise of this card changed; re-read before re-adding the branch',
  );
  assert.ok(
    files.includes('ci-realapp.yml'),
    'real-app lost ci-realapp.yml — it is now ungated, which is worse than the clause this card removed',
  );
});

test('⭐ the two workflows emit the SAME check names — why this was invisible', () => {
  // The finding, pinned. If these ever diverge, the confusion this card is
  // about stops being possible and this test says so by failing.
  const realapp = execFileSync('git', ['show', 'origin/real-app:.github/workflows/ci-realapp.yml'], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const names = (t) => [...t.matchAll(/^\s{4}name:\s*(.+)$/gm)].map((m) => m[1].trim());
  const jobIds = (t) => [...t.matchAll(/^  ([a-z][a-z0-9_-]*):\s*$/gm)].map((m) => m[1]);
  const shared = jobIds(ci).filter((j) => jobIds(realapp).includes(j));
  assert.ok(
    shared.includes('test'),
    'the two CI workflows no longer share the `test` job id — the check-name collision that hid this is gone',
  );
  assert.deepEqual(names(ci), names(realapp), 'the two workflows\' job display names have diverged');
});
