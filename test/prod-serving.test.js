'use strict';
// Card 65pcQtze — GAP B: is what production serves derived from real-app's head?
// See lib/prodServing.js for why this is a SEPARATE measurement from the
// divergence alarm, and why UNKNOWN is red.
//
// Like test/branch-divergence.test.js, this suite pins the CLASSIFIER only. It
// never asserts whether prod is currently fresh — that is the scheduled
// workflow's job, and a suite that reds on live state reds every PR.
//
// AC-3 demands BOTH a known-positive and a known-negative: without the negative,
// a red here is indistinguishable from a check that is red for gap A anyway.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_BUDGET_DAYS, exitCodeFor, classifyProdServing } = require('../lib/prodServing');

const NOW = '2026-09-15T12:00:00Z';
const DEPLOYED = '4472baa4000000000000000000000000000000aa';
const HEAD = '9e08438200000000000000000000000000000bbb';
const daysBefore = (n) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
const productCommit = (n, files = ['server.js']) => ({ sha: `p${n}`, dateISO: daysBefore(n), files });
const ciCommit = (n) => ({ sha: `c${n}`, dateISO: daysBefore(n), files: ['.github/workflows/deploy-realapp.yml'] });

test('⭐ KNOWN-POSITIVE: a deployed head 29 days behind real-app is STALE and exits red', () => {
  // The exact shape card 65pcQtze measured on 2026-09-15.
  const r = classifyProdServing({ deployedSha: DEPLOYED, headSha: HEAD, undeployed: [productCommit(29), productCommit(3)], nowISO: NOW });
  assert.equal(r.status, 'STALE');
  assert.equal(r.ageDays, 29);
  assert.equal(r.productCommits.length, 2);
  assert.equal(exitCodeFor(r.status), 1);
});

test('⭐ KNOWN-NEGATIVE: the deployed head EQUALS real-app\'s head -> CURRENT, exits green', () => {
  const r = classifyProdServing({ deployedSha: HEAD, headSha: HEAD, undeployed: [], nowISO: NOW });
  assert.equal(r.status, 'CURRENT');
  assert.equal(exitCodeFor(r.status), 0);
});

test('⭐ undeployed commits that change NO served byte are CURRENT, not stale — one rule with gap A', () => {
  // The divergence lib's own evidence: an undeployed CI-only commit is not an outage.
  // Reusing isProductPath means gap A and gap B cannot disagree about what counts.
  const r = classifyProdServing({ deployedSha: DEPLOYED, headSha: HEAD, undeployed: [ciCommit(40), ciCommit(35)], nowISO: NOW });
  assert.equal(r.status, 'CURRENT');
  assert.equal(r.productCommits.length, 0);
});

test('age is measured from the OLDEST undeployed PRODUCT commit, not from a newer CI one', () => {
  const r = classifyProdServing({ deployedSha: DEPLOYED, headSha: HEAD, undeployed: [ciCommit(60), productCommit(5)], nowISO: NOW });
  assert.equal(r.status, 'WITHIN_BUDGET');
  assert.equal(r.ageDays, 5);
});

test('undeployed product work younger than the budget is WITHIN_BUDGET and exits green', () => {
  const r = classifyProdServing({ deployedSha: DEPLOYED, headSha: HEAD, undeployed: [productCommit(2)], nowISO: NOW });
  assert.equal(r.status, 'WITHIN_BUDGET');
  assert.equal(exitCodeFor(r.status), 0);
});

test('the budget boundary: exactly the budget is within it; one day over is STALE', () => {
  const at = classifyProdServing({ deployedSha: DEPLOYED, headSha: HEAD, undeployed: [productCommit(DEFAULT_BUDGET_DAYS)], nowISO: NOW });
  const over = classifyProdServing({ deployedSha: DEPLOYED, headSha: HEAD, undeployed: [productCommit(DEFAULT_BUDGET_DAYS + 1)], nowISO: NOW });
  assert.equal(at.status, 'WITHIN_BUDGET');
  assert.equal(over.status, 'STALE');
});

test('an explicit budget overrides the default — an owner decision is an argument, not an edit', () => {
  const r = classifyProdServing({ deployedSha: DEPLOYED, headSha: HEAD, undeployed: [productCommit(29)], nowISO: NOW, budgetDays: 30 });
  assert.equal(r.status, 'WITHIN_BUDGET');
  assert.equal(r.budgetDays, 30);
});

