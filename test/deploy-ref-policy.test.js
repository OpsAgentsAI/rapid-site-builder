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

test('VACUITY: the comment stripper leaves real code intact', () => {
  for (const f of ['deploy.yml', 'deploy-engine.yml', 'deploy-realapp.yml']) {
    const s = readWf(f);
    assert.ok(s.length > 500, `${f}: stripped source is implausibly short`);
    assert.match(s, /^jobs:/m, `${f}: jobs: block was eaten by the stripper`);
    assert.match(s, /^on:/m, `${f}: on: block was eaten by the stripper`);
  }
});

// ── 3. THE WIRING — a decision nothing calls is a seam with no consumer ──────

test('each policy row is actually CALLED by its workflow, with its own ref', () => {
  for (const [file, p] of Object.entries(DEPLOY_REF_POLICY)) {
    const s = readWf(file);
    assert.match(s, /refDeployVerdict/, `${file}: must call the tested decision by name`);
    if (file === 'deploy-realapp.yml') {
      // PR #67's call site, deliberately untouched: it reads EXPECTED_REF.
      assert.match(s, /require\(['"]\.\/lib\/realappRefGuard['"]\)\.EXPECTED_REF/, file);
    } else {
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

test('lib/realappRefGuard.js re-exports — it does NOT hold a second decision', () => {
  // A duplicate ancestry parser is how two guards eventually disagree about
  // what "on the line" means, which is the card's own stated reason for reuse.
  const src = fs.readFileSync(path.join(REPO, 'lib', 'realappRefGuard.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /function\s+refDeployVerdict/, 'the decision must live in exactly one file');
  assert.match(code, /require\(['"]\.\/deployRefPolicy['"]\)/);
  assert.equal(require('../lib/realappRefGuard').refDeployVerdict, refDeployVerdict);
});

// ── 5. THE NEGATIVE TESTS THE CARD ASKS FOR, ON THE REAL REPOSITORY ──────────

const have = (ref) =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: REPO }).status === 0;
const resolve = (name) => [`refs/remotes/origin/${name}`, name].find(have);

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
  const out = spawnSync(
    'git',
    ['diff', '--numstat', mainRef, appRef, '--', 'agents/', 'scripts/deploy_agent_engine.py'],
    { cwd: REPO, encoding: 'utf8' },
  );
  assert.equal(out.status, 0, 'git diff --numstat failed');
  const rows = out.stdout.trim().split('\n').filter(Boolean);
  if (rows.length === 0) {
    // A forward-port landed. The policy row is then merely conservative rather
    // than load-bearing — correct, and NOT a reason to red.
    console.log('NOTE: agents/ now agrees across main and real-app — the engine policy row is conservative, not urgent.');
    return;
  }
  const deletions = rows.reduce((n, r) => n + Number(r.split('\t')[1] || 0), 0);
  assert.ok(
    deletions > 0,
    'real-app is expected to be BEHIND main on the crew definition; if it is now AHEAD, ' +
      'the engine policy row names the wrong ref and must be re-decided, not left to drift',
  );
});
