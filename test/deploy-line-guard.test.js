'use strict';
// Card 8itdTRtX — THE SECOND HALF OF THE DEPLOY-REF VERDICT.
//
// opsagents-cto, CHANGES_REQUESTED on PR #98 @ 1869afd (2026-09-27 23:01Z):
//
//   "Ref guard fails OPEN for a main dispatch post-merge. deploy-realapp.yml's
//    guard is `git merge-base --is-ancestor HEAD origin/real-app` -> allow on
//    rc=0. This PR makes main an ancestor of real-app (its whole purpose), so
//    after merge a deploy-realapp.yml dispatch FROM main gets rc=0 -> allow ->
//    main can ship PROD."
//
// The allow condition was ONE probe — "on the deploy line" — and it separated
// main from real-app only because main was not on that line. The ancestry
// merge that closes issue #70 changes exactly that fact, on purpose. So a
// policy row may now name lines the dispatched commit must NOT be on
// (`mustNotBeAncestorOf`), and the decision needs a probe against each:
//
//     is-ancestor HEAD <expectedRef>   -> 0    on the deploy line
//     is-ancestor HEAD <forbidden>     -> 1    carries a commit that line lacks
//
// main is trivially an ancestor of itself, so it is refused before AND after
// the merge; real-app's tip carries the deploy-line-only commits, so it is not
// an ancestor of main and stays allowed. Both halves of that sentence are
// asserted below on real git state, and the guard's ACTUAL shell is executed
// against real refs — not only read.
//
// Second finding on the same review, same root: the KNOWN-POSITIVE CONTROL in
// test/deploy-ref-policy.test.js asserted `is-ancestor main real-app` exits 1,
// which is the pre-merge world. That tripwire is retargeted in that file to the
// invariant that survives the merge: the FULL verdict refuses main.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  DEPLOY_REF_POLICY,
  refDeployVerdict,
  forbiddenRefsFor,
  parseForbiddenProbes,
} = require('../lib/deployRefPolicy');

const REPO = path.join(__dirname, '..');
const WF_DIR = path.join(REPO, '.github', 'workflows');
const PROD = 'deploy-realapp.yml';

const strip = (raw) => raw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const readWf = (file) => strip(fs.readFileSync(path.join(WF_DIR, file), 'utf8'));
const rawWf = (file) => fs.readFileSync(path.join(WF_DIR, file), 'utf8');

const git = (args, cwd = REPO) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const have = (ref) => git(['rev-parse', '--verify', '--quiet', ref]).status === 0;
const resolve = (name) => [`refs/remotes/origin/${name}`, name].find(have);
const isAncestor = (a, b) => git(['merge-base', '--is-ancestor', a, b]).status;

const prodRow = DEPLOY_REF_POLICY[PROD];
const prodCtx = (over = {}) => ({
  workflow: PROD,
  dispatchedRef: 'main',
  expectedRef: prodRow.expectedRef,
  tier: prodRow.tier,
  ...over,
});

// ── 1. THE POLICY SAYS IT ────────────────────────────────────────────────────

test('the PROD row forbids the main line, and every row carries the field', () => {
  assert.ok(Array.isArray(prodRow.mustNotBeAncestorOf), 'PROD row has no mustNotBeAncestorOf list');
  assert.ok(prodRow.mustNotBeAncestorOf.includes('main'), 'the PROD row must name main as a forbidden line');
  for (const [file, row] of Object.entries(DEPLOY_REF_POLICY)) {
    assert.ok(Array.isArray(row.mustNotBeAncestorOf), `${file}: mustNotBeAncestorOf must be an explicit array — an absent field reads as "nobody decided"`);
    assert.ok(!row.mustNotBeAncestorOf.includes(row.expectedRef), `${file}: a row cannot forbid its own expected ref`);
  }
});

