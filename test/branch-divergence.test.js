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

// ─────────────────────────────────────────────────────────────────────────────
// Card s0qMA0O7 — THE BASELINE.
//
// The alarm was RED on five consecutive runs. Red for a TRUE reason (the backlog
// card xe1q8uHa owns), and therefore useless: the next real divergence is line 40
// of a list nobody is draining. This block pins the fix, and pins it in BOTH
// directions, because "a verdict that can only come back red" and "a verdict that
// can only come back green" are the same defect facing opposite ways — the second
// is what a careless baseline turns the first into.
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_A = 'a1'.repeat(20);
const KNOWN_B = 'b2'.repeat(20);
const FRESH = 'f9'.repeat(20);
const backlog = [
  commit(KNOWN_A, 'feat: known stranded work', ['lib/known.js']),
  commit(KNOWN_B, 'feat: more known stranded work', ['server.js']),
];
const BASELINE = { commits: [KNOWN_A, KNOWN_B], paths: ['lib/known.js', 'server.js'] };

test('s0qMA0O7 KNOWN-NEGATIVE — with the backlog baselined the verdict is GREEN', () => {
  const r = classifyUnreachableWork(
    measure({ unreachable: backlog, sourceOnlyPaths: ['lib/known.js', 'server.js'], baseline: BASELINE }),
  );
  assert.equal(r.verdict, 'ok');
  assert.equal(r.alarm, false, 'the acknowledged backlog must not keep the alarm permanently red');
  assert.equal(r.newProductCommits.length, 0);
  assert.equal(r.newProductPaths.length, 0);
});

test('s0qMA0O7 — …and GREEN still SAYS the backlog is outstanding, so quiet ≠ gone', () => {
  // The failure a lazy baseline produces: the alarm goes quiet and the reader
  // concludes the work shipped. The count has to survive into the green message.
  const r = classifyUnreachableWork(
    measure({ unreachable: backlog, sourceOnlyPaths: ['lib/known.js', 'server.js'], baseline: BASELINE }),
  );
  assert.equal(r.acknowledgedProductCount, 2);
  assert.equal(r.acknowledgedPathCount, 2);
  assert.match(r.message, /Acknowledged backlog still outstanding: 2 product commit\(s\)/);
  assert.match(r.message, /xe1q8uHa/, 'the green message must still name who owns draining it');
});

test('s0qMA0O7 KNOWN-POSITIVE — one NEW unreachable product commit goes RED and NAMES it', () => {
  const r = classifyUnreachableWork(
    measure({
      unreachable: [...backlog, commit(FRESH, 'feat: brand new stranded work', ['lib/fresh.js'])],
      sourceOnlyPaths: ['lib/known.js', 'server.js'],
      baseline: BASELINE,
    }),
  );
  assert.equal(r.verdict, 'alarm');
  assert.equal(r.alarm, true);
  assert.deepEqual(r.newProductCommits.map((c) => c.sha), [FRESH], 'the NEW commit must be isolated from the backlog');
  assert.match(r.message, /1 NEW product commit/);
  // …and the backlog must not be re-litigated as if it were the new event.
  assert.equal(r.acknowledgedProductCount, 2);
});

test('s0qMA0O7 AC-3 — TREE presence is its own signal: a new source-only file reds on its own', () => {
  // No new COMMIT at all — every commit is baselined. A file present on source and
  // absent on target is exactly the case the card says today's alarm cannot report
  // (`lib/deployRefPolicy.js`), because it is inferred from a 39-line commit list
  // or not at all.
  const r = classifyUnreachableWork(
    measure({
      unreachable: backlog,
      sourceOnlyPaths: ['lib/known.js', 'server.js', 'lib/deployRefPolicy.js'],
      baseline: BASELINE,
    }),
  );
  assert.equal(r.verdict, 'alarm');
  assert.equal(r.newProductCommits.length, 0, 'this fires on tree presence alone, not on reachability');
  assert.deepEqual(r.newProductPaths, ['lib/deployRefPolicy.js']);
  assert.match(r.message, /1 NEW product file\(s\)/);
});

test('s0qMA0O7 — a CI-only new file does NOT red, so the tree signal keeps the product/CI line', () => {
  const r = classifyUnreachableWork(
    measure({
      unreachable: backlog,
      sourceOnlyPaths: ['lib/known.js', 'server.js', '.github/workflows/new.yml', 'docs/new.md'],
      baseline: BASELINE,
    }),
  );
  assert.equal(r.verdict, 'ok', 'a workflow or a doc changes no served byte');
  assert.deepEqual(r.newProductPaths, []);
});

