'use strict';
// Card eKfog19I — [PATTERN] every dispatchable deploy workflow accepted an
// ARBITRARY ref, and a wrong-ref run reports SUCCESS on a rollback.
//
// Card LEBxGF5d / PR #67 closed ONE of the three (deploy-realapp.yml, PROD).
// This suite covers the other two and, more importantly, makes the "3 of 3"
// MECHANICAL: the policy is checked against a DISCOVERED set of workflows, not
// against a hand-written list, so a fourth dispatchable deploy workflow added
// later fails here instead of quietly reopening the class.
//
// THE STATE THIS REPLACES, measured on the live refs before a line changed:
//
//   git rev-list --left-right --count origin/main...origin/real-app  ->  41  14
//   git merge-base --is-ancestor origin/main origin/real-app         ->  rc 1
//   git diff --stat origin/main origin/real-app -- agents/
//       agents/builder_agents/agent.py | 65 +--
//       agents/builder_agents/tools.py | 94 ---
//       2 files changed, 3 insertions(+), 156 deletions(-)
//
// ⚠️ AND THE ONE THING THIS SUITE CANNOT ASSERT, said out loud rather than
// implied: `workflow_dispatch` runs the workflow file FROM THE DISPATCHED REF.
// deploy.yml and deploy-engine.yml expect `main`, so their worst ref is
// `real-app` — and a dispatch on `real-app` runs real-app's copy of the file,
// which has no guard until this is forward-ported. What the guard on `main`
// DOES cover is the common wrong-ref: any unmerged branch cut from main (a
// `card/*` tip is not an ancestor of main, so it is refused). That is a real,
// frequent mistake — dispatching a deploy from unreviewed code — and it is
// caught. The scope is written into lib/deployRefPolicy.js too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  DEPLOY_REF_POLICY,
  EXPECTED_REF,
  refDeployVerdict,
} = require('../lib/deployRefPolicy');

const REPO = path.join(__dirname, '..');
const WF_DIR = path.join(REPO, '.github', 'workflows');

/** Source with whole-line `#` comments removed. */
const strip = (raw) =>
  raw
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const readWf = (file) => strip(fs.readFileSync(path.join(WF_DIR, file), 'utf8'));

/** The top-level `on:` block only — never the whole file. */
function onBlock(stripped) {
  const m = /^on:.*?(?=^[A-Za-z])/ms.exec(stripped);
  return m ? m[0] : '';
}

const DEPLOY_VERBS =
  /gcloud run deploy|gcloud builds submit|firebase deploy|deploy_agent_engine\.py|hosting:channel:deploy/;

/**
 * ⚠️ THIS FILE IS THE `real-app` COPY. Card OtEgCdjR.
 *
 * `workflow_dispatch` resolves the workflow FILE from the ref the operator
 * picks, so a guard only ever runs on the branch it is committed to. main's
 * copies therefore guard main's dispatches and nothing else. This branch is
 * being brought up one workflow at a time, and the split is written down
 * rather than left as a shape the suite silently tolerates.
 *
 * GUARDED may only GROW. When a workflow moves across, its own tests below
 * start applying to it and `the UNGUARDED set is exactly what we think`
 * REDS until this table is updated — so closing the gap cannot be done
 * quietly, and neither can widening it.
 */
const GUARDED = new Set(['deploy-engine.yml']);

/**
 * Not yet guarded ON THIS BRANCH, measured 2026-09-08.
 *
 * ⚠️ `deploy-realapp.yml` is the PROD rail and its policy expectedRef IS
 * `real-app` — so the guard main carries for it can only ever run on a ref it
 * would refuse, and every legitimate PROD dispatch runs THIS unguarded copy.
 * That is a wider hole than the one card OtEgCdjR closes and is filed
 * separately; it is out of scope here only because this PR keeps one workflow
 * per change.
 */
const UNGUARDED_ON_THIS_BRANCH = ['deploy-realapp.yml', 'deploy.yml'];

