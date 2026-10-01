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
  // Only lines indented UNDER the event (4+ spaces) may sit between the event
  // key and its `branches:`. The old `[^\\n]*` let an UNFILTERED event borrow
  // the NEXT event's branch list, so `pull_request:` with no filter followed by
  // `push: branches:[main]` read as [main]: the unfiltered, fires-everywhere
  // case looked safe (card SFPFwKu8, caught by the control test below).
  const re = new RegExp(`\\n  ${event}:\\n(?:    [^\\n]*\\n)*?    branches:\\s*\\[([^\\]]*)\\]`);
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

test('the reason it cannot: nothing named ci.yml on real-app fires FOR real-app', () => {
  // ⚠️ Skips LOUDLY rather than passing on nothing when the ref is absent (a
  // shallow clone or a fork), matching this repo's existing deploy-ref tests.
  //
  // Card SFPFwKu8: this used to assert real-app has NO ci.yml. The main→real-app
  // forward-port (PR #88, merge 777f28f4, card xe1q8uHa) carried one over, so
  // that premise stopped being true and main went red on the next push. The
  // premise was never the point. The point is that real-app must not be gated
  // by a ci.yml that fires for real-app beside ci-realapp.yml. Both emit the
  // same `test` / `Lint workflow files` check names (see the ⭐ test below), so
  // two firing on one event would show duplicate checks nobody can tell apart.
  // So the invariant is now: if real-app carries a ci.yml, its triggers must
  // name only main. That makes it inert on real-app (a push to real-app, or a PR
  // into real-app, resolves real-app's copy and does not match `[main]`), and
  // ci-realapp.yml stays the ONE gate.
  const files = workflowsOn('origin/real-app');
  if (!files) {
    console.log('SKIP: origin/real-app not present — cannot verify (needs fetch-depth: 0)');
    return;
  }
  assert.ok(files.length > 0, 'origin/real-app has no workflows at all — measurement is wrong');
  assert.ok(
    files.includes('ci-realapp.yml'),
    'real-app lost ci-realapp.yml — it is now ungated, which is worse than the clause this card removed',
  );
  if (!files.includes('ci.yml')) return; // the original premise: nothing to check
  const realappCi = execFileSync('git', ['show', 'origin/real-app:.github/workflows/ci.yml'], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  for (const event of ['push', 'pull_request']) {
    const branches = triggerBranches(realappCi, event);
    // No branch filter at all would fire on EVERY branch, real-app included.
    assert.ok(branches, `real-app's ci.yml has no ${event}.branches filter — it would fire for real-app`);
    assert.ok(
      !branches.includes('real-app'),
      `real-app's ci.yml ${event}.branches names real-app — it now double-gates real-app beside ` +
        'ci-realapp.yml with identical check names. Keep real-app out of it (card SFPFwKu8).',
    );
  }
});

test('control: the real-app ci.yml check really discriminates (fires-for-real-app shapes are caught)', () => {
  const inert = 'on:\n  pull_request:\n    branches: [main]\n  push:\n    branches: [main]\n';
  const live = 'on:\n  pull_request:\n    branches: [main, real-app]\n  push:\n    branches: [main]\n';
  const unfiltered = 'on:\n  pull_request:\n  push:\n    branches: [main]\n';
  assert.deepEqual(triggerBranches('\n' + inert, 'pull_request'), ['main']);
  assert.ok(triggerBranches('\n' + live, 'pull_request').includes('real-app'));
  // An event with no `branches:` directly under it reads as null (would fire everywhere).
  assert.equal(triggerBranches('\n' + unfiltered, 'pull_request'), null);
});

// Card vpukxEgQ (09PBYCJY rule 2): ci.yml gained a `wif-pr-reachability` job as
// part of closing a same-repo PR identity-mint hole in preview.yml. real-app has
// its own preview.yml with the SAME defect (it predates this fix and was not
// forward-ported here — that PR targets main only, real-app's copy is a
// separate branch this PR cannot reach), so ci-realapp.yml has no matching
// guard yet. This is a KNOWN, ACKNOWLEDGED, ONE-ROW divergence — not the
// silent kind this test exists to catch. Forward-porting the rule-2 fix (and
// this guard) to real-app is real-app's own card to file, not a name to widen
// here without a reason.
const KNOWN_DIVERGED_NAMES = new Set(['WIF PR-reachability guard (09PBYCJY rule 2)']);

test('⭐ the two workflows emit the SAME check names — why this was invisible', () => {
  // The finding, pinned. If these ever diverge WITHOUT a named, reasoned
  // exception above, the confusion this card is about stops being possible and
  // this test says so by failing.
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
  const ciNames = names(ci).filter((n) => !KNOWN_DIVERGED_NAMES.has(n));
  const realappNames = names(realapp).filter((n) => !KNOWN_DIVERGED_NAMES.has(n));
  assert.deepEqual(ciNames, realappNames,
    'the two workflows\' job display names have diverged beyond the KNOWN_DIVERGED_NAMES exceptions above');
  // VACUITY GUARD: an exception set that swallowed a REAL, unintended divergence
  // would make the filtered comparison above pass over it silently. Every name
  // in the exception set must actually be present on (at least) one side, or it
  // is hiding nothing and should be removed.
  for (const known of KNOWN_DIVERGED_NAMES) {
    assert.ok(
      names(ci).includes(known) || names(realapp).includes(known),
      `KNOWN_DIVERGED_NAMES lists "${known}", which is not on EITHER side any more — stale exception, remove it`,
    );
  }
});