test('s0qMA0O7 — the baseline CANNOT pre-acknowledge work that does not exist yet', () => {
  // The property that keeps a pinned list from becoming a blanket exemption: it
  // matches by exact sha/path, so a future commit is new by construction. Stated
  // as a test because "it is a pinned list" is the whole safety argument.
  const overreaching = { commits: [KNOWN_A, KNOWN_B, 'c3'.repeat(20)], paths: [...BASELINE.paths, 'lib/never.js'] };
  const r = classifyUnreachableWork(
    measure({
      unreachable: [...backlog, commit(FRESH, 'feat: brand new', ['lib/fresh.js'])],
      sourceOnlyPaths: ['lib/known.js', 'server.js', 'lib/fresh.js'],
      baseline: overreaching,
    }),
  );
  assert.equal(r.verdict, 'alarm', 'a baseline listing unrelated shas must not cover a genuinely new commit');
  assert.deepEqual(r.newProductCommits.map((c) => c.sha), [FRESH]);
  assert.deepEqual(r.newProductPaths, ['lib/fresh.js']);
});

test('s0qMA0O7 — a DRAINED backlog is reported as stale baseline entries, so the file gets pruned', () => {
  // Without this the baseline only ever grows, and a stale acknowledgement is a
  // standing exemption for a sha that may be reused by nothing — but the file
  // stops describing reality, and the next reader cannot tell what is live.
  const r = classifyUnreachableWork(
    measure({ unreachable: [], sourceOnlyPaths: [], baseline: BASELINE }),
  );
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.staleBaselineCommits.sort(), [KNOWN_A, KNOWN_B].sort());
  assert.deepEqual(r.staleBaselinePaths.sort(), ['lib/known.js', 'server.js'].sort());
  assert.match(r.message, /no longer apply/);
});

test('s0qMA0O7 — NO baseline means everything counts as new (it must not fail OPEN)', () => {
  // A missing/garbled file must not read as "nothing is acknowledged, all clear".
  // ⚠️ The non-iterable shapes are the ones that matter and the ones a mutation
  // probe caught me missing: a hand-edited baseline whose `commits` is an OBJECT
  // makes a naive `new Set(b.commits)` THROW, which takes the whole alarm down
  // rather than degrading to "nothing acknowledged". A detector that crashes on
  // its own config file is not fail-safe, it is just off.
  for (const b of [
    undefined,
    null,
    {},
    { commits: 'nope' },
    { commits: [null, 7] },
    { commits: {} },
    { commits: 42, paths: {} },
    { commits: { '0': 'x' }, paths: 'lib/known.js' },
  ]) {
    let r;
    assert.doesNotThrow(() => {
      r = classifyUnreachableWork(measure({ unreachable: backlog, sourceOnlyPaths: [], baseline: b }));
    }, `baseline ${JSON.stringify(b)} must degrade, never throw`);
    assert.equal(r.verdict, 'alarm', `baseline ${JSON.stringify(b)} must not silently acknowledge anything`);
    assert.equal(r.newProductCommits.length, 2);
  }
});

test('s0qMA0O7 — cannot-verify still outranks the baseline', () => {
  // The baseline changes WHICH unreachable work alarms. It must never be able to
  // turn "I could not measure" into a pass — that is the older, worse failure.
  const r = classifyUnreachableWork(
    measure({ targetSha: null, unreachable: backlog, sourceOnlyPaths: [], baseline: BASELINE }),
  );
  assert.equal(r.verdict, 'cannot-verify');
  assert.equal(r.alarm, true);
});

test('s0qMA0O7 — the committed baseline file is real, and matches the shape the lib reads', () => {
  // Guards the seam between the generator and the consumer: a baseline that
  // parses but carries no entries would silently alarm on the whole backlog.
  const b = require('../divergence-baseline.json');
  assert.equal(b.source, 'main');
  assert.equal(b.target, 'real-app');
  assert.ok(Array.isArray(b.commits) && b.commits.length > 10, `baseline has ${b.commits && b.commits.length} commits`);
  assert.ok(Array.isArray(b.paths) && b.paths.length > 10, `baseline has ${b.paths && b.paths.length} paths`);
  assert.ok(b.commits.every((s) => /^[0-9a-f]{40}$/.test(s)), 'every baselined commit is a full sha');
  assert.match(b.acknowledgedAt, /^\d{4}-\d{2}-\d{2}$/);
});
