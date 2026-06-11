'use strict';
// peek() semantics on the per-IP limiter (review finding 1 follow-through:
// /api/uploads/sign is gated under the BUILD budget). peek must report the
// bucket state without ever consuming a slot — otherwise a pre-build upload
// burst would eat the visitor's builds. XFF-rotation resistance itself is
// covered end-to-end in test/ratelimit.test.js.

const test = require('node:test');
const assert = require('node:assert');
const { limiter } = require('../server');

test('peek() reports budget state without consuming a slot', () => {
  const ok = limiter(2);
  const req = { ip: '203.0.113.7' };
  assert.strictEqual(ok.peek(req), true);
  assert.strictEqual(ok.peek(req), true); // peeking twice burns nothing…
  assert.strictEqual(ok(req), true);      // …both real slots are still here
  assert.strictEqual(ok(req), true);
  assert.strictEqual(ok.peek(req), false); // exhausted → peek says so
  assert.strictEqual(ok(req), false);
});

test('peek and take share the same req.ip bucket key', () => {
  const ok = limiter(1);
  assert.strictEqual(ok({ ip: '203.0.113.7' }), true);
  assert.strictEqual(ok.peek({ ip: '203.0.113.7' }), false, 'same ip → same bucket');
  assert.strictEqual(ok.peek({ ip: '198.51.100.4' }), true, 'different ip → own bucket');
});
