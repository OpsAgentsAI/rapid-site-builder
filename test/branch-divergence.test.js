'use strict';
// Card xe1q8uHa — the standing alarm for merged work that cannot reach the
// served surface. See lib/branchDivergence.js for why it measures UNREACHABLE
// PRODUCT WORK rather than "the branches diverged".
//
// ⚠️ READ THIS BEFORE ADDING AN ASSERTION ABOUT THE LIVE REFS.
// This suite must NOT go red merely because `main` and `real-app` are currently
// diverged. They ARE, deliberately and by Michal's 2026-06-16 guardrail, and
// they will stay that way until card xe1q8uHa's topology decision is made. A
// test that reds on the live divergence would red every PR on both branches,
// and the fix a reader reaches for under that red is to delete the alarm.
//
// The division of labour is therefore explicit:
//   • THIS SUITE pins the CLASSIFIER — given a measurement, is the verdict right?
//     Deterministic, no repo needed, safe to run anywhere.
//   • THE SCHEDULED WORKFLOW (.github/workflows/divergence-alarm.yml) runs the
//     classifier against the real refs and is the thing allowed to go red.
// One live-refs test does run here, and it asserts only that the instrument can
// SEE history — it never asserts the branches agree.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  isProductPath,
  classifyUnreachableWork,
  DEFAULT_MAX_UNREACHABLE_PRODUCT_COMMITS,
} = require('../lib/branchDivergence');

const REPO = path.join(__dirname, '..');
const commit = (sha, subject, paths) => ({ sha, subject, paths });
const measure = (over) => ({
  sourceSha: 'a'.repeat(40),
  targetSha: 'b'.repeat(40),
  symmetricCount: 57,
  unreachable: [],
  ...over,
});

test('a served-byte path is product; CI, docs and markdown are not', () => {
  for (const p of ['server.js', 'lib/auth.js', 'web/board.js', 'package.json', 'Dockerfile']) {
    assert.equal(isProductPath(p), true, `${p} must count as product source`);
  }
  for (const p of ['.github/workflows/deploy.yml', 'docs/topology.md', 'README.md', 'LICENSE']) {
    assert.equal(isProductPath(p), false, `${p} cannot change a served byte`);
  }
});

test('an unknown top-level path counts as PRODUCT — the default must fail loud, not quiet', () => {
  // A new directory nobody has classified yet is the exact case where guessing
  // "probably harmless" produces the silent false green this card is about.
  assert.equal(isProductPath('some-new-service/index.js'), true);
});

test('product work stranded on the source branch ALARMS', () => {
  const v = classifyUnreachableWork(
    measure({
      unreachable: [
        commit('1111111', 'feat: live approval actions', ['web/board.js']),
        commit('2222222', 'feat: admin multi-tenant board', ['lib/admin.js', 'web/board.js']),
      ],
    }),
  );
  assert.equal(v.verdict, 'alarm');
  assert.equal(v.alarm, true);
  assert.equal(v.productCommits.length, 2);
  assert.match(v.message, /cannot reach/);
});

test('CI-ONLY commits do NOT alarm — that distinction is the card\'s own evidence', () => {
  // The single undeployed commit on the prod branch touched two files, both
  // .github/workflows/*, and therefore changed no served byte. An alarm that
  // fired on it would be crying wolf on the exact measurement that proved
  // dispatching prod could not help.
  const v = classifyUnreachableWork(
    measure({
      unreachable: [commit('3333333', 'ci: pin the deploy ref', ['.github/workflows/deploy.yml'])],
    }),
  );
  assert.equal(v.verdict, 'ok');
  assert.equal(v.alarm, false);
  assert.equal(v.ciOnlyCount, 1);
  assert.match(v.message, /not an outage/);
});

