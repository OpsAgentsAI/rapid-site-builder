'use strict';
// Design-trio crew turn (card NGce3rbL): Dana/Remy/Kai get an engine phase ONLY
// behind BUILDER_DESIGN_TRIO=1 — the proxy auto-deploys on merge while the
// engine is baked manually, so the default phase list must never name
// sub-agents the pinned engine doesn't carry. Run with `npm test`.

const test = require('node:test');
const assert = require('node:assert');

const { buildEnginePhases } = require('../lib/engine');

const BRIEF = { business: 'Cafe Luna', category: 'food_beverage', description: 'a cozy neighborhood coffee shop', lang: 'en' };

test('default phases carry no design-trio turn (merge-safe against the pinned engine)', () => {
  delete process.env.BUILDER_DESIGN_TRIO;
  const phases = buildEnginePhases(BRIEF);
  assert.equal(phases.length, 4);
  assert.ok(!phases.some(p => /Dana|Remy|Kai/.test(p)), 'no absent-agent names by default');
});

test('BUILDER_DESIGN_TRIO=1 inserts the Dana/Remy/Kai turn before observability', () => {
  process.env.BUILDER_DESIGN_TRIO = '1';
  try {
    const phases = buildEnginePhases(BRIEF);
    assert.equal(phases.length, 5);
    const trioIdx = phases.findIndex(p => p.includes('Dana') && p.includes('Remy') && p.includes('Kai'));
    const phoenixIdx = phases.findIndex(p => p.includes('Phoenix'));
    assert.ok(trioIdx > -1, 'trio phase present');
    assert.ok(trioIdx < phoenixIdx, 'trio runs before the observability turn');
    assert.ok(phases[phases.length - 1].includes('strict JSON'), 'final spec turn stays last');
  } finally {
    delete process.env.BUILDER_DESIGN_TRIO;
  }
});
