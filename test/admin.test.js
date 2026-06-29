'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isAdminEmail, adminKeyOk, adminEmails, DEFAULT_ADMINS } = require('../lib/admin');

test('default allowlist is the two MSApps admin emails', () => {
  const list = adminEmails({});
  assert.deepStrictEqual(list, ['michal@opsagents.agency', 'michal@msapps.mobi']);
  assert.ok(DEFAULT_ADMINS.includes('michal@opsagents.agency'));
});

test('isAdminEmail matches the allowlist case- and space-insensitively', () => {
  assert.ok(isAdminEmail('michal@opsagents.agency', {}));
  assert.ok(isAdminEmail('  Michal@OpsAgents.Agency ', {}));
  assert.ok(isAdminEmail('michal@msapps.mobi', {}));
});

test('isAdminEmail rejects non-allowlisted, empty, and undefined', () => {
  assert.ok(!isAdminEmail('someone@else.com', {}));
  assert.ok(!isAdminEmail('', {}));
  assert.ok(!isAdminEmail(undefined, {}));
});

test('ADMIN_EMAILS env overrides the default allowlist', () => {
  const env = { ADMIN_EMAILS: 'a@x.com, B@Y.com' };
  assert.ok(isAdminEmail('b@y.com', env));
  assert.ok(!isAdminEmail('michal@opsagents.agency', env)); // default no longer applies
});

test('adminKeyOk: unset ADMIN_KEY never matches (locked-down by default)', () => {
  assert.ok(!adminKeyOk('anything', {}));
  assert.ok(!adminKeyOk('', {}));
});

test('adminKeyOk matches the exact configured key only', () => {
  const env = { ADMIN_KEY: 's3cret-key' };
  assert.ok(adminKeyOk('s3cret-key', env));
  assert.ok(!adminKeyOk('s3cret-keyy', env)); // length differs
  assert.ok(!adminKeyOk('s3cret-kex', env));  // same length, wrong char
  assert.ok(!adminKeyOk('', env));
  assert.ok(!adminKeyOk(undefined, env));
});
