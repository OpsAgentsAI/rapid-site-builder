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
const GUARDED = new Set(['deploy-engine.yml', 'deploy-realapp.yml', 'deploy.yml']);

/**
 * ⚠️ EMPTY AS OF THE 2026-09-15 RECONCILE (card XUCfQGz6, issue #70) — and the
 * table above GREW rather than this one shrinking quietly, which is the
 * property the test below defends.
 *
 * `deploy.yml` sat here because the guard for it lived only on `main`. The
 * reconcile carries main's `deploy.yml` onto this branch, and that copy calls
 * `refDeployVerdict` through `DEPLOY_REF_POLICY['deploy.yml']` — measured, not
 * assumed. So the gap closed as a side effect of the merge, the guard test RED
 * on arrival exactly as designed ("deploy.yml now calls the guard — move it
 * into GUARDED"), and this is that move.
 *
 * An empty gap list is not a finish line: a new dispatchable deploy workflow
 * still has to be added to a policy row and to GUARDED, or `every DISPATCHABLE
 * DEPLOY workflow on disk has a policy row` reds first.
 */
const UNGUARDED_ON_THIS_BRANCH = [];

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
  // The cry-wolf control. Card vpukxEgQ (09PBYCJY rule 2) made preview.yml
  // dispatchable — it used to be this test's "only deploys" example, on the
  // reasoning that it fired on pull_request only and no operator picked its
  // ref. That reasoning no longer holds, which is exactly the card's point:
  // preview.yml now belongs in the discovered set (and has a policy row, see
  // the tests above) rather than being excluded by it. divergence-alarm.yml is
  // the "only dispatches" example instead: workflow_dispatch, but no deploy
  // verb anywhere in it. ci.yml remains neither.
  const found = discoverDispatchableDeployWorkflows();
  assert.ok(found.includes('preview.yml'),
    'preview.yml is dispatchable AND deploys since card vpukxEgQ — it must now be discovered, not excluded');
  assert.ok(!found.includes('divergence-alarm.yml'), 'divergence-alarm.yml is dispatchable but deploys nothing');
  assert.ok(!found.includes('ci.yml'));
  const alarm = readWf('divergence-alarm.yml');
  assert.doesNotMatch(alarm, DEPLOY_VERBS, 'divergence-alarm.yml really does not deploy — so the exclusion is the DEPLOY half doing the work');
});