test('forbiddenRefsFor: explicit workflow, inferred from expectedRef, PR #67 default, unknown', () => {
  assert.deepEqual(forbiddenRefsFor({ workflow: PROD }), ['main']);
  assert.deepEqual(forbiddenRefsFor({ workflow: 'deploy.yml' }), []);
  // PR #67's call shape names no workflow and no expectedRef: it IS the PROD
  // row, so it inherits the PROD row's forbidden line rather than a free pass.
  assert.deepEqual(forbiddenRefsFor({}), ['main']);
  assert.deepEqual(forbiddenRefsFor({ expectedRef: 'real-app' }), ['main']);
  assert.deepEqual(forbiddenRefsFor({ expectedRef: 'main' }), []);
  assert.equal(forbiddenRefsFor({ workflow: 'no-such-workflow.yml' }), null, 'an unknown row is null, not "no rules"');
});

// ── 2. THE DECISION TABLE, second half ───────────────────────────────────────

test('THE BOUNCE: on the deploy line AND on the main line -> REFUSED, not allowed', () => {
  // exit 0 against real-app (post-merge main IS an ancestor of real-app) and
  // exit 0 against main (main is an ancestor of itself). The old decision saw
  // only the first and allowed. This is the finding, as a table row.
  const v = refDeployVerdict(0, prodCtx({ forbidden: [{ ref: 'main', exitCode: 0 }] }));
  assert.equal(v.allow, false, 'main was ALLOWED onto PROD by a decision that only asked "is it on the line"');
  assert.equal(v.verdict, 'refuse');
  assert.equal(v.reason, 'shared-line');
  assert.match(v.message, /REFUSED/);
  assert.match(v.message, /no commit unique to the real-app line/);
  assert.match(v.message, /Re-dispatch with ref "real-app"/, 'the remedy must still be in the message');
});

test('KNOWN-POSITIVE: on the deploy line and NOT on the main line -> allowed, and the message says both', () => {
  const v = refDeployVerdict(0, prodCtx({ dispatchedRef: 'real-app', forbidden: [{ ref: 'main', exitCode: 1 }] }));
  assert.equal(v.allow, true, v.message);
  assert.equal(v.verdict, 'allow');
  assert.match(v.message, /not an ancestor of main/);
});

test('MUTATION GUARD: a decision that ignores `forbidden` cannot pass both rows above', () => {
  // The two tests above differ ONLY in the forbidden probe's exit code. A
  // refDeployVerdict that never reads ctx.forbidden returns the same verdict
  // for both, so exactly one of them reds. Stated here so the pair is never
  // "simplified" into one.
  const a = refDeployVerdict(0, prodCtx({ forbidden: [{ ref: 'main', exitCode: 0 }] })).allow;
  const b = refDeployVerdict(0, prodCtx({ forbidden: [{ ref: 'main', exitCode: 1 }] })).allow;
  assert.notEqual(a, b, 'the forbidden probe changed nothing — the second half is not being read');
});

test('A REQUIRED PROBE THAT WAS NOT SUPPLIED IS CANNOT-VERIFY — a call site behind the policy fails closed', () => {
  for (const ctx of [
    prodCtx(), // no forbidden at all
    prodCtx({ forbidden: [] }),
    prodCtx({ forbidden: [{ ref: 'other', exitCode: 1 }] }), // probed the wrong ref
    { dispatchedRef: 'real-app' }, // PR #67's exact call shape, exit 0
  ]) {
    const v = refDeployVerdict(0, ctx);
    assert.equal(v.allow, false, `allowed without the main probe: ${JSON.stringify(ctx)}`);
    assert.equal(v.verdict, 'cannot-verify');
    assert.equal(v.reason, 'missing-probe');
    assert.match(v.message, /NOT on the main line/);
    assert.match(v.message, /is-ancestor HEAD origin\/main/, 'the message must name the probe the call site owes');
    assert.doesNotMatch(v.message, /REFUSED/, 'missing evidence is not a refusal — it must not accuse the ref');
  }
});

test('the forbidden probe has the SAME three-way reading: 128 / blank / junk is cannot-verify, never allow', () => {
  for (const bad of [128, '128', -1, '', null, undefined, 'nope', NaN, true, false]) {
    const v = refDeployVerdict(0, prodCtx({ forbidden: [{ ref: 'main', exitCode: bad }] }));
    assert.equal(v.allow, false, `forbidden probe exit ${String(bad)} allowed a deploy`);
    assert.equal(v.verdict, 'cannot-verify', `forbidden probe exit ${String(bad)}`);
    assert.equal(v.reason, 'forbidden-probe');
    assert.match(v.message, /fetch-depth: 0/, 'the remedy must be in the message');
  }
});

