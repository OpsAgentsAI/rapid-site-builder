'use strict';
// Auth unit tests (card VI673sym) — run with `npm test` (node --test).
// Covers the dependency-free ID-token verifier (claim validation + RS256
// signature path with an injected cert map), the HMAC session cookie
// (roundtrip, expiry, tamper), and the fail-closed posture when
// SESSION_SECRET is missing.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const AUTH_PATH = path.join(__dirname, '..', 'lib', 'auth.js');
function freshAuth(env) {
  delete require.cache[require.resolve(AUTH_PATH)];
  const saved = {};
  for (const k of ['FIREBASE_PROJECT_ID', 'FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN', 'SESSION_SECRET', 'GOOGLE_CLOUD_PROJECT']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, env);
  const mod = require(AUTH_PATH);
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return mod;
}

const ENABLED_ENV = {
  FIREBASE_PROJECT_ID: 'demo-project',
  FIREBASE_API_KEY: 'demo-api-key',
  SESSION_SECRET: 'unit-test-secret-0123456789abcdef0123456789abcdef'
};

// ---- token factory ----------------------------------------------------------
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' });
const KID = 'test-kid-1';

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function makeToken({ header, payload, signWith } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const h = { alg: 'RS256', kid: KID, ...header };
  const p = {
    aud: 'demo-project',
    iss: 'https://securetoken.google.com/demo-project',
    iat: nowSec - 10, exp: nowSec + 3600,
    sub: 'uid-123', email: 'user@example.com',
    ...payload
  };
  const body = b64url(JSON.stringify(h)) + '.' + b64url(JSON.stringify(p));
  const sig = crypto.createSign('RSA-SHA256').update(body).end()
    .sign(signWith || privateKey);
  return body + '.' + b64url(sig);
}
const fetchCerts = async () => ({
  ok: true,
  headers: { get: () => 'public, max-age=3600' },
  json: async () => ({ [KID]: PUB_PEM })
});

test('verifyFirebaseIdToken accepts a well-formed RS256 token', async () => {
  const auth = freshAuth(ENABLED_ENV);
  auth._resetCache();
  const claims = await auth.verifyFirebaseIdToken(makeToken(), {
    projectId: 'demo-project', fetchImpl: fetchCerts
  });
  assert.equal(claims.sub, 'uid-123');
  assert.equal(claims.email, 'user@example.com');
});

test('verifyFirebaseIdToken rejects claim and signature failures', async () => {
  const auth = freshAuth(ENABLED_ENV);
  auth._resetCache();
  const opts = { projectId: 'demo-project', fetchImpl: fetchCerts };
  await assert.rejects(() => auth.verifyFirebaseIdToken('not-a-jwt', opts), /malformed/);
  await assert.rejects(() => auth.verifyFirebaseIdToken(makeToken({ header: { alg: 'HS256' } }), opts), /bad alg/);
  await assert.rejects(() => auth.verifyFirebaseIdToken(makeToken({ payload: { aud: 'other' } }), opts), /bad aud/);
  await assert.rejects(() => auth.verifyFirebaseIdToken(makeToken({ payload: { iss: 'https://evil.example' } }), opts), /bad iss/);
  const old = Math.floor(Date.now() / 1000) - 7200;
  await assert.rejects(() => auth.verifyFirebaseIdToken(makeToken({ payload: { exp: old } }), opts), /expired/);
  // signed by the wrong key → signature must fail even with valid claims
  const evil = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(() => auth.verifyFirebaseIdToken(makeToken({ signWith: evil.privateKey }), opts), /bad signature/);
});

test('session cookie roundtrip, expiry, and tamper rejection', () => {
  const auth = freshAuth(ENABLED_ENV);
  const tok = auth.signSession({ exp: Date.now() + 60_000, uid: 'u1', email: 'a@b.c' });
  const got = auth.verifySession(tok);
  assert.equal(got.uid, 'u1');
  assert.equal(auth.verifySession(auth.signSession({ exp: Date.now() - 1, uid: 'u1' })), null, 'expired session must not verify');
  const [body, sig] = tok.split('.');
  const flipped = body.slice(0, -2) + (body.slice(-2) === 'aa' ? 'bb' : 'aa') + '.' + sig;
  assert.equal(auth.verifySession(flipped), null, 'tampered body must not verify');
  assert.equal(auth.verifySession(body + '.' + sig.slice(0, -2)), null, 'tampered sig must not verify');
});

test('fail-closed: no SESSION_SECRET → auth disabled, no session can exist', () => {
  const auth = freshAuth({ FIREBASE_PROJECT_ID: 'demo-project', FIREBASE_API_KEY: 'demo-api-key' });
  assert.equal(auth.AUTH_ENABLED, false, 'partial config must not enable auth');
  assert.throws(() => auth.signSession({ exp: Date.now() + 1000, uid: 'u1' }), /SESSION_SECRET/);
  assert.equal(auth.verifySession('anything.atall'), null);
});

test('cookie name is __session (the only cookie Firebase Hosting forwards)', () => {
  const auth = freshAuth(ENABLED_ENV);
  assert.equal(auth.COOKIE, '__session');
  const req = { headers: { cookie: 'other=1; __session=tok%20en; x=2' } };
  assert.equal(auth.readCookie(req, '__session'), 'tok en');
});
