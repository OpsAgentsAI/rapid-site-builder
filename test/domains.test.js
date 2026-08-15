'use strict';
// Connect-your-domain unit tests (card DYE9159z) — run with `npm test`.
// Covers host normalization, the paid-tier gate, the CustomDomain → board
// summary translation (states + DNS records), and the attach/get REST calls
// with a fully mocked Firebase Hosting API (no live calls — pipe discipline).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DOM_PATH = path.join(__dirname, '..', 'lib', 'domains.js');
const ENV_KEYS = ['FIREBASE_HOSTING_SITE', 'FIREBASE_HOSTING_PROJECT', 'FIREBASE_PROJECT_ID',
  'GOOGLE_CLOUD_PROJECT', 'PAID_TIER_UIDS', 'PAID_TIER_OPEN'];

function freshDomains(env) {
  delete require.cache[require.resolve(DOM_PATH)];
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env || {});
  const mod = require(DOM_PATH);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  return mod;
}

const CONFIGURED = { FIREBASE_HOSTING_SITE: 'demo-site', FIREBASE_HOSTING_PROJECT: 'demo-project' };
// Injected token so no metadata/gcloud call ever happens in tests.
const tokenImpl = async () => 'test-token';

// A realistic CustomDomain resource, mid-verification (pending DNS + cert).
const PENDING_CD = {
  name: 'projects/demo-project/sites/demo-site/customDomains/shop.example.com',
  hostState: 'HOST_UNREACHABLE',
  ownershipState: 'OWNERSHIP_PENDING',
  reconciling: true,
  cert: { state: 'CERT_PREPARING' },
  requiredDnsUpdates: {
    checkTime: '2026-08-10T00:00:00Z',
    desired: [{
      domainName: 'shop.example.com',
      records: [
        { domainName: 'shop.example.com', type: 'A', rdata: '199.36.158.100', requiredAction: 'ADD' },
        { domainName: 'shop.example.com', type: 'TXT', rdata: 'hosting-site-verification=abc123', requiredAction: 'ADD' },
        { domainName: 'shop.example.com', type: 'A', rdata: '1.2.3.4', requiredAction: 'REMOVE' }
      ]
    }]
  }
};
const LIVE_CD = {
  name: 'projects/demo-project/sites/demo-site/customDomains/shop.example.com',
  hostState: 'HOST_ACTIVE', ownershipState: 'OWNERSHIP_ACTIVE',
  cert: { state: 'CERT_ACTIVE' }, requiredDnsUpdates: {}
};

test('ENABLED reflects Hosting site+project configuration (fail-closed)', () => {
  assert.equal(freshDomains({}).ENABLED, false, 'unset config → disabled');
  assert.equal(freshDomains({ FIREBASE_HOSTING_SITE: 's' }).ENABLED, false, 'partial → disabled');
  assert.equal(freshDomains(CONFIGURED).ENABLED, true);
  // project falls back to FIREBASE_PROJECT_ID (shared with auth)
  assert.equal(freshDomains({ FIREBASE_HOSTING_SITE: 's', FIREBASE_PROJECT_ID: 'p' }).ENABLED, true);
});

test('normalizeHost accepts owned hosts and rejects junk / reserved zones', () => {
  const d = freshDomains(CONFIGURED);
  assert.equal(d.normalizeHost('Shop.Example.com'), 'shop.example.com');
  assert.equal(d.normalizeHost('https://shop.example.com/path'), 'shop.example.com');
  assert.equal(d.normalizeHost('shop.example.com:8080'), 'shop.example.com');
  assert.equal(d.normalizeHost('example.co.uk'), 'example.co.uk');
  assert.equal(d.normalizeHost(''), null);
  assert.equal(d.normalizeHost('not a domain'), null);
  assert.equal(d.normalizeHost('*.example.com'), null, 'no wildcards');
  assert.equal(d.normalizeHost('foo.web.app'), null, 'reserved Firebase zone');
  assert.equal(d.normalizeHost('foo.firebaseapp.com'), null, 'reserved Firebase zone');
});

test('isPaid gates on the uid allowlist (empty = nobody), open flag overrides', () => {
  const gated = freshDomains({ ...CONFIGURED, PAID_TIER_UIDS: 'uid-a, uid-b' });
  assert.equal(gated.isPaid('uid-a'), true);
  assert.equal(gated.isPaid('uid-x'), false);
  assert.equal(gated.isPaid(''), false);
  assert.equal(freshDomains(CONFIGURED).isPaid('uid-a'), false, 'empty allowlist → no one paid');
  assert.equal(freshDomains({ ...CONFIGURED, PAID_TIER_OPEN: '1' }).isPaid('anyone'), true);
});