test('the FIRST probe still decides first: off the line is REFUSED whatever the second probe says', () => {
  for (const second of [0, 1, 128, undefined]) {
    const v = refDeployVerdict(1, prodCtx({ forbidden: second === undefined ? undefined : [{ ref: 'main', exitCode: second }] }));
    assert.equal(v.verdict, 'refuse');
    assert.equal(v.reason, 'off-line');
    assert.match(v.message, /is not an ancestor of real-app/);
  }
  for (const first of [128, '', null, 'nope']) {
    const v = refDeployVerdict(first, prodCtx({ forbidden: [{ ref: 'main', exitCode: 1 }] }));
    assert.equal(v.verdict, 'cannot-verify');
    assert.equal(v.reason, 'expected-probe');
  }
});

test('rows with NO forbidden line need no probe and are unchanged in behaviour', () => {
  for (const file of ['deploy.yml', 'deploy-engine.yml', 'preview.yml']) {
    const p = DEPLOY_REF_POLICY[file];
    assert.deepEqual(p.mustNotBeAncestorOf, [], `${file}: this test assumes an empty forbidden list`);
    const ctx = { workflow: file, dispatchedRef: 'main', expectedRef: p.expectedRef, tier: p.tier };
    assert.equal(refDeployVerdict(0, { ...ctx, forbidden: [] }).allow, true, `${file}: exit 0 must allow`);
    assert.equal(refDeployVerdict(0, ctx).allow, true, `${file}: no probe list at all is fine when none is required`);
    assert.equal(refDeployVerdict(1, ctx).verdict, 'refuse');
    assert.equal(refDeployVerdict(128, ctx).verdict, 'cannot-verify');
  }
});

test('an UNKNOWN workflow is cannot-verify — a call site the policy does not know is not a call site with no rules', () => {
  const v = refDeployVerdict(0, { workflow: 'deploy-something-new.yml', dispatchedRef: 'main' });
  assert.equal(v.allow, false);
  assert.equal(v.verdict, 'cannot-verify');
  assert.equal(v.reason, 'unknown-workflow');
  assert.match(v.message, /deploy-something-new\.yml/);
});

test('parseForbiddenProbes: the shell hands over REF=CODE pairs; a malformed pair is kept and reads as cannot-verify', () => {
  assert.deepEqual(parseForbiddenProbes(' main=0  other=1 '), [
    { ref: 'main', exitCode: '0' },
    { ref: 'other', exitCode: '1' },
  ]);
  assert.deepEqual(parseForbiddenProbes(''), []);
  assert.deepEqual(parseForbiddenProbes(undefined), []);
  assert.deepEqual(parseForbiddenProbes('main'), [{ ref: 'main', exitCode: '' }]);
  // ...and that malformed pair does NOT become an allow downstream.
  const v = refDeployVerdict(0, prodCtx({ forbidden: parseForbiddenProbes('main') }));
  assert.equal(v.verdict, 'cannot-verify');
  // The exact string the workflows build: a leading space and "=<code>".
  const v2 = refDeployVerdict(0, prodCtx({ forbidden: parseForbiddenProbes(' main=1') }));
  assert.equal(v2.allow, true, v2.message);
});

// ── 3. THE WIRING — every guard passes its probes, or the decision fails closed ─

const guardBlock = (file) => {
  const s = readWf(file);
  const start = s.search(/- name: Refuse (a dispatch on )?any ref that is not on the/);
  assert.ok(start > -1, `${file}: guard step not found`);
  const rest = s.slice(start);
  const nextStep = rest.slice(10).search(/\n\s+- (name|uses):/);
  return nextStep === -1 ? rest : rest.slice(0, nextStep + 10);
};