test('a mixed commit alarms — one product file in it is enough', () => {
  const v = classifyUnreachableWork(
    measure({
      unreachable: [commit('4444444', 'chore: bump + tweak workflow', ['.github/workflows/ci.yml', 'server.js'])],
    }),
  );
  assert.equal(v.verdict, 'alarm');
  assert.equal(v.productCommits.length, 1);
});

test('divergence alone is NOT the alarm: the target may be ahead and still be fine', () => {
  // `real-app` legitimately carries 14 auth-ON commits `main` lacks. Nothing
  // unreachable in the measured direction ⇒ ok, no matter how far apart the
  // tips are.
  const v = classifyUnreachableWork(measure({ symmetricCount: 14, unreachable: [] }));
  assert.equal(v.verdict, 'ok');
  assert.equal(v.alarm, false);
});

test('the default threshold is ZERO — PRs #58 and #59 were one commit each', () => {
  assert.equal(DEFAULT_MAX_UNREACHABLE_PRODUCT_COMMITS, 0);
  const one = classifyUnreachableWork(
    measure({ unreachable: [commit('5555555', 'feat: something users see', ['web/app.js'])] }),
  );
  assert.equal(one.verdict, 'alarm', 'a single stranded product commit is already the failure');
  const tolerated = classifyUnreachableWork(
    measure({ unreachable: [commit('5555555', 'feat: something users see', ['web/app.js'])], threshold: 1 }),
  );
  assert.equal(tolerated.verdict, 'ok', 'a raised threshold must be an argument, not an edit');
});

test('AN UNRESOLVED REF IS "CANNOT VERIFY", NEVER "OK"', () => {
  // The shallow-clone false green: rev-list returns nothing for the same reason
  // a healthy repo does. Reporting all-clear here is the failure this card is
  // about, reached through the alarm itself.
  for (const over of [{ sourceSha: null }, { targetSha: null }]) {
    const v = classifyUnreachableWork(measure(over));
    assert.equal(v.verdict, 'cannot-verify');
    assert.equal(v.alarm, true, 'cannot-verify must still be loud');
    assert.match(v.message, /fetch-depth: 0/);
  }
});

test('POSITIVE CONTROL ON THE INSTRUMENT: two different tips cannot have an empty symmetric difference', () => {
  // Without this, a broken measurement is indistinguishable from a healthy
  // repo — both produce an empty list. This is the check that makes the empty
  // list mean something.
  const v = classifyUnreachableWork(measure({ symmetricCount: 0 }));
  assert.equal(v.verdict, 'cannot-verify');
  assert.match(v.message, /impossible/);
  // ...and the same 0 IS legitimate when the tips are identical.
  const same = 'c'.repeat(40);
  const ok = classifyUnreachableWork(measure({ sourceSha: same, targetSha: same, symmetricCount: 0 }));
  assert.equal(ok.verdict, 'ok');
});

test('LIVE REFS: the instrument can see history (asserts nothing about agreement)', () => {
  const resolve = (ref) => {
    for (const cand of [`refs/remotes/origin/${ref}`, ref]) {
      const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', cand], { cwd: REPO, encoding: 'utf8' });
      if (r.status === 0) return r.stdout.trim();
    }
    return null;
  };
  const mainSha = resolve('main');
  const appSha = resolve('real-app');
  if (!mainSha || !appSha) {
    console.log('SKIP: need both main and real-app locally (shallow clone?)');
    return;
  }
  const counts = spawnSync('git', ['rev-list', '--left-right', '--count', `${mainSha}...${appSha}`], {
    cwd: REPO,
    encoding: 'utf8',
  });
  assert.equal(counts.status, 0, 'git rev-list failed');
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  const v = classifyUnreachableWork({
    sourceSha: mainSha,
    targetSha: appSha,
    symmetricCount: ahead + behind,
    unreachable: [], // deliberately not measured here — see the header
  });
  // The ONLY thing pinned: the instrument is not silently blind. Whether the
  // branches agree is the scheduled workflow's business, not this suite's.
  assert.notEqual(v.verdict, 'cannot-verify', v.message);
});