test('THE CARD\'S OWN SELF-CATCH: triggers are counted with comments STRIPPED', () => {
  // The card records a miscount: a first sweep grepped deploy.yml for
  // `workflow_dispatch` and hit the TIER-MAP COMMENT describing a DIFFERENT
  // file's trigger. deploy.yml is genuinely dispatchable, so the conclusion
  // survived — by luck, holding the right answer for the wrong reason.
  const rawDeploy = fs.readFileSync(path.join(WF_DIR, 'deploy.yml'), 'utf8');
  assert.ok(
    /^\s*#.*workflow_dispatch/m.test(rawDeploy),
    'deploy.yml no longer carries the comment that produced the miscount — ' +
      'if it was removed, this test is no longer reproducing the trap and should be re-pointed',
  );
  // The miscount, reproduced as arithmetic rather than described: a whole-file
  // grep OVER-COUNTS, and the on:-block extraction is what makes the count mean
  // something. If these two are ever equal, this file no longer reproduces the
  // trap and the assertion below is measuring nothing.
  const wholeFileHits = (rawDeploy.match(/workflow_dispatch/g) || []).length;
  const onBlockHits = (onBlock(strip(rawDeploy)).match(/workflow_dispatch/g) || []).length;
  assert.equal(onBlockHits, 1, 'deploy.yml declares exactly one workflow_dispatch trigger');
  assert.ok(
    wholeFileHits > onBlockHits,
    `a whole-file grep must over-count (${wholeFileHits} vs ${onBlockHits}) or this test proves nothing`,
  );
  // ...and at least one of the extras describes a DIFFERENT file's trigger,
  // which is what made the original miscount look like a finding.
  assert.match(rawDeploy, /^\s*#.*deploy-realapp\.yml/m);
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

test('each policy row is actually CALLED by its workflow, with its own ref', () => {
  for (const [file, p] of Object.entries(DEPLOY_REF_POLICY)) {
    const s = readWf(file);
    assert.match(s, /refDeployVerdict/, `${file}: must call the tested decision by name`);
    {
      // ⚠️ RECONCILE 2026-09-15 (card XUCfQGz6, issue #70). `deploy-realapp.yml`
      // used to be special-cased here because PR #67's call site on `main` read
      // `EXPECTED_REF` from the realappRefGuard shim. On THIS branch card
      // 22I0yUum (#85) rewrote that call site to read its ref from
      // DEPLOY_REF_POLICY, so the special case asserted a call shape that no
      // longer exists and the generic branch below is now the correct — and
      // stricter — assertion for every row. Deleting the exception is the point:
      // it also brings deploy-realapp.yml under the no-literal-copy check.
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

test('the guard runs BEFORE auth and BEFORE any deploy, in both new workflows', () => {
  for (const file of ['deploy.yml', 'deploy-engine.yml']) {
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
  for (const file of Object.keys(DEPLOY_REF_POLICY)) {
    const s = readWf(file);
    const checkout = s.indexOf('actions/checkout@v4');
    const guard = Math.max(s.indexOf('Refuse a dispatch on any ref'), s.indexOf('Refuse any ref that is not'));
    assert.ok(checkout > -1 && guard > checkout, `${file}: checkout must precede the guard`);
    assert.match(s.slice(checkout, guard), /fetch-depth:\s*0/, `${file}: guard checkout is shallow`);
  }
});

test('the exit code is captured with `|| rc=$?`, never left to `bash -e`', () => {
  for (const file of Object.keys(DEPLOY_REF_POLICY)) {
    assert.match(readWf(file), /\|\|\s*rc=\$\?/, `${file}`);
  }
});

test('the dispatched ref reaches the shell through env:, not inline interpolation', () => {
  for (const file of ['deploy.yml', 'deploy-engine.yml']) {
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

// ── 4. deploy.yml — the push:main path must stay UNAFFECTED ──────────────────

test('the ref-guard JOB carries no job-level `if:` — a skipped job skips its dependents', () => {
  // The load-bearing one. Gating the JOB on workflow_dispatch would make it
  // SKIP on every push to main, and GitHub skips any job that `needs:` a
  // skipped job — so merges would silently stop deploying with no failure
  // anywhere. The event check belongs on the STEPS, where a skip is inert.
  const s = readWf('deploy.yml');
  const job = s.slice(s.indexOf('  ref-guard:'), s.indexOf('  deploy-staging:'));
  assert.ok(job.length > 0, 'ref-guard job not found');
  assert.doesNotMatch(job, /^ {4}if:/m, 'ref-guard must not be job-level if:-gated');
  // ...and the step-level gate IS present, or the guard would run on pushes and
  // spend a full-history clone deciding a question that has no content there.
  assert.match(job, /if: github\.event_name == 'workflow_dispatch'/);
  assert.match(job, /if: github\.event_name != 'workflow_dispatch'/, 'the push path must say so out loud, not log nothing');
});

test('both deploy jobs depend on the guard — a guard beside them stops only one', () => {
  const s = readWf('deploy.yml');
  for (const job of ['deploy-staging', 'deploy-app-staging']) {
    const at = s.indexOf(`  ${job}:`);
    assert.ok(at > -1, `job ${job} missing`);
    const head = s.slice(at, at + 400);
    assert.match(head, /needs: ref-guard/, `${job} must not deploy without the guard`);
  }
});

test('a guard STEP may be scoped to dispatches, and NOTHING else [reconcile XUCfQGz6]', () => {
  // Moved here from test/realapp-ref-guard.test.js, which asserted a flat "no
  // `if:`" for deploy-realapp.yml alone. Retargeting that copy at #85's call-site
  // shape would have kept two shape suites drifting apart, so the property is
  // stated once, over every GUARDED workflow.
  //
  // ⚠️ AND THE FLAT VERSION IS WRONG ONCE IT IS GENERALISED — measured, not
  // reasoned: the first draft of this test RED on `deploy.yml`, whose guard does
  // carry `if: github.event_name == 'workflow_dispatch'`. That is correct there
  // and not a hole: deploy.yml also fires on `push: main`, where the ref IS main
  // by construction and there is nothing to refuse. deploy-realapp.yml is
  // dispatch-only, so any `if:` on its guard is a live off-switch. One rule that
  // covers both: the guard may be narrowed to dispatches and to nothing else.
  for (const file of GUARDED) {
    const src = readWf(file);
    const start = src.indexOf('Refuse a dispatch on any ref');
    assert.ok(start > -1, `${file}: guard step not found`);
    const nxt = src.indexOf('\n      - ', start);
    const step = src.slice(start, nxt > -1 ? nxt : undefined);
    const cond = /^\s{8}if:\s*(.+)$/m.exec(step);
    const dispatchOnly = !/^\s{2}(push|pull_request|schedule):/m.test(onBlock(src));
    if (dispatchOnly) {
      assert.equal(cond, null,
        `${file} is dispatch-only, so an if: on its guard is a live off-switch: ${cond && cond[1]}`);
    } else if (cond) {
      assert.equal(cond[1].trim(), "github.event_name == 'workflow_dispatch'",
        `${file}: the guard may be scoped to dispatches and nothing else`);
    }
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

test('ONE decision module — the shim may exist, but only as a re-export [reconcile XUCfQGz6]', () => {
  // ⚠️ THIS TEST REPLACES #85's `lib/realappRefGuard.js is STILL absent`, and the
  // replacement is the event that test was written for. Its own words: *"this now
  // guards a different property: not 'the gap is still open' but 'the gap was
  // closed WITHOUT growing a second source of truth'. If someone later ports the
  // module across, this REDS and asks them to justify two."*
  //
  // The reconcile of `main` into `real-app` (issue #70) is that port, and here is
  // the justification it asked for: on `main` the file is NOT a second policy
  // module. It is a re-export kept so PR #67's fifteen tests and call site keep
  // working byte-identically, and it declares no function of its own. So the
  // property #85 actually cared about — exactly one place decides what "on the
  // line" means — still holds, and asserting ABSENCE would now delete a file that
  // main's suite depends on in order to defend a property that is not threatened.
  //
  // The assertion is therefore inverted in form and IDENTICAL in intent: the shim
  // exists, and it holds no decision. If someone ever puts logic in it, this REDS.
  const at = path.join(REPO, 'lib', 'realappRefGuard.js');
  assert.equal(fs.existsSync(at), true, 'the reconcile carries main\'s re-export shim onto this branch');
  const src = fs.readFileSync(at, 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /function\s+refDeployVerdict/, 'the decision must live in exactly one file');
  assert.match(code, /require\(['"]\.\/deployRefPolicy['"]\)/, 'the shim must delegate, not decide');
  assert.equal(require('../lib/realappRefGuard').refDeployVerdict, refDeployVerdict,
    'the shim must re-export the SAME function object the policy module exports');
  // ...and the one decision that IS here is the shared one, not a copy.
  const policy = fs.readFileSync(path.join(REPO, 'lib', 'deployRefPolicy.js'), 'utf8');
  assert.match(policy, /function\s+refDeployVerdict/, 'the decision must live in deployRefPolicy.js on this branch');
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
  const ci = readWf('ci.yml');
  const testJob = ci.slice(ci.indexOf('  test:'), ci.indexOf('  workflows:'));
  assert.ok(testJob.length > 0, 'ci.yml test job not found');
  assert.match(
    testJob,
    /actions\/checkout@v4\n\s+with:\n\s+fetch-depth:\s*0/,
    'ci.yml test job must checkout with fetch-depth: 0, or the real-ref tests below skip and pass on nothing',
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

// ── 6. THE PROVENANCE RECORD MUST NOT OUTRANK THE GUARD (cards 22I0yUum / QpERt8db)
//
// A provenance block that prints "ancestry verified by the ref guard" on a run
// where the guard REFUSED is an authoritative-looking record that is not true —
// the same harm eKfog19I was filed about, one level down. QpERt8db measured it
// live on deploy-engine.yml (run 34322710482): the guard refused, steps 4-8
// skipped, nothing was minted, and the `if: always()` record still printed a
// commit and the words "ancestry verified".
//
// ⚠️ THIS SET IS DELIBERATELY NOT `GUARDED`. deploy-engine.yml carries the
// defect today and fixing it is QpERt8db's scope, not this card's — a loop over
// GUARDED here would red the build for someone else's open bug. When QpERt8db
// lands, add 'deploy-engine.yml' to this list; that is the whole change, and
// this comment is the instruction.
const PROVENANCE_READS_GUARD = ['deploy-realapp.yml'];

test('a provenance record reads the guard OUTCOME — it never asserts verification unconditionally', () => {
  for (const file of PROVENANCE_READS_GUARD) {
    const s = readWf(file);
    // The guard must be addressable, or the record cannot consult it.
    assert.match(s, /^\s+id:\s*refguard\s*$/m, `${file}: the ref-guard step needs an id: for the record to read`);
    assert.match(
      s,
      /steps\.refguard\.outcome/,
      `${file}: the provenance record must read steps.refguard.outcome, not assume the guard passed`,
    );
    // The claim itself must be downstream of a check on that outcome.
    const claim = s.indexOf('ancestry');
    assert.ok(claim > -1, `${file}: no ancestry line in the record at all`);
    const gate = s.search(/if \[ "\$GUARD" != "success" \]/);
    assert.ok(gate > -1, `${file}: the record does not branch on the guard outcome`);
    assert.ok(
      gate < claim,
      `${file}: the "ancestry verified" claim is printed BEFORE the guard-outcome check — ` +
        `that is exactly the QpERt8db defect`,
    );
  }
});

test('on a refused run the record prints no commit line — a receipt for a deploy that did not happen', () => {
  for (const file of PROVENANCE_READS_GUARD) {
    const s = readWf(file);
    const gate = s.search(/if \[ "\$GUARD" != "success" \]/);
    const commit = s.search(/echo "commit\s/);
    assert.ok(commit > -1, `${file}: the record never prints a commit at all`);
    assert.ok(
      gate < commit,
      `${file}: the commit line is printed before the guard-outcome branch, so a REFUSED run ` +
        `still emits something that reads like a deploy receipt`,
    );
    // …and the refusal path must exit before reaching it.
    assert.match(s, /RESULT\s*:\s*REFUSED/, `${file}: the refused path must say so in words`);
    assert.match(s, /exit 0/, `${file}: the refused path must end the step without failing the record itself`);
  }
});

test('the record still runs on a failed/refused dispatch — always() is not traded away', () => {
  // QpERt8db's rail: do NOT fix the false wording by dropping always(). That
  // swaps a false record for NO record on precisely the runs it exists to serve.
  for (const file of PROVENANCE_READS_GUARD) {
    assert.match(readWf(file), /if:\s*always\(\)/, `${file}: the provenance step lost its always()`);
  }
});

// ── 7. AC-4's KNOWN-POSITIVE — the direction a refusing guard never proves ───
//
// "A guard shown only refusing has not been shown to permit anything." Every
// real-git test above exercises the REFUSE direction. On a PROD rail that is
// the cheap half: a guard that refuses everything is perfectly safe and
// perfectly useless, and it would pass all of them.
//
// This cannot be discharged by dispatching — the workflow deploys PROD
// (Cloud Run + update-traffic --to-latest + Firebase Hosting), and the card's
// rails forbid a lane dispatching it to test. What CAN be done without any
// deploy is to run the SHIPPED decision over the SAME git question the workflow
// asks, on real refs, and assert it ALLOWS. That is the whole guard minus the
// gcloud calls.
test('KNOWN-POSITIVE: a dispatch ON the expected ref is ALLOWED, on real git state', () => {
  const p = DEPLOY_REF_POLICY['deploy-realapp.yml'];
  const expected = resolve(p.expectedRef);
  if (!expected) {
    console.log(`SKIP: need ${p.expectedRef} locally (shallow clone?)`);
    return;
  }

  // (a) The literal legitimate dispatch: HEAD is the branch tip, so the tip is
  //     trivially an ancestor of itself — exit 0.
  const atTip = spawnSync('git', ['merge-base', '--is-ancestor', expected, expected], { cwd: REPO }).status;
  assert.equal(atTip, 0, 'the expected ref is not an ancestor of itself — git is not answering');
  const vTip = refDeployVerdict(atTip, { dispatchedRef: p.expectedRef, expectedRef: p.expectedRef, tier: p.tier });
  assert.equal(vTip.allow, true, `a dispatch on ${p.expectedRef} was REFUSED: ${vTip.message}`);

  // (b) …and not only by equality. An earlier commit on the same line is a
  //     genuine ancestor, so the allow path is reachable for a real range of
  //     refs and not just the degenerate one.
  const parent = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${expected}~1`], { cwd: REPO });
  if (parent.status === 0) {
    const sha = parent.stdout.toString().trim();
    const rc = spawnSync('git', ['merge-base', '--is-ancestor', sha, expected], { cwd: REPO }).status;
    assert.equal(rc, 0, 'a parent commit is not an ancestor of its own branch tip — git is not answering');
    const v = refDeployVerdict(rc, { dispatchedRef: p.expectedRef, expectedRef: p.expectedRef, tier: p.tier });
    assert.equal(v.allow, true, `a genuine ancestor of ${p.expectedRef} was REFUSED: ${v.message}`);
  }
});

test('KNOWN-POSITIVE CONTROL: the same decision still REFUSES the dangerous ref', () => {
  // Without this arm the test above is satisfied by a decision that allows
  // everything — which is the failure mode a PROD guard must never have.
  const p = DEPLOY_REF_POLICY['deploy-realapp.yml'];
  const expected = resolve(p.expectedRef);
  const dangerous = resolve('main');
  if (!expected || !dangerous) {
    console.log('SKIP: need both refs locally (shallow clone?)');
    return;
  }
  const rc = spawnSync('git', ['merge-base', '--is-ancestor', dangerous, expected], { cwd: REPO }).status;
  assert.equal(rc, 1, 'main IS an ancestor of the deploy line — the branches have converged, re-read this test');
  const v = refDeployVerdict(rc, { dispatchedRef: 'main', expectedRef: p.expectedRef, tier: p.tier });
  assert.equal(v.allow, false, 'a dispatch on main was ALLOWED onto the PROD surface');
  assert.match(v.message, new RegExp(p.expectedRef), 'the refusal must name the ref to re-dispatch with');
});
