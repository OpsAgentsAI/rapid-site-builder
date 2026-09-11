'use strict';
// lib/importSite.js — bring-my-own-website import (card OWIBIIsu).
// Everything runs offline: fetch + DNS are injected fakes, so the SSRF screen,
// the redirect re-validation, the size cap and the extraction are all exercised
// without a network.

const test = require('node:test');
const assert = require('node:assert');
const { importFromUrl, extractBrief, isPrivateIp, checkHop } = require('../lib/importSite');

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '10.1.2.3', family: 4 }];
const mixedLookup = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '169.254.169.254', family: 4 } // one private record poisons the set
];

function htmlResponse(body, headers = {}) {
  const h = { 'content-type': 'text/html; charset=utf-8', ...headers };
  return {
    ok: true, status: 200,
    headers: { get: (k) => h[k.toLowerCase()] ?? null },
    arrayBuffer: async () => Buffer.from(body, 'utf8')
  };
}

function redirectResponse(location) {
  const h = { location };
  return {
    ok: false, status: 302,
    headers: { get: (k) => h[k.toLowerCase()] ?? null },
    arrayBuffer: async () => Buffer.alloc(0)
  };
}

// ---- address screening -----------------------------------------------------------

test('isPrivateIp blocks loopback, RFC1918, link-local/metadata, CGNAT, IPv6 private', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.9.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.7', '0.0.0.0', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::9',
    '::ffff:127.0.0.1', '::ffff:192.168.0.10', 'not-an-ip']) {
    assert.equal(isPrivateIp(ip), true, ip + ' should be private/unsafe');
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isPrivateIp(ip), false, ip + ' should be public');
  }
});

test('checkHop rejects bad schemes, userinfo, odd ports and literal private IPs', async () => {
  assert.ok((await checkHop('ftp://example.com', publicLookup)).error);
  assert.ok((await checkHop('file:///etc/passwd', publicLookup)).error);
  assert.ok((await checkHop('https://user:pw@example.com', publicLookup)).error);
  assert.ok((await checkHop('https://example.com:8080/x', publicLookup)).error);
  assert.ok((await checkHop('http://127.0.0.1/latest', publicLookup)).error);
  assert.ok((await checkHop('http://169.254.169.254/computeMetadata', publicLookup)).error);
  assert.ok((await checkHop('nonsense', publicLookup)).error);
  const ok = await checkHop('https://example.com/', publicLookup);
  assert.ok(ok.url && !ok.error);
});

test('checkHop rejects hostnames that resolve to private space — even partially', async () => {
  assert.ok((await checkHop('https://internal.example.com/', privateLookup)).error);
  assert.ok((await checkHop('https://dns-pinned.example.com/', mixedLookup)).error);
});

// ---- fetch orchestration ---------------------------------------------------------

test('importFromUrl imports a well-formed homepage (and accepts a bare domain)', async () => {
  const page = `<!doctype html><html lang="en"><head>
    <title>Cafe Luna | Best specialty coffee in Tel Aviv</title>
    <meta name="description" content="Specialty coffee roasted in-house, pastries from our own oven.">
    <meta property="og:site_name" content="Cafe Luna">
    </head><body><h1>Welcome to Cafe Luna</h1><p>Espresso bar and bakery.</p></body></html>`;
  const r = await importFromUrl('cafeluna.example', {
    fetchImpl: async () => htmlResponse(page), lookup: publicLookup
  });
  assert.equal(r.ok, true);
  assert.equal(r.brief.business, 'Cafe Luna');
  assert.match(r.brief.description, /Specialty coffee roasted in-house/);
  assert.equal(r.brief.lang, 'en');
  assert.equal(r.sourceHost, 'cafeluna.example');
});

test('importFromUrl follows redirects but dies on a redirect into private space', async () => {
  let calls = 0;
  const r = await importFromUrl('https://example.com', {
    fetchImpl: async () => { calls++; return redirectResponse('http://169.254.169.254/computeMetadata/v1/'); },
    lookup: publicLookup
  });
  assert.equal(r.ok, false);
  assert.equal(calls, 1, 'the metadata hop must never be fetched');
});

test('importFromUrl follows a public redirect and gives up after the cap', async () => {
  const r = await importFromUrl('https://example.com', {
    fetchImpl: async () => redirectResponse('https://example.com/next'),
    lookup: publicLookup
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /redirected too many times/);
});

test('importFromUrl rejects non-HTML and oversized bodies', async () => {
  const pdf = await importFromUrl('https://example.com/brochure.pdf', {
    fetchImpl: async () => htmlResponse('%PDF-1.4', { 'content-type': 'application/pdf' }),
    lookup: publicLookup
  });
  assert.equal(pdf.ok, false);

  const big = await importFromUrl('https://example.com', {
    fetchImpl: async () => htmlResponse('<title>Big</title>' + 'x'.repeat(2048)),
    lookup: publicLookup, maxBytes: 1024
  });
  assert.equal(big.ok, false);
  assert.match(big.error, /too large/);
});

test('importFromUrl surfaces unreachable / empty pages as friendly errors', async () => {
  const down = await importFromUrl('https://example.com', {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, lookup: publicLookup
  });
  assert.equal(down.ok, false);

  const empty = await importFromUrl('https://example.com', {
    fetchImpl: async () => htmlResponse('<html><body><script>var x=1;</script></body></html>'),
    lookup: publicLookup
  });
  assert.equal(empty.ok, false);
});

// ---- extraction ------------------------------------------------------------------

test('extractBrief prefers og:site_name and cleans marketing tails from titles', () => {
  const withOg = extractBrief('<title>Acme Corp — Home | Best plumbers</title><meta property="og:site_name" content="Acme Plumbing"/>');
  assert.equal(withOg.business, 'Acme Plumbing');
  const noOg = extractBrief('<title>Acme Corp — Home | Best plumbers</title>');
  assert.equal(noOg.business, 'Acme Corp');
});

test('extractBrief detects Hebrew sites and decodes entities', () => {
  const b = extractBrief(`<html lang="he"><head><title>מאפיית האחים</title>
    <meta name="description" content="לחם מחמצת &amp; מאפים טריים כל בוקר"></head>
    <body><h1>ברוכים הבאים</h1></body></html>`);
  assert.equal(b.lang, 'he');
  assert.equal(b.business, 'מאפיית האחים');
  assert.match(b.description, /לחם מחמצת & מאפים/);
});

test('extractBrief strips scripts/styles from the category text sample', () => {
  const b = extractBrief(`<title>Zen Studio</title>
    <script>var pilates = "never-see-me";</script>
    <style>.x{color:red}</style>
    <body><p>Boutique pilates and yoga classes.</p></body>`);
  assert.ok(!b.textSample.includes('never-see-me'));
  assert.match(b.textSample, /pilates and yoga/);
});
