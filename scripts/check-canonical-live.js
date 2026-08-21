#!/usr/bin/env node
'use strict';
// ── The other direction of the retirement check (card sMdKZ7pQ) ──────────────
//
// deploy.yml's "Verify the retired surfaces stay retired" step asserts, after
// every deploy, that the two hackathon hosts are GONE and redirect to
// CANONICAL_APP_URL. It never asserts that CANONICAL_APP_URL answers. This does.
//
// 💰 ZERO SPEND, AND THAT IS A PROPERTY OF THE PROBE, NOT A HOPE.
// The /api/build probe posts an EMPTY brief. server.js does:
//     if (!rateOk(req))          return 429
//     const brief = cleanBrief(req.body || {}); if (!brief) return 400
//     if (!engine.ENABLED)       return 503
// so an empty body 400s at cleanBrief — before the engine check and before any
// Vertex call. test/ratelimit.test.js already leans on exactly that 400 as its
// "the limiter passed and the request reached the handler" marker. Cost is one
// of BUILDS_PER_HOUR_PER_IP (default 12) slots for the runner's IP, and no
// engine byte. Do NOT "improve" this into a real brief to make the check more
// end-to-end: that turns a CI step into recurring Vertex spend on every deploy.
//
// Usage:  node scripts/check-canonical-live.js
//         CANONICAL_ORIGINS="https://a,https://b" node scripts/check-canonical-live.js

const { canonicalFindings, healthIsContextOnly } = require('../lib/canonicalLive');

const DEFAULT_ORIGINS = [
  // the URL every client demo deck closes with (Pealton 07, Ford 04, and the
  // Notion PRD's canonical section spine — so every future deck too)
  'https://builder.opsagents.agency',
  // the Hosting site behind it. Both are checked so a lapsed custom-domain
  // mapping is distinguishable from a dead app: the *.web.app host staying
  // green while the deck URL dies is the whole failure the decks would suffer.
  'https://rapid-site-builder-app.web.app'
];

const TIMEOUT_MS = Number(process.env.CANONICAL_TIMEOUT_MS) || 25000;

async function probe(origin, path, init) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(origin + path, { redirect: 'manual', signal: ac.signal, ...init });
    return {
      origin, path,
      method: (init && init.method) || 'GET',
      status: res.status,
      location: res.headers.get('location') || undefined
    };
  } catch (e) {
    // A network failure must NOT read as "no finding". It produces a statusless
    // row, which the vacuity floor turns into SCAN LOOKS BROKEN.
    return { origin, path, method: (init && init.method) || 'GET', status: null, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const origins = (process.env.CANONICAL_ORIGINS || DEFAULT_ORIGINS.join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);

  const probes = [];
  const health = {};
  for (const o of origins) {
    probes.push(await probe(o, '/'));
    probes.push(await probe(o, '/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }));
    const h = await probe(o, '/api/health');
    health[o] = h.status === null ? `unreachable (${h.error})` : String(h.status);
  }

  for (const p of probes) {
    console.log(`probe  ${p.method.padEnd(4)} ${p.origin}${p.path} -> ${p.status === null ? 'NO RESPONSE (' + p.error + ')' : p.status}${p.location ? ' -> ' + p.location : ''}`);
  }
  console.log(healthIsContextOnly(health));

  const { broken, findings } = canonicalFindings({ expectedOrigins: origins, probes });
  if (findings.length === 0) {
    console.log(`✅ canonical surfaces live and un-retired: ${origins.join(' · ')}`);
    process.exitCode = 0;
    return;
  }
  for (const f of findings) console.log(`::error::${f}`);
  // 2 = the scan could not be trusted; 1 = the scan worked and found something.
  // Collapsing them would let a broken probe read as a broken product.
  process.exitCode = broken ? 2 : 1;
}

main();