test('the UNGUARDED set is exactly what we think — closing the gap cannot be silent', () => {
  const rows = Object.keys(DEPLOY_REF_POLICY).sort();
  assert.deepEqual([...GUARDED, ...UNGUARDED_ON_THIS_BRANCH].sort(), rows,
    'every policy row must be either guarded here or listed as a known gap');
  for (const f of UNGUARDED_ON_THIS_BRANCH) {
    assert.doesNotMatch(readWf(f), /refDeployVerdict/,
      `${f} now calls the guard — move it into GUARDED and delete it from the gap list`);
  }
  for (const f of GUARDED) {
    assert.match(readWf(f), /refDeployVerdict/, `${f} is listed as guarded but does not call the guard`);
  }
});

/**
 * Every workflow that is BOTH dispatchable and deploys something.
 * Discovered from disk, deliberately, never listed here.
 */
function discoverDispatchableDeployWorkflows() {
  return fs
    .readdirSync(WF_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .filter((f) => {
      const s = readWf(f);
      return /workflow_dispatch\s*:/.test(onBlock(s)) && DEPLOY_VERBS.test(s);
    })
    .sort();
}

// ── 1. THE DECISION, generalised — one decision, three call sites ───────────

test('the expected ref is an ARGUMENT now, and the message names the right one', () => {
  // PR #67's decision hardcoded `real-app`. Reused as-is on deploy.yml it would
  // have told an operator on a wrong ref to "re-dispatch with ref real-app" —
  // the exact opposite of correct for the staging tier. A shared decision has
  // to carry the ref, or the second call site quietly ships a wrong remedy.
  const v = refDeployVerdict(1, { dispatchedRef: 'real-app', expectedRef: 'main', tier: 'STAGING' });
  assert.equal(v.verdict, 'refuse');
  assert.match(v.message, /Re-dispatch with ref "main"/);
  assert.match(v.message, /deploys STAGING/);
  assert.doesNotMatch(v.message, /real-app\./, 'must not name real-app as the ref to use');
});

test('BACK-COMPAT: with no expectedRef it still answers exactly as PR #67 did', () => {
  // deploy-realapp.yml's call site passes only dispatchedRef. Its fifteen tests
  // in test/realapp-ref-guard.test.js pin the old strings; this pins that the
  // default path is the real-app policy rather than something new.
  const v = refDeployVerdict(1, { dispatchedRef: 'main' });
  assert.match(v.message, /Re-dispatch with ref "real-app"/);
  assert.equal(EXPECTED_REF, 'real-app');
  assert.equal(EXPECTED_REF, DEPLOY_REF_POLICY['deploy-realapp.yml'].expectedRef);
});

test('cannot-verify stays DISTINCT from refuse for a non-default ref too', () => {
  // The cry-wolf half has to survive generalisation: on a shallow clone every
  // dispatch, including a correct one, exits 128, and collapsing that into
  // "refuse" produces a red that accuses a ref which is fine.
  const shallow = refDeployVerdict(128, { dispatchedRef: 'main', expectedRef: 'main' });
  assert.equal(shallow.verdict, 'cannot-verify');
  assert.doesNotMatch(shallow.message, /REFUSED/);
  assert.match(shallow.message, /fetch-depth: 0/);
  assert.match(shallow.message, /against main/);
});

test('an ABSENT exit code is cannot-verify for every policy row, never allow', () => {
  for (const [file, p] of Object.entries(DEPLOY_REF_POLICY)) {
    for (const bad of [undefined, null, '', 'nope', NaN, true, false]) {
      const v = refDeployVerdict(bad, { expectedRef: p.expectedRef, tier: p.tier });
      assert.equal(v.allow, false, `${file}: exit ${String(bad)} must not allow a deploy`);
      assert.equal(v.verdict, 'cannot-verify');
    }
  }
});

// ── 2. THE PATTERN, MECHANICAL — this is the half that keeps the class shut ──

test('every DISPATCHABLE DEPLOY workflow on disk has a policy row', () => {
  const found = discoverDispatchableDeployWorkflows();
  // VACUITY FLOOR: a broken predicate would discover nothing and this whole
  // section would be trivially true — "no unguarded workflow" is equally true
  // of a directory the scan cannot read.
  assert.ok(found.length >= 3, `discovery found only ${found.length} workflow(s): ${found}`);
  for (const f of found) {
    assert.ok(
      DEPLOY_REF_POLICY[f],
      `${f} is dispatchable and deploys, but has no row in DEPLOY_REF_POLICY — ` +
        'card eKfog19I measured 3 of 3; a 4th must be a deliberate decision, not a default.',
    );
  }
});

test('...and the policy carries no STALE row for a workflow that is gone', () => {
  const found = new Set(discoverDispatchableDeployWorkflows());
  for (const f of Object.keys(DEPLOY_REF_POLICY)) {
    assert.ok(found.has(f), `DEPLOY_REF_POLICY names ${f}, which is no longer a dispatchable deploy workflow`);
  }
});

test('a workflow that only DEPLOYS, or only DISPATCHES, is correctly left out', () => {
  // The cry-wolf control. preview.yml deploys (gcloud builds submit) but fires
  // on pull_request only, so no operator picks its ref; ci.yml is neither.
  // Without this, widening the predicate to "deploys" alone would demand a
  // policy row for every preview build and the guard would be switched off.
  const found = discoverDispatchableDeployWorkflows();
  assert.ok(!found.includes('preview.yml'), 'preview.yml is not dispatchable — no ref to pick');
  assert.ok(!found.includes('ci.yml'));
  const preview = readWf('preview.yml');
  assert.match(preview, DEPLOY_VERBS, 'preview.yml really does deploy — so the exclusion is the DISPATCH half doing the work');
});

test('THE CARD\'S OWN SELF-CATCH: triggers are counted with comments STRIPPED', () => {
  // The card records a miscount: a first sweep grepped deploy.yml for
  // `workflow_dispatch` and hit the TIER-MAP COMMENT describing a DIFFERENT
  // file's trigger. deploy.yml is genuinely dispatchable, so the conclusion
  // survived — by luck, holding the right answer for the wrong reason.
  // Re-pointed to deploy-engine.yml: on THIS branch that is the file whose
  // comments discuss its own trigger, so it is where the trap reproduces.
  const rawDeploy = fs.readFileSync(path.join(WF_DIR, 'deploy-engine.yml'), 'utf8');
  assert.ok(
    /^\s*#.*workflow_dispatch/m.test(rawDeploy),
    'deploy-engine.yml no longer carries a commented workflow_dispatch — ' +
      'if it was removed, this test is no longer reproducing the trap and should be re-pointed',
  );
  // The miscount, reproduced as arithmetic rather than described: a whole-file
  // grep OVER-COUNTS, and the on:-block extraction is what makes the count mean
  // something. If these two are ever equal, this file no longer reproduces the
  // trap and the assertion below is measuring nothing.
  const wholeFileHits = (rawDeploy.match(/workflow_dispatch/g) || []).length;
  const onBlockHits = (onBlock(strip(rawDeploy)).match(/workflow_dispatch/g) || []).length;
  assert.equal(onBlockHits, 1, 'deploy-engine.yml declares exactly one workflow_dispatch trigger');
  assert.ok(
    wholeFileHits > onBlockHits,
    `a whole-file grep must over-count (${wholeFileHits} vs ${onBlockHits}) or this test proves nothing`,
  );
  // ...and the extras are on COMMENT lines — which is what made the original
  // miscount look like a finding. (main's copy asserts a specific comment
  // naming deploy-realapp.yml; that text is main's, so the PROPERTY is
  // asserted here instead of the sentence.)
  const commentHits = rawDeploy
    .split('\n')
    .filter((l) => /^\s*#/.test(l) && /workflow_dispatch/.test(l)).length;
  assert.ok(commentHits >= 1, 'the over-count must come from comments, or this test proves nothing');
  assert.equal(wholeFileHits - onBlockHits, commentHits);
});

test('VACUITY: the stripper removes comment lines and NOTHING else', () => {
  // The floor under every wiring assertion in this file. It started as
  // "still long, still has jobs: and on:" and a probe (P15) walked straight
  // through it: a stripper mutilated to drop every line containing `#` AND
  // every blank line left the whole suite GREEN, because nothing measured what
  // it had removed — only that something survived. A stripper that eats code
  // does not fail loudly; it makes every source assertion above pass on a file
  // that is no longer the file.
  for (const f of ['deploy.yml', 'deploy-engine.yml', 'deploy-realapp.yml']) {
    const rawLines = fs.readFileSync(path.join(WF_DIR, f), 'utf8').split('\n');
    const comments = rawLines.filter((l) => /^\s*#/.test(l)).length;
    const strippedLines = readWf(f).split('\n');
    assert.ok(comments > 0, `${f}: no comment lines — this floor would be vacuous`);
    assert.equal(
      strippedLines.length,
      rawLines.length - comments,
      `${f}: the stripper removed something other than whole-line comments`,
    );
    assert.match(readWf(f), /^jobs:/m, `${f}: jobs: block was eaten by the stripper`);
    assert.match(readWf(f), /^on:/m, `${f}: on: block was eaten by the stripper`);
  }
});

test('...and stripping is DEFENCE IN DEPTH here, not the half doing the work', () => {
  // Measured rather than assumed, because "an assertion a COMMENT can satisfy"
  // is this fleet's most-repeated finding and it is easy to claim the fix for
  // it without checking. TODAY no comment in these files can satisfy any wiring
  // assertion above: none of them carries a quoted ref name or a
  // refDeployVerdict call. So the STRIPPER is insurance and the exact-line-count
  // floor above is what actually holds. If this ever flips — a comment quoting
  // the guard's own code, say — this test fails and the file stops overclaiming.
  for (const f of ['deploy.yml', 'deploy-engine.yml', 'deploy-realapp.yml']) {
    const commentsOnly = fs
      .readFileSync(path.join(WF_DIR, f), 'utf8')
      .split('\n')
      .filter((l) => /^\s*#/.test(l))
      .join('\n');
    assert.doesNotMatch(commentsOnly, /refDeployVerdict/, `${f}: a comment now names the call — stripping just became load-bearing`);
    assert.doesNotMatch(commentsOnly, /['"](main|real-app)['"]/, `${f}: a comment now quotes a ref name — stripping just became load-bearing`);
  }
});

// ── 3. THE WIRING — a decision nothing calls is a seam with no consumer ──────

test('each GUARDED workflow actually CALLS the decision, with its own ref', () => {
  for (const file of GUARDED) {
    const p = DEPLOY_REF_POLICY[file];
    const s = readWf(file);
    assert.match(s, /refDeployVerdict/, `${file}: must call the tested decision by name`);
    {
      assert.ok(
        s.includes(`DEPLOY_REF_POLICY['${file}'].expectedRef`),
        `${file}: must READ its expected ref from the policy, not re-type it`,
      );
      assert.ok(
        s.includes(`DEPLOY_REF_POLICY["${file}"]`),
        `${file}: the verdict call must select this workflow's own policy row`,
      );
      // The literal must not appear as a second source of truth. Caught by a
      // probe on PR #67, not reasoned about: an assertion of merely "the module
      // is required" is satisfied by the require line alone, so a hardcoded ref
      // beside it stayed fully green.
      const guardBlock = s.slice(s.indexOf('Refuse a dispatch on any ref'), s.indexOf('google-github-actions/auth@v2'));
      assert.ok(guardBlock.length > 0, `${file}: guard block not found before auth`);
      assert.doesNotMatch(
        guardBlock.replace(/DEPLOY_REF_POLICY\[[^\]]*\]/g, ''),
        new RegExp(`['"]${p.expectedRef}['"]`),
        `${file}: the guard must not carry its own literal copy of "${p.expectedRef}"`,
      );
    }
  }
});

test('the guard runs BEFORE auth and BEFORE any deploy, in every guarded workflow', () => {
  for (const file of GUARDED) {
    const s = readWf(file);
    const guard = s.indexOf('Refuse a dispatch on any ref');
    const auth = s.indexOf('google-github-actions/auth@v2');
    // indexOf returns -1 when absent, and -1 is less than any real position, so
    // "guard before deploy" would be satisfied by there being NO deploy at all.
    // Presence is asserted first, deliberately.
    assert.ok(guard > -1, `${file}: no guard step`);
    assert.ok(auth > -1, `${file}: no auth step`);
    assert.ok(guard < auth, `${file}: the guard must not run after credentials are minted`);
    const deployAt = s.search(DEPLOY_VERBS);
    assert.ok(deployAt > -1, `${file}: no deploy verb`);
    assert.ok(guard < deployAt, `${file}: the guard must not run after the deploy has started`);
  }
});

test('checkout uses fetch-depth: 0 in every guard job — without it the guard can never answer', () => {
  for (const file of GUARDED) {
    const s = readWf(file);
    const checkout = s.indexOf('actions/checkout@v4');
    const guard = Math.max(s.indexOf('Refuse a dispatch on any ref'), s.indexOf('Refuse any ref that is not'));
    assert.ok(checkout > -1 && guard > checkout, `${file}: checkout must precede the guard`);
    assert.match(s.slice(checkout, guard), /fetch-depth:\s*0/, `${file}: guard checkout is shallow`);
  }
});

test('the exit code is captured with `|| rc=$?`, never left to `bash -e`', () => {
  for (const file of GUARDED) {
    assert.match(readWf(file), /\|\|\s*rc=\$\?/, `${file}`);
  }
});

test('the dispatched ref reaches the shell through env:, not inline interpolation', () => {
  for (const file of GUARDED) {
    const s = readWf(file);
    const block = s.slice(s.indexOf('Refuse a dispatch on any ref'), s.indexOf('google-github-actions/auth@v2'));
    assert.match(block, /REF_NAME:\s*\$\{\{\s*github\.ref_name\s*\}\}/, file);
    assert.match(block, /process\.env\.REF_NAME/, file);
    const runBody = block.slice(block.indexOf('run: |'));
    assert.doesNotMatch(
      runBody,
      /\$\{\{\s*github\.ref_name\s*\}\}/,
      `${file}: a branch name may contain $ and backticks — inline interpolation is a command-substitution sink`,
    );
  }
});

// ── 4. the job shape on THIS branch ─────────────────────────────────────────
// main's deploy.yml carries its guard as a SEPARATE `ref-guard` job that other
// jobs `needs:`, and main's copy of this file asserts that topology. Neither
// workflow on `real-app` has that shape — the guard here is the first STEP of
// the one job that deploys — so those two assertions are re-pointed rather
// than deleted: the PROPERTY they protect (a guard that can be skipped while
// the run stays green) applies to a step-guard too.

test('the guard job carries no job-level `if:` — a skipped job skips its dependents', () => {
  // The load-bearing one, and the card names it explicitly. Gating the JOB
  // would make it SKIP, and GitHub skips any job that `needs:` a skipped job —
  // so a run could show no failure while the guard never executed. With the
  // guard as a step of the deploying job, a job-level `if:` would skip the
  // guard AND the deploy together, which is safe but silent; the rule stands
  // either way, and it is cheap to keep it asserted.
  for (const file of GUARDED) {
    const s = readWf(file);
    const jobsAt = s.indexOf('jobs:');
    assert.ok(jobsAt > -1, `${file}: no jobs block`);
    const jobs = s.slice(jobsAt);
    assert.doesNotMatch(jobs, /^ {4}if:/m, `${file}: no job in this workflow may be job-level if:-gated`);
  }
});

test('the guard is the FIRST thing the deploying job does after checkout', () => {
  // A guard beside the deploy stops only what runs after it. On this branch
  // there is one job, so "before auth and before the deploy verb" (asserted
  // above) plus "nothing else runs between checkout and the guard except the
  // checkout itself" is the equivalent of main's `needs: ref-guard`.
  for (const file of GUARDED) {
    const s = readWf(file);
    const checkout = s.indexOf('actions/checkout@v4');
    const guard = s.indexOf('Refuse a dispatch on any ref');
    assert.ok(checkout > -1 && guard > checkout, `${file}: checkout must precede the guard`);
    const between = s.slice(checkout, guard);
    assert.doesNotMatch(between, /- (uses|name):[^\n]*(auth@v2|setup-gcloud|setup-python|run deploy)/,
      `${file}: nothing may run between checkout and the guard`);
  }
});

test('lib/realappRefGuard.js is ABSENT on this branch — and that is the gap, not an oversight', () => {
  // main carries it as PR #67's call site for deploy-realapp.yml's guard. That
  // guard is not on this branch (see UNGUARDED_ON_THIS_BRANCH), so the module
  // would be dead code here. Asserted rather than assumed: if someone ports
  // the PROD guard across, this REDS and forces them to bring the module and
  // to move deploy-realapp.yml into GUARDED in the same change.
  const at = path.join(REPO, 'lib', 'realappRefGuard.js');
  assert.equal(fs.existsSync(at), false,
    'lib/realappRefGuard.js appeared — port deploy-realapp.yml\'s guard with it and update GUARDED');
  // ...and the one decision that IS here is the shared one, not a copy.
  const src = fs.readFileSync(path.join(REPO, 'lib', 'deployRefPolicy.js'), 'utf8');
  assert.match(src, /function\s+refDeployVerdict/, 'the decision must live in deployRefPolicy.js on this branch');
});

// ── 5. THE NEGATIVE TESTS THE CARD ASKS FOR, ON THE REAL REPOSITORY ──────────

const have = (ref) =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: REPO }).status === 0;
const resolve = (name) => [`refs/remotes/origin/${name}`, name].find(have);

test('CI gives the real-ref tests the history they need — or they pass on nothing', () => {
  // Found by reading the CI log rather than the check mark. On run 32849680329
  // the two tests below, and card LEBxGF5d's, all printed
  //     SKIP: need both main and real-app (shallow clone?)
  // and PASSED — `ci.yml`'s checkout was depth-1, so the runner had no
  // `real-app` ref. Three green ticks that measured nothing, on the exact
  // assertion both cards call the point of the exercise: "a negative test on a
  // genuinely wrong ref, not a fixture".
  //
  // The SKIP itself is correct and stays — a fork or a shallow local clone must
  // not be red for an environment reason. What must not be silent is CI sitting
  // in it permanently. So the depth is asserted HERE, where removing it reds
  // loudly, instead of turning the skip into a failure and crying wolf on
  // everyone else.
  // Re-pointed for this branch: `real-app` has no ci.yml at all — its suite
  // runs from ci-realapp.yml (card K5YgkNtO). Measured 2026-09-08, that job's
  // checkout was SHALLOW, so the two real-git tests below would have taken the
  // SKIP path and passed on nothing here exactly as they did on run
  // 32849680329. `fetch-depth: 0` is added to it in this same commit.
  const ci = readWf('ci-realapp.yml');
  const testJob = ci.slice(ci.indexOf('  test:'), ci.indexOf('  workflows:'));
  assert.ok(testJob.length > 0, 'ci-realapp.yml test job not found');
  assert.match(
    testJob,
    /actions\/checkout@v4\n\s+with:\n\s+fetch-depth:\s*0/,
    'ci-realapp.yml test job must checkout with fetch-depth: 0, or the real-ref tests below skip and pass on nothing',
  );
});

test('NEGATIVE TEST: real `real-app` is genuinely not on the main line', () => {
  // "Prove it on a ref that is genuinely wrong, not on a synthetic one."
  // Skipped LOUDLY where the refs are absent (shallow clone, fork) — the
  // decision table above is fully covered regardless.
  const mainRef = resolve('main');
  const appRef = resolve('real-app');
  if (!mainRef || !appRef) {
    console.log('SKIP: need both main and real-app locally (shallow clone?)');
    return;
  }
  const rc = spawnSync('git', ['merge-base', '--is-ancestor', appRef, mainRef], { cwd: REPO }).status;
  const p = DEPLOY_REF_POLICY['deploy.yml'];
  const v = refDeployVerdict(rc, { dispatchedRef: 'real-app', expectedRef: p.expectedRef, tier: p.tier });
  // Not asserting rc === 1 outright: if card xe1q8uHa reconciles the branches,
  // real-app BECOMES a legitimate ancestor and this must not cry wolf. What is
  // pinned is that the verdict tracks the real git answer.
  if (rc === 0) {
    assert.equal(v.allow, true, 'real-app is now on the main line — a dispatch on it would be legitimate');
  } else {
    assert.equal(v.allow, false, 'real-app is not on the main line, so a dispatch on it must be REFUSED');
    assert.equal(v.verdict, 'refuse');
    assert.match(v.message, /Re-dispatch with ref "main"/);
  }
});

test('THE ENGINE ROW IS A MEASUREMENT: agents/ on real-app is behind main', () => {
  // This is WHY deploy-engine.yml expects `main` rather than "either branch is
  // probably fine". An engine minted from real-app would be short the
  // Dana/Remy/Kai sub-agent split, and its RESOURCE_NAME would then be pinned.
  const mainRef = resolve('main');
  const appRef = resolve('real-app');
  if (!mainRef || !appRef) {
    console.log('SKIP: need both main and real-app locally (shallow clone?)');
    return;
  }
  // ⚠️ THIS ASSERTION IS DERIVED FROM THE POLICY, NOT WRITTEN BESIDE IT — and
  // that is the whole point. A probe (P12) flipped this row's expectedRef from
  // `main` to `real-app` and the entire suite stayed GREEN: the drift was
  // measured, and nothing connected the measurement to the CHOICE. Flipped, the
  // guard would refuse `main` dispatches and ALLOW `real-app` ones — minting
  // engines from a crew missing the Dana/Remy/Kai split, which is precisely the
  // outcome this row exists to prevent, reached through the row itself.
  const expected = DEPLOY_REF_POLICY['deploy-engine.yml'].expectedRef;
  const other = expected === 'main' ? 'real-app' : 'main';
  const expectedRefPath = resolve(expected);
  const otherRefPath = resolve(other);
  if (!expectedRefPath || !otherRefPath) {
    console.log(`SKIP: need both ${expected} and ${other} locally (shallow clone?)`);
    return;
  }
  const out = spawnSync(
    'git',
    ['diff', '--numstat', expectedRefPath, otherRefPath, '--', 'agents/', 'scripts/deploy_agent_engine.py'],
    { cwd: REPO, encoding: 'utf8' },
  );
  assert.equal(out.status, 0, 'git diff --numstat failed');
  const rows = out.stdout.trim().split('\n').filter(Boolean);
  if (rows.length === 0) {
    // A forward-port landed and the branches agree on the crew. The policy row
    // is then merely conservative rather than load-bearing — correct, and NOT a
    // reason to red.
    console.log(`NOTE: agents/ now agrees across ${expected} and ${other} — the engine policy row is conservative, not urgent.`);
    return;
  }
  // additions = lines `other` has that `expected` lacks; deletions = the reverse.
  const additions = rows.reduce((n, r) => n + Number(r.split('\t')[0] || 0), 0);
  const deletions = rows.reduce((n, r) => n + Number(r.split('\t')[1] || 0), 0);
  assert.ok(
    deletions > additions,
    `deploy-engine.yml names "${expected}" as the ref that owns the crew definition, but ` +
      `"${other}" is AHEAD of it there (+${additions} / -${deletions} on agents/). ` +
      'An engine minted from the ref this policy names would be missing crew code, and its ' +
      'RESOURCE_NAME would then be pinned into the app env. Re-decide the row deliberately.',
  );
});
