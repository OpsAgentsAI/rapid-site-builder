'use strict';
// Card QpERt8db — the PROVENANCE record asserted "ancestry verified by the ref
// guard" on runs where the guard REFUSED.
//
// MEASURED, from a real dispatch (run 34322710482, real-app @ 9b5c2628), not
// from reading the file:
//
//   git merge-base --is-ancestor HEAD origin/main -> exit 1
//   REFUSED: real-app is not an ancestor of main.
//   steps 4-8 (auth, gcloud, python, deps, Deploy crew)  -> skipped
//   step 9 (if: always()) printed:
//       expected: main (ancestry verified by the ref guard at the top of this job)
//
// The guard refused. Nothing was verified. No engine exists. And because
// `expectedRef` for this workflow is `main` while `real-app` is not an ancestor
// of `main`, the guard on this branch can ONLY refuse — so that line was false
// on 100% of real-app dispatches, not on an edge case.
//
// Why it is not cosmetic: card eKfog19I exists because a wrong-ref run reports
// SUCCESS on a rollback — the harm is an authoritative-looking record that is
// not true. This block was the remedy for that, and it reproduced the harm one
// level down.
//
// ⛔ The `if: always()` is CORRECT and stays. Its purpose is that a failed
// deploy still records what it was built from, which is exactly when someone
// goes looking. Removing it would trade a false record for NO record on the
// runs the block exists to serve.
//
// ──────────────────────────────────────────────────────────────────────────
// WHY THIS SUITE EXECUTES THE BODY INSTEAD OF GREPPING IT
// ──────────────────────────────────────────────────────────────────────────
// A text pin on a shell body proves the words are present, not that the branch
// they sit in is reachable. So the tests below EXTRACT the real `run:` body out
// of the workflow and run it under `bash -e` — GitHub's default shell for
// `run:` — once per guard outcome, asserting on real stdout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const WF = path.join(REPO, '.github', 'workflows', 'deploy-engine.yml');
const raw = fs.readFileSync(WF, 'utf8');

/**
 * Pull a step's `run: |` block out by the step's `name:`, dedented.
 * Hand-rolled because this repo has no YAML dependency (deps are exactly
 * express + @google-cloud/storage) and adding one to assert a workflow shape
 * would be the more expensive mistake.
 */
function runBodyOfStep(source, stepName) {
  const lines = source.split('\n');
  const nameIdx = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
  if (nameIdx === -1) return null;
  const runIdx = lines.findIndex((l, i) => i > nameIdx && /^\s*run: \|\s*$/.test(l));
  if (runIdx === -1) return null;
  // Another `- name:` before the `run:` means we ran past our step.
  const nextStep = lines.findIndex((l, i) => i > nameIdx && /^\s*- name:/.test(l));
  if (nextStep !== -1 && nextStep < runIdx) return null;

  const indent = lines[runIdx].match(/^\s*/)[0].length + 2;
  const out = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { out.push(''); continue; }
    if (l.match(/^\s*/)[0].length < indent) break;
    out.push(l.slice(indent));
  }
  return out.join('\n');
}

const PROV_STEP = 'Record what the engine above was minted from';
const body = runBodyOfStep(raw, PROV_STEP);