test('every policy row\'s workflow probes its forbidden lines and hands the codes to the decision', () => {
  for (const file of Object.keys(DEPLOY_REF_POLICY)) {
    const g = guardBlock(file);
    assert.match(g, /\.mustNotBeAncestorOf\.join\(' '\)/, `${file}: the forbidden list must be READ from the policy row, never typed into the workflow`);
    assert.ok(g.includes(`DEPLOY_REF_POLICY['${file}'].mustNotBeAncestorOf`), `${file}: must read ITS OWN row's forbidden list`);
    assert.match(g, /for REF in \$FORBIDDEN; do/, `${file}: no probe loop over the forbidden refs`);
    assert.match(g, /git merge-base --is-ancestor HEAD "refs\/remotes\/origin\/\$REF" \|\| frc=\$\?/, `${file}: the forbidden probe must capture its exit code with || frc=$? (bash -e)`);
    assert.match(g, /PROBES="\$PROBES \$REF=\$frc"/, `${file}: probe results must be accumulated as REF=CODE`);
    assert.match(g, /RC_FORBIDDEN="\$PROBES" node -e/, `${file}: the probes must reach node through env, not interpolation`);
    assert.match(g, /parseForbiddenProbes\(process\.env\.RC_FORBIDDEN\)/, `${file}: the decision must receive the parsed probes`);
    assert.match(g, /forbidden: parseForbiddenProbes/, `${file}: ...as ctx.forbidden`);
    assert.ok(g.includes(`workflow: "${file}"`), `${file}: the verdict call must name its own workflow so the row's forbidden list is enforced`);
    // The forbidden refs are also fetched before they are probed, or a missing
    // origin/<ref> reads 128 on every run and the guard cries wolf.
    assert.match(g, /for REF in \$EXPECTED \$FORBIDDEN; do/, `${file}: the forbidden refs must be fetched alongside the expected ref`);
  }
});

test('no guard names a forbidden ref as a literal — the policy row is the only source', () => {
  for (const [file, p] of Object.entries(DEPLOY_REF_POLICY)) {
    const g = guardBlock(file).replace(/DEPLOY_REF_POLICY\[[^\]]*\]/g, '').replace(/workflow: "[^"]+"/g, '');
    for (const ref of [p.expectedRef, ...p.mustNotBeAncestorOf]) {
      assert.doesNotMatch(g, new RegExp(`['"]${ref}['"]`), `${file}: the guard carries a literal copy of "${ref}"`);
    }
  }
});

