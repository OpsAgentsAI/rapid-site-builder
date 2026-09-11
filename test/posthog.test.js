'use strict';
// lib/posthog.js is an ALWAYS-SAFE wrapper: with no POSTHOG_KEY it must be a
// complete no-op and never throw, so analytics can never block a build (card
// u4xmePAo). These tests pin that contract — the failure mode we care about is
// "analytics threw and killed the request", so every method is exercised.
const { test } = require('node:test');
const assert = require('node:assert');

// Loaded with no POSTHOG_KEY in the env (CI runs with a clean env).
delete process.env.POSTHOG_KEY;
const posthog = require('../lib/posthog');

test('disabled when POSTHOG_KEY is unset', () => {
  assert.strictEqual(posthog.ENABLED, false);
});

test('POSTHOG_HOST defaults to the US ingest host', () => {
  assert.strictEqual(posthog.POSTHOG_HOST, 'https://us.i.posthog.com');
});

test('capture() is a silent no-op when disabled (never throws)', () => {
  assert.doesNotThrow(() => posthog.capture('anon', 'site_build_requested', { category: 'retail' }));
});

test('captureException() is a silent no-op when disabled (never throws)', () => {
  assert.doesNotThrow(() => posthog.captureException(new Error('boom'), 'anon', { route: '/api/build' }));
});

test('captureAiGeneration() is a silent no-op when disabled (never throws)', () => {
  assert.doesNotThrow(() => posthog.captureAiGeneration('anon', 'trace-1', { phase: 0 }));
});

test('shutdown() resolves without a client (never throws)', async () => {
  await assert.doesNotReject(() => posthog.shutdown());
});

test('exposes exactly the documented surface', () => {
  for (const fn of ['capture', 'captureException', 'captureAiGeneration', 'shutdown']) {
    assert.strictEqual(typeof posthog[fn], 'function', 'missing ' + fn);
  }
});
