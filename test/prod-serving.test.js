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