/** Run the extracted body under bash -e with a given guard outcome. */
function runProvenance(refguardOutcome) {
  const r = spawnSync('bash', ['-e', '-c', body], {
    cwd: REPO,
    encoding: 'utf8',
    env: {
      ...process.env,
      REFGUARD: refguardOutcome,
      REF_NAME: 'real-app',
      SHA: '9b5c26289589bc3135ec80d3d435590c409e5dc9',
    },
  });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

// ── VACUITY FLOORS — before any assertion about the body's behaviour ────────

test('FLOOR: the provenance step and its run body were actually extracted', () => {
  assert.ok(body, `could not extract the run body of "${PROV_STEP}" — every test below would be vacuous`);
  assert.ok(body.length > 100, 'extracted body is implausibly short');
  assert.match(body, /esac/, 'extracted body does not contain the verdict switch');
});

test('FLOOR: the extractor returns null for a step that does not exist', () => {
  // Without this, a renamed step would make runBodyOfStep return null, the
  // floor above would be the only thing that noticed, and a typo'd name in a
  // future test would silently assert nothing.
  assert.equal(runBodyOfStep(raw, 'No Such Step Name At All'), null);
});

test('FLOOR: the body executes cleanly under bash -e', () => {
  const { status } = runProvenance('success');
  assert.equal(status, 0, 'the provenance body must not abort under bash -e');
});

// ── THE DEFECT: a REFUSED run must not claim verification ───────────────────

test('REFUSED: the record says so plainly and claims NO verification', () => {
  const { out } = runProvenance('failure');
  assert.match(out, /ref check: REFUSED/);
  assert.match(out, /NO ENGINE WAS MINTED/);
  // The exact false sentence from run 34322710482 must not appear.
  assert.doesNotMatch(out, /ancestry verified/i,
    'a refused run must never claim ancestry was verified — this is the defect');
  assert.doesNotMatch(out, /VERIFIED/,
    'a refused run must not carry the verified verdict at all');
});

test('REFUSED: no line reads like a mint receipt', () => {
  const { out } = runProvenance('failure');
  // The card: "must NOT print a commit line that reads like a mint receipt".
  assert.doesNotMatch(out, /^commit  :/m, 'the mint-receipt commit line must not appear on a refusal');
  assert.doesNotMatch(out, /Pin the RESOURCE_NAME/, 'nothing exists to pin on a refused run');
  // But the forensic facts are still recorded — the whole point of if: always().
  assert.match(out, /dispatched ref\s+: real-app/);
  assert.match(out, /dispatched commit: 9b5c2628/);
  assert.match(out, /expected ref\s+: main/);
});

// ── The known-negative: a permitted run must still carry full provenance ────

test('VERIFIED: a permitted run keeps the complete record', () => {
  const { out } = runProvenance('success');
  assert.match(out, /ref check: VERIFIED/);
  assert.match(out, /^ref     : real-app$/m);
  assert.match(out, /^commit  : 9b5c2628/m);
  assert.match(out, /^expected: main$/m);
  assert.match(out, /^crew    : /m, 'the crew line is the reason this block exists');
  assert.match(out, /Pin the RESOURCE_NAME/);
});

// ── THREE states, never two ─────────────────────────────────────────────────

test('UNKNOWN: cancelled / skipped / empty are neither verified nor refused', () => {
  // A timed-out job concludes `cancelled`, not `failure`. Folding those into
  // either arm is how a gate waves through the exact case it exists to catch.
  for (const outcome of ['cancelled', 'skipped', '']) {
    const { out } = runProvenance(outcome);
    assert.match(out, /ref check: UNKNOWN/, `outcome '${outcome}' must be UNKNOWN`);
    assert.match(out, /Treat this run as UNVERIFIED/, `outcome '${outcome}'`);
    assert.doesNotMatch(out, /ancestry verified/i, `outcome '${outcome}' must not claim verification`);
    assert.doesNotMatch(out, /REFUSED/, `outcome '${outcome}' must not be reported as a refusal`);
    assert.doesNotMatch(out, /Pin the RESOURCE_NAME/, `outcome '${outcome}'`);
  }
});

test('only the success arm may claim verification', () => {
  const verified = ['success', 'failure', 'cancelled', 'skipped', ''].filter(
    (o) => /VERIFIED —/.test(runProvenance(o).out),
  );
  assert.deepEqual(verified, ['success']);
});

// ── WIRING: the step must actually read the guard's verdict ────────────────

test('the guard step carries the id the provenance step reads', () => {
  assert.match(raw, /^\s*id: refguard$/m, 'the ref-guard step must have id: refguard');
  assert.match(raw, /REFGUARD: \$\{\{ steps\.refguard\.outcome \}\}/,
    'provenance must read steps.refguard.outcome');
});

test('the unconditional claim is gone from the file entirely', () => {
  assert.doesNotMatch(raw, /ancestry verified by the ref guard at the top of this job/,
    'the sentence that was false on 100% of real-app dispatches must not survive anywhere in the file');
});

test('if: always() is PRESERVED — a failed deploy must still record its origin', () => {
  const idx = raw.indexOf(`- name: ${PROV_STEP}`);
  assert.ok(idx > -1);
  assert.match(raw.slice(idx, idx + 200), /if: always\(\)/,
    'dropping if: always() would trade a false record for NO record');
});
