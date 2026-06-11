'use strict';
// Mint a Google Cloud access token for raw Vertex AI REST calls.
// On Cloud Run the metadata server answers instantly; for local dev we fall
// back to `gcloud auth print-access-token` so the same code runs anywhere
// without key files. Tokens are cached until ~2 minutes before expiry.

const { execFile } = require('child_process');

let cached = { token: '', exp: 0 };

async function metadataToken() {
  const r = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2500) }
  );
  if (!r.ok) throw new Error('metadata token: ' + r.status);
  const d = await r.json();
  return { token: d.access_token, ttlSec: d.expires_in || 300 };
}

function gcloudToken() {
  return new Promise((resolve, reject) => {
    execFile('gcloud', ['auth', 'print-access-token'], { timeout: 15000 }, (err, stdout) => {
      if (err) return reject(new Error('gcloud token: ' + err.message));
      const token = String(stdout).trim();
      if (!token) return reject(new Error('gcloud token: empty'));
      resolve({ token, ttlSec: 600 });
    });
  });
}

async function getAccessToken() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  let got;
  try { got = await metadataToken(); }
  catch { got = await gcloudToken(); }
  cached = { token: got.token, exp: Date.now() + (got.ttlSec - 120) * 1000 };
  return cached.token;
}

module.exports = { getAccessToken };