test('summarize translates states + DNS records into the board shape', () => {
  const d = freshDomains(CONFIGURED);
  const s = d.summarize(PENDING_CD, 'shop.example.com');
  assert.equal(s.host, 'shop.example.com');
  assert.equal(s.hostState, 'HOST_UNREACHABLE');
  assert.equal(s.ownershipState, 'OWNERSHIP_PENDING');
  assert.equal(s.certState, 'CERT_PREPARING');
  assert.equal(s.status, 'pending');
  assert.equal(s.reconciling, true);
  // ADD records surface for copy-paste; the REMOVE one is split out.
  assert.equal(s.dns.add.length, 2);
  assert.equal(s.dns.remove.length, 1);
  assert.deepEqual(s.dns.add.map(r => r.type).sort(), ['A', 'TXT']);
  const a = s.dns.add.find(r => r.type === 'A');
  assert.equal(a.value, '199.36.158.100'); // rdata → value
  assert.equal(a.action, 'ADD');
});

test('overallStatus: live / securing / conflict / pending', () => {
  const d = freshDomains(CONFIGURED);
  assert.equal(d.summarize(LIVE_CD, 'x').status, 'live');
  assert.equal(d.overallStatus({ hostState: 'HOST_ACTIVE', ownershipState: 'OWNERSHIP_ACTIVE', cert: { state: 'CERT_PROPAGATING' } }), 'securing');
  assert.equal(d.overallStatus({ hostState: 'HOST_CONFLICT', ownershipState: 'OWNERSHIP_PENDING' }), 'conflict');
  assert.equal(d.overallStatus({ ownershipState: 'OWNERSHIP_MISSING' }), 'pending');
});

test('attachCustomDomain POSTs to the create endpoint and summarizes the resource', async () => {
  const d = freshDomains(CONFIGURED);
  let seen = {};
  const capture = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, text: async () => JSON.stringify(PENDING_CD) }; };
  const out = await d.attachCustomDomain('shop.example.com', { fetchImpl: capture, tokenImpl });
  assert.equal(seen.init.method, 'POST');
  assert.match(seen.url, /\/projects\/demo-project\/sites\/demo-site\/customDomains\?customDomainId=shop\.example\.com$/);
  assert.equal(seen.init.headers.Authorization, 'Bearer test-token');
  assert.equal(JSON.parse(seen.init.body) && typeof JSON.parse(seen.init.body), 'object'); // empty body {}
  assert.equal(out.status, 'pending');
  assert.equal(out.dns.add.length, 2);
});

test('attachCustomDomain on 409 falls through to a GET (resume polling)', async () => {
  const d = freshDomains(CONFIGURED);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ method: init.method, url });
    if (init.method === 'POST') return { ok: false, status: 409, text: async () => JSON.stringify({ error: { message: 'already exists' } }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(PENDING_CD) };
  };
  const out = await d.attachCustomDomain('shop.example.com', { fetchImpl, tokenImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].method, 'GET');
  assert.equal(out.status, 'pending');
});

test('getCustomDomain GETs the resource path and surfaces a live domain', async () => {
  const d = freshDomains(CONFIGURED);
  let seen = {};
  const fetchImpl = async (url, init) => { seen = { url, method: init.method }; return { ok: true, status: 200, text: async () => JSON.stringify(LIVE_CD) }; };
  const out = await d.getCustomDomain('shop.example.com', { fetchImpl, tokenImpl });
  assert.equal(seen.method, 'GET');
  assert.match(seen.url, /\/customDomains\/shop\.example\.com$/);
  assert.equal(out.status, 'live');
  assert.equal(out.certState, 'CERT_ACTIVE');
});

test('REST errors propagate with the Hosting message + status', async () => {
  const d = freshDomains(CONFIGURED);
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: { message: 'permission denied' } }) });
  await assert.rejects(() => d.getCustomDomain('shop.example.com', { fetchImpl, tokenImpl }),
    (e) => e.status === 403 && /permission denied/.test(e.message));
});

test('disabled deployment refuses attach/get instead of calling out', async () => {
  const d = freshDomains({});
  await assert.rejects(() => d.attachCustomDomain('shop.example.com', { tokenImpl }), /not configured/);
  await assert.rejects(() => d.getCustomDomain('shop.example.com', { tokenImpl }), /not configured/);
});

test('unwrap tolerates an Operation-wrapped CustomDomain response', () => {
  const d = freshDomains(CONFIGURED);
  const opEnvelope = { name: 'operations/abc', done: true, response: LIVE_CD };
  const s = d.summarize(opEnvelope, 'shop.example.com');
  assert.equal(s.status, 'live');
  assert.equal(s.certState, 'CERT_ACTIVE');
});
