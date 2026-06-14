'use strict';
// Published sites live in a private GCS bucket and are served through the app
// at /sites/:id. We always re-render server-side from the spec at publish time
// (never store client-supplied HTML), so the public surface only ever serves
// markup this codebase produced.

const crypto = require('crypto');
const { Storage } = require('@google-cloud/storage');

const BUCKET = process.env.PUBLISHED_SITES_BUCKET || '';
const storage = new Storage();

function newId() {
  return crypto.randomBytes(5).toString('hex').slice(0, 8);
}

async function saveSite(html, meta) {
  if (!BUCKET) throw new Error('PUBLISHED_SITES_BUCKET not configured');
  const id = newId();
  const b = storage.bucket(BUCKET);
  await b.file(`sites/${id}/index.html`).save(html, {
    contentType: 'text/html; charset=utf-8', resumable: false
  });
  await b.file(`sites/${id}/meta.json`).save(JSON.stringify({ ...meta, createdAt: new Date().toISOString() }), {
    contentType: 'application/json', resumable: false
  });
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
// login gate (VI673sym) will use — sign-in can later claim a device's markers.
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

module.exports = { saveSite, loadSite, rememberDeviceSite, listDeviceSites, saveLlms, loadLlms };