test('the workflow comments do not carry the guard\'s code — stripping stays defence in depth', () => {
  for (const file of Object.keys(DEPLOY_REF_POLICY)) {
    const commentsOnly = rawWf(file).split('\n').filter((l) => /^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(commentsOnly, /parseForbiddenProbes|RC_FORBIDDEN|mustNotBeAncestorOf/, `${file}: a comment now names the probe wiring`);
  }
});

// ── 4. ON REAL GIT — the invariant that survives the ancestry merge ──────────

test('REAL GIT: the FULL verdict refuses main for PROD, before and after main becomes an ancestor of real-app', () => {
  const mainRef = resolve('main');
  const appRef = resolve(prodRow.expectedRef);
  if (!mainRef || !appRef) {
    console.log('SKIP: need both main and real-app locally (shallow clone?)');
    return;
  }
  const onLine = isAncestor(mainRef, appRef); // 1 pre-merge, 0 post-merge — the verdict must not care
  const onMain = isAncestor(mainRef, mainRef); // always 0: a ref is an ancestor of itself
  assert.equal(onMain, 0, 'git is not answering: main is not an ancestor of itself');
  const v = refDeployVerdict(onLine, prodCtx({ forbidden: [{ ref: 'main', exitCode: onMain }] }));
  assert.equal(v.allow, false, `a dispatch on main was ALLOWED onto PROD (is-ancestor main real-app -> ${onLine}): ${v.message}`);
  assert.equal(v.verdict, 'refuse');
  assert.equal(v.reason, onLine === 0 ? 'shared-line' : 'off-line');
  console.log(`NOTE: is-ancestor main real-app -> ${onLine} (${onLine === 0 ? 'POST-merge world: main is on the line and refused by the second half' : 'pre-merge world: refused by the first half'})`);
});

test('REAL GIT: real-app carries commits main lacks — so it is allowed, and the main-line rows need no forbidden line', () => {
  const mainRef = resolve('main');
  const appRef = resolve(prodRow.expectedRef);
  if (!mainRef || !appRef) {
    console.log('SKIP: need both main and real-app locally (shallow clone?)');
    return;
  }
  const appNotOnMain = isAncestor(appRef, mainRef);
  assert.equal(
    appNotOnMain,
    1,
    'real-app IS an ancestor of main — the deploy line has collapsed into main. Two things need ' +
      're-deciding: the PROD row would now refuse its own tip, and the main-line rows (deploy.yml, ' +
      'deploy-engine.yml, preview.yml) would need a forbidden line of their own, because their ' +
      'one-sided check was complete only while real-app was never on the main line.',
  );
  const tip = refDeployVerdict(isAncestor(appRef, appRef), prodCtx({ dispatchedRef: prodRow.expectedRef, forbidden: [{ ref: 'main', exitCode: appNotOnMain }] }));
  assert.equal(tip.allow, true, `the deploy line's own tip was refused: ${tip.message}`);
});

// ── 5. THE GUARD'S ACTUAL SHELL, executed against real refs ──────────────────
//
// Everything above reads the workflow or calls the decision. This runs the
// `run:` body of the PROD guard — the bash the runner executes, comments and
// all — in a throwaway worktree whose HEAD is a real ref, with THIS checkout's
// lib/ overlaid so the shell exercises the decision it will ship with. A
// dispatch on real-app must exit 0 and say OK; a dispatch on main must exit 1
// and never print OK, in either world.

function guardRunBody(file) {
  const lines = rawWf(file).split('\n');
  const stepAt = lines.findIndex((l) => /- name: Refuse (a dispatch on )?any ref that is not on the/.test(l));
  assert.ok(stepAt > -1, `${file}: guard step not found`);
  const runAt = lines.findIndex((l, i) => i > stepAt && /^\s+run: \|\s*$/.test(l));
  assert.ok(runAt > -1, `${file}: guard step has no run: | block`);
  const indent = lines[runAt + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    if (l.match(/^\s*/)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

function runGuardAt(ref, refName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsb-guard-'));
  const wt = path.join(dir, 'wt');
  try {
    const add = git(['worktree', 'add', '--detach', wt, ref]);
    assert.equal(add.status, 0, `worktree add failed: ${add.stderr}`);
    // Overlay THIS checkout's decision so the shell runs the code under test,
    // whatever the ref's own lib/ looks like.
    fs.mkdirSync(path.join(wt, 'lib'), { recursive: true });
    for (const f of ['deployRefPolicy.js', 'realappRefGuard.js']) {
      fs.copyFileSync(path.join(REPO, 'lib', f), path.join(wt, 'lib', f));
    }
    const r = spawnSync('bash', ['-e', '-c', guardRunBody(PROD)], {
      cwd: wt,
      encoding: 'utf8',
      env: { ...process.env, REF_NAME: refName },
    });
    return r;
  } finally {
    git(['worktree', 'remove', '--force', wt]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('SHELL, REAL REFS: the PROD guard body ALLOWS a dispatch on real-app', () => {
  const appRef = resolve(prodRow.expectedRef);
  const mainRef = resolve('main');
  if (!appRef || !mainRef) {
    console.log('SKIP: need both main and real-app locally (shallow clone?)');
    return;
  }
  const r = runGuardAt(appRef, prodRow.expectedRef);
  assert.equal(r.status, 0, `the guard REFUSED the deploy line's own tip:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /ref check OK/);
  assert.match(r.stdout, /is-ancestor HEAD origin\/main -> exit 1/, 'the second probe must have run and said "not on main"');
});

test('SHELL, REAL REFS: the PROD guard body REFUSES a dispatch on main — the bounce, executed', () => {
  const appRef = resolve(prodRow.expectedRef);
  const mainRef = resolve('main');
  if (!appRef || !mainRef) {
    console.log('SKIP: need both main and real-app locally (shallow clone?)');
    return;
  }
  const r = runGuardAt(mainRef, 'main');
  assert.equal(r.status, 1, `the guard did not refuse main (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /ref check OK/);
  assert.match(r.stdout, /::error::REFUSED/, 'a refusal must surface as a workflow error annotation');
  assert.match(r.stdout, /is-ancestor HEAD origin\/main -> exit 0/, 'the second probe must have run and said "on main"');
});
