'use strict';
// Shared by the suites that execute a workflow step's real shell. Lives outside
// the `test/*.test.js` glob, so `npm test` does not run it as a test file.

const assert = require('node:assert/strict');

/** The `run: |` body of the step named `name`, dedented. */
function stepRun(raw, name) {
  const lines = raw.split('\n');
  const at = lines.findIndex((l) => l.includes(`- name: ${name}`));
  assert.ok(at > -1, `step ${name} not found`);
  const r = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  const body = [];
  for (let i = r + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { body.push(''); continue; }
    if (!/^ {10}/.test(lines[i])) break;
    body.push(lines[i].slice(10));
  }
  return body.join('\n');
}

module.exports = { stepRun };
