'use strict';
// Published sites live in a private GCS bucket and are served through the app
// at /sites/:id. We always re-render server-side from the spec at publish time
// (never store client-supplied HTML), so the public surface only ever serves
// markup this codebase produced.
//
// Ownership (card VI673sym): when the publisher is signed in, meta.json is
// stamped ownerUid/ownerEmail and a small index object is written under
// owners/{uid}/{id}.json — listing a user's sites is then one cheap prefix
// list instead of a scan over every published site.

const crypto = require('crypto');
const { Storage } = require('@google-cloud/storage');

const BUCKET = process.env.PUBLISHED_SITES_BUCKET || '';
const storage = new Storage();

function newId() {
  return crypto.randomBytes(5).toString('hex').slice(0, 8);
}

async function saveSite(html, meta, owner) {
  if (!BUCKET) throw new Error('PUBLISHED_SITES_BUCKET not configured');
  const id = newId();
  const b = storage.bucket(BUCKET);
  const createdAt = new Date().toISOString();
  const record = { ...meta, createdAt };
  if (owner && owner.uid) {
    record.ownerUid = owner.uid;
    if (owner.email) record.ownerEmail = owner.email;
  }
  await b.file(`sites/${id}/index.html`).save(html, {
    contentType: 'text/html; charset=utf-8', resumable: false
  });
  await b.file(`sites/${id}/meta.json`).save(JSON.stringify(record), {
    contentType: 'application/json', resumable: false
  });
  if (owner && owner.uid) {
    await b.file(`owners/${owner.uid}/${id}.json`).save(
      JSON.stringify({ id, business: record.business || '', createdAt }),
      { contentType: 'application/json', resumable: false }
    );
  }
  return id;
}

async function loadSite(id) {
  if (!BUCKET) return null;
  if (!/^[a-f0-9]{8}$/.test(String(id))) return null;
  try {
    const [buf] = await storage.bucket(BUCKET).file(`sites/${id}/index.html`).download();
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

// Anonymous device → sites memory (card jvsQp6cS). One marker object per
// publish under devices/<deviceId>/, mirroring the owners/{uid}/ pattern the
// login gate (VI673sym) uses — sign-in can later claim a device's markers.
// Both segments are regex-validated so no caller input ever shapes a path.
const DEVICE_RE = /^[a-f0-9]{32}$/;
const SITE_RE = /^[a-f0-9]{8}$/;

async function rememberDeviceSite(deviceId, siteId) {
  if (!BUCKET) return;
  if (!DEVICE_RE.test(String(deviceId)) || !SITE_RE.test(String(siteId))) return;
  await storage.bucket(BUCKET).file(`devices/${deviceId}/${siteId}`).save('{}', {
    contentType: 'application/json', resumable: false
  });
}

async function listDeviceSites(deviceId) {
  if (!BUCKET) return [];
  if (!DEVICE_RE.test(String(deviceId))) return [];
  const b = storage.bucket(BUCKET);
  const [files] = await b.getFiles({ prefix: `devices/${deviceId}/` });
  const ids = files
    .map(f => f.name.split('/').pop())
    .filter(id => SITE_RE.test(id))
    .slice(0, 50);
  const sites = await Promise.all(ids.map(async (id) => {
    try {
      const [buf] = await b.file(`sites/${id}/meta.json`).download();
      const meta = JSON.parse(buf.toString('utf8'));
      return { id, business: String(meta.business || ''), createdAt: String(meta.createdAt || '') };
    } catch {
      return null; // site deleted or meta unreadable — skip, don't fail the list
    }
  }));
  return sites.filter(Boolean)
    .sort((a, b2) => (b2.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 20);
}

// llms.txt rides alongside index.html under the same site id — fixed filename,
// so there is no caller-controlled path segment beyond the validated id.
async function saveLlms(id, text) {
  if (!BUCKET) throw new Error('PUBLISHED_SITES_BUCKET not configured');
  if (!/^[a-f0-9]{8}$/.test(String(id))) throw new Error('Bad site id');
  await storage.bucket(BUCKET).file(`sites/${id}/llms.txt`).save(text, {
    contentType: 'text/plain; charset=utf-8', resumable: false
  });
}

async function loadLlms(id) {
  if (!BUCKET) return null;
  if (!/^[a-f0-9]{8}$/.test(String(id))) return null;
  try {
    const [buf] = await storage.bucket(BUCKET).file(`sites/${id}/llms.txt`).download();
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

// Newest-first list of the caller's published sites, from the owner index.
// Index objects are tiny JSON; 100 cap keeps the response and the GCS reads bounded.
async function listSitesByOwner(uid) {
  if (!BUCKET || !uid) return [];
  const [files] = await storage.bucket(BUCKET).getFiles({
    prefix: `owners/${uid}/`, maxResults: 100
  });
  const sites = [];
  for (const f of files) {
    try {
      const [buf] = await f.download();
      const s = JSON.parse(buf.toString('utf8'));
      if (s && /^[a-f0-9]{8}$/.test(String(s.id))) sites.push(s);
    } catch { /* one bad index object must not break the listing */ }
  }
  sites.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return sites;
}

// Cross-tenant list of EVERY published site, newest-first — the admin view
// (card fp7wXxjb). There is no global index, so this walks sites/<id>/meta.json
// directly. Hard caps protect an admin page load against a large bucket:
// MAX_ADMIN_SCAN bounds how many meta.json objects are downloaded per request
// (never the old "all up to 5000 serially"), the downloads run with bounded
// concurrency, and over-cap is logged — never silently dropped. Admin-only at
// the route. Projection is id/business/createdAt/ownerEmail ONLY: ownerUid is
// internal and the admin UI never renders it, so it must not leave the server.
const MAX_ADMIN_SCAN = 1000;
const ADMIN_SCAN_CONCURRENCY = 25;
async function listAllSites(limit = 500) {
  if (!BUCKET) return [];
  const [files] = await storage.bucket(BUCKET).getFiles({ prefix: 'sites/', maxResults: MAX_ADMIN_SCAN + 1 });
  let metas = files.filter(f => /^sites\/[a-f0-9]{8}\/meta\.json$/.test(f.name));
  if (metas.length > MAX_ADMIN_SCAN) {
    console.warn(`[admin] ${metas.length} sites exceed the ${MAX_ADMIN_SCAN} per-request scan cap — listing the first ${MAX_ADMIN_SCAN}.`);
    metas = metas.slice(0, MAX_ADMIN_SCAN);
  }
  const out = [];
  // Bounded-concurrency batches: never thousands of simultaneous (or fully
  // serial) GCS reads on one admin page load.
  for (let i = 0; i < metas.length; i += ADMIN_SCAN_CONCURRENCY) {
    const batch = await Promise.all(metas.slice(i, i + ADMIN_SCAN_CONCURRENCY).map(async (f) => {
      try {
        const [buf] = await f.download();
        const m = JSON.parse(buf.toString('utf8'));
        return {
          id: f.name.split('/')[1],
          business: String(m.business || ''),
          createdAt: String(m.createdAt || ''),
          ownerEmail: String(m.ownerEmail || '')
        };
      } catch { return null; /* one unreadable meta must not break the admin listing */ }
    }));
    for (const r of batch) if (r) out.push(r);
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out.slice(0, limit);
}

module.exports = { saveSite, loadSite, rememberDeviceSite, listDeviceSites, saveLlms, loadLlms, listSitesByOwner, listAllSites };