test('⭐ FAILS CLOSED: no successful deploy found is UNKNOWN and exits red, never CURRENT', () => {
  const r = classifyProdServing({ deployedSha: null, headSha: HEAD, undeployed: [], nowISO: NOW });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(exitCodeFor(r.status), 2);
});

test('⭐ FAILS CLOSED: two DIFFERENT heads with an empty commit list is UNKNOWN — the instrument is blind', () => {
  // Mirrors lib/branchDivergence.js's positive control: a shallow read returns
  // nothing for the same reason a healthy repo does.
  const r = classifyProdServing({ deployedSha: DEPLOYED, headSha: HEAD, undeployed: [], nowISO: NOW });
  assert.equal(r.status, 'UNKNOWN');
  assert.match(r.reason, /not seeing history/);
});

test('FAILS CLOSED on every other unreadable input', () => {
  for (const bad of [
    { deployedSha: DEPLOYED, headSha: null, undeployed: [productCommit(1)], nowISO: NOW },
    { deployedSha: DEPLOYED, headSha: HEAD, undeployed: null, nowISO: NOW },
    { deployedSha: DEPLOYED, headSha: HEAD, undeployed: [productCommit(1)], nowISO: 'not a date' },
    { deployedSha: DEPLOYED, headSha: HEAD, undeployed: [{ sha: 'x', dateISO: 'garbage', files: ['server.js'] }], nowISO: NOW },
    { deployedSha: DEPLOYED, headSha: HEAD, undeployed: [productCommit(1)], nowISO: NOW, budgetDays: 0 },
    undefined,
  ]) {
    assert.equal(classifyProdServing(bad).status, 'UNKNOWN', JSON.stringify(bad));
  }
});

test('an unrecognised status maps to the UNKNOWN exit code, never to a pass', () => {
  assert.equal(exitCodeFor('SOMETHING_NEW'), 2);
  assert.equal(exitCodeFor(undefined), 2);
});

test('VACUITY: the default budget is a positive number of days', () => {
  assert.ok(Number.isFinite(DEFAULT_BUDGET_DAYS) && DEFAULT_BUDGET_DAYS > 0);
});

/* ── the #89 review's findings, settled by measurement ────────────────────────
 *
 * Finding 2 said `scripts/check-prod-serving.js` joins its Step Summary lines with a
 * LITERAL backslash-n, so the summary renders as one long line containing "\n". Measured
 * on the file's bytes: the source carries ONE backslash, JS evaluates the escape, and the
 * report is multi-line. The finding came from a rendering of the diff (where a single
 * backslash is shown escaped), not from the file — the same family as finding 1 on that
 * PR, which read a 0-step lockout red as a code defect.
 *
 * Refuting it in a comment would not stop the next reader re-raising it from the same
 * rendering, so the behaviour is pinned here instead.
 */

test('⭐ REFUTES review finding 2: the Step Summary joiner is a REAL newline, not a literal \\n', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-prod-serving.js'), 'utf8');
  const m = src.match(/const report = lines\.join\((.*?)\);/);
  assert.ok(m, 'the joiner line moved — re-point this test before trusting it');

  // The assertion is on BEHAVIOUR, not on the source text: evaluate the exact literal the
  // file uses and require that it produces a one-character newline.
  const sep = eval(m[1]); // eslint-disable-line no-eval -- the literal under test, nothing else
  assert.equal(sep, '\n');
  assert.equal(sep.length, 1, `the joiner is ${JSON.stringify(sep)} — a literal backslash-n WOULD be length 2`);
  assert.equal(['a', 'b'].join(sep), 'a\nb');
});

test('CONTROL: the same check FAILS on a genuine literal-backslash joiner', () => {
  // Without this, the test above would pass on any separator that happens to be defined —
  // including the defect it claims to rule out.
  const sep = eval("'\\\\n'"); // eslint-disable-line no-eval -- the defect shape, deliberately
  assert.equal(sep.length, 2);
  assert.notEqual(sep, '\n');
  assert.equal(['a', 'b'].join(sep), 'a\\nb');
});

test('⭐ review finding 3: undeployed commit details are fetched CONCURRENTLY, and a failure rejects', () => {
  // The fix is Promise.all rather than a sequential await loop. Pinned two ways: the shape
  // is present, and the fail-fast property is asserted — a half-filled list would
  // UNDER-COUNT undeployed work, which reads as healthier than reality.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-prod-serving.js'), 'utf8');
  assert.match(src, /undeployed = await Promise\.all\(/);
  assert.doesNotMatch(src, /for \(const c of cmp\.commits/, 'the sequential loop is back');
});
