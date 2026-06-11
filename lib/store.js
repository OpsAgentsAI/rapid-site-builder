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

module.exports = { saveSite, loadSite };
