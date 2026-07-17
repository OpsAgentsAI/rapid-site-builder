'use strict';
// P2b board-media tests (card RzaCDxAa) — run with `npm test` (node --test
// runs each file in its own process, so env pinned here never leaks).
//
// Covers the pure guards (ownership check, media-name cleaning, the re-render
// request record) and the /api/site-media route surface on an auth-ENABLED
// deploy: session gate, input validation, and the fail-closed 503 when the
// sites bucket is not configured — proving no GCS call can happen unconfigured.

// Pin env BEFORE any require: auth ON (so uid sessions exist), uploads ON
// (allowlist regexes build), sites bucket deliberately ABSENT.
process.env.FIREBASE_PROJECT_ID = 'demo-project';
process.env.FIREBASE_API_KEY = 'demo-api-key';
process.env.SESSION_SECRET = 'p2b-test-secret-0123456789abcdef0123456789abcdef';
process.env.USER_UPLOADS_BUCKET = 'test-uploads-bucket';
process.env.SITE_IMAGES_BUCKET = 'test-images-bucket';
delete process.env.PUBLISHED_SITES_BUCKET;
delete process.env.P2B_RERENDER_ENABLED;

const test = require('node:test');
const assert = require('node:assert');

const p2b = require('../lib/p2b-media');
const auth = require('../lib/auth');
const { app } = require('../server');

const GOOD_NAME = 'uploads/20260717/0123456789abcdef01234567.jpg';
const SITE = 'abcd1234';

// ---- ownsSite: THE server-side ownership gate -------------------------------

test('ownsSite accepts only an exact ownerUid match', () => {
  assert.strictEqual(p2b.ownsSite({ ownerUid: 'uid-1' }, 'uid-1'), true);
  assert.strictEqual(p2b.ownsSite({ ownerUid: 'uid-1' }, 'uid-2'), false);
  assert.strictEqual(p2b.ownsSite({ ownerUid: 'uid-1' }, ''), false);
  assert.strictEqual(p2b.ownsSite({ ownerUid: 'uid-1' }, null), false);
});

test('ownsSite refuses ownerless (pre-login) sites for everyone', () => {
  assert.strictEqual(p2b.ownsSite({ business: 'x' }, 'uid-1'), false);
  assert.strictEqual(p2b.ownsSite({ ownerUid: '' }, ''), false);
  assert.strictEqual(p2b.ownsSite(null, 'uid-1'), false);
  // type confusion must not slip through
  assert.strictEqual(p2b.ownsSite({ ownerUid: ['uid-1'] }, 'uid-1'), false);
  assert.strictEqual(p2b.ownsSite({ ownerUid: 'uid-1' }, ['uid-1']), false);
});

// ---- cleanMediaNames: server-shaped names only, capped ----------------------

test('cleanMediaNames keeps only server-shaped upload names and caps the list', () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    `uploads/20260717/${String(i).repeat(24).slice(0, 24).replace(/[^0-9a-f]/g, 'a')}.jpg`);
  assert.strictEqual(p2b.cleanMediaNames(many).length, 8); // MAX_FILES_PER_BUILD
  assert.deepStrictEqual(p2b.cleanMediaNames([
    GOOD_NAME,
    'uploads/../secrets.json',
    'sites/abc/index.html',
    'https://evil.example.com/x.jpg',
    42, null, {}
  ]), [GOOD_NAME]);
  assert.deepStrictEqual(p2b.cleanMediaNames('not-an-array'), []);
  assert.deepStrictEqual(p2b.cleanMediaNames(undefined), []);
});

// ---- buildRerenderRequest: the record stamped on the site meta --------------

test('buildRerenderRequest shapes a pending record from verified media', () => {
  const now = Date.UTC(2026, 6, 17, 12, 0, 0);
  const r = p2b.buildRerenderRequest('uid-1', [
    { url: 'https://storage.googleapis.com/test-images-bucket/user/0123456789abcdef/0.jpg', kind: 'image' },
    { url: 'https://storage.googleapis.com/test-images-bucket/user/0123456789abcdef/1.mp4', kind: 'video' },
    { url: 'https://storage.googleapis.com/test-images-bucket/user/0123456789abcdef/2.jpg', kind: 'banana' }
  ], now);
  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(r.requestedBy, 'uid-1');
  assert.strictEqual(r.requestedAt, new Date(now).toISOString());
  assert.strictEqual(r.media.length, 3);
  assert.strictEqual(r.media[1].kind, 'video');
  assert.strictEqual(r.media[2].kind, 'image'); // kind coerced, never trusted
});

test('buildRerenderRequest caps media and drops malformed entries', () => {
  const mk = (i) => ({ url: `https://x/${i}.jpg`, kind: 'image' });
  const r = p2b.buildRerenderRequest('uid-1', [
    ...Array.from({ length: 10 }, (_, i) => mk(i))
  ]);
  assert.strictEqual(r.media.length, 8);
  const r2 = p2b.buildRerenderRequest('uid-1', [null, 'str', { kind: 'image' }, mk(0)]);
  assert.deepStrictEqual(r2.media, [{ url: 'https://x/0.jpg', kind: 'image' }]);
});

test('re-render flag defaults OFF', () => {
  assert.strictEqual(p2b.RERENDER_ENABLED, false);
});

// ---- /api/site-media route surface ------------------------------------------

function listen() {
  return new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
}
function sessionCookie(uid) {
  const tok = auth.signSession({ exp: Date.now() + 60_000, uid, email: 'u@example.com' });
  return `__session=${encodeURIComponent(tok)}`;
}
function post(port, body, cookie) {
  return fetch(`http://127.0.0.1:${port}/api/site-media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
}

test('POST /api/site-media requires a signed-in session (401 without / with a bad cookie)', async () => {
  const server = await listen();
  try {
    const port = server.address().port;
    let res = await post(port, { siteId: SITE, media: [GOOD_NAME] });
    assert.strictEqual(res.status, 401);
    res = await post(port, { siteId: SITE, media: [GOOD_NAME] }, '__session=tampered.cookie');
    assert.strictEqual(res.status, 401);
  } finally {
    server.close();
  }
});

test('POST /api/site-media validates the site id and the media list', async () => {
  const server = await listen();
  try {
    const port = server.address().port;
    const cookie = sessionCookie('uid-1');
    for (const siteId of ['', 'short', '../sites', 'ABCD1234', 'abcd12345']) {
      const res = await post(port, { siteId, media: [GOOD_NAME] }, cookie);
      assert.strictEqual(res.status, 400, `expected 400 for siteId "${siteId}"`);
    }
    for (const media of [undefined, [], ['uploads/../secrets.json'], ['sites/x/index.html'], 'nope']) {
      const res = await post(port, { siteId: SITE, media }, cookie);
      assert.strictEqual(res.status, 400, `expected 400 for media ${JSON.stringify(media)}`);
    }
  } finally {
    server.close();
  }
});

test('POST /api/site-media fails closed (503) when the sites bucket is not configured — before any GCS touch', async () => {
  const server = await listen();
  try {
    const port = server.address().port;
    const res = await post(port, { siteId: SITE, media: [GOOD_NAME] }, sessionCookie('uid-1'));
    assert.strictEqual(res.status, 503);
    const j = await res.json();
    assert.match(String(j.error), /not enabled/i);
  } finally {
    server.close();
  }
});
