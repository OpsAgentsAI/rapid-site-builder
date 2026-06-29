'use strict';
// Provider-credential dispatch (card Azz8fInK — BYOK-A).
//
// One place that decides WHERE the model + observability calls authenticate:
// either a per-tenant BYOK config (the customer's own Vertex project, Agent
// Engine, image project, and Arize Phoenix space) OR our managed defaults read
// from the process env (Secret Manager in prod). Same runtime code, two
// credential sources — a managed demo and a BYOK tenant run the identical build
// path, only the resolved config differs. This is the seam BYOK-B (per-tenant
// pricing) keys off via the returned `source`.
//
// No secrets live in this file or the public repo. Managed values come from env
// vars; BYOK values are injected either per call (the `overrides` argument, for
// a future per-request tenant context) or per deploy via a TENANT_PROVIDER_CONFIG
// JSON env var — so a BYOK tenant needs zero code changes and the public clone
// keeps running fully managed with nothing set.

// Managed config = exactly what engine.js / images.js read from env today, so
// resolveProviderConfig() with no overrides is behavior-preserving.
function managedFromEnv(env) {
  const resource = (env.AGENT_ENGINE_RESOURCE || '').trim();
  return {
    agentEngine: {
      resource,
      location: (env.AGENT_ENGINE_LOCATION || locationFromResource(resource) || 'us-central1').trim(),
    },
    image: {
      bucket: env.SITE_IMAGES_BUCKET || '',
      project: env.IMAGE_PROJECT || '',
      region: env.IMAGE_REGION || 'us-central1',
      model: env.IMAGE_MODEL || 'gemini-2.5-flash-image',
    },
    // Arize Phoenix MCP creds are consumed by the agent crew (BYO-key, see
    // docs/ARIZE_MCP.md) — surfaced here so the BYOK/managed split for the
    // observability sink is decided in the same place as the model creds.
    observability: {
      mcpUrl: (env.ARIZE_MCP_URL || '').trim(),
      apiKey: (env.ARIZE_MCP_API_KEY || '').trim(),
      authHeader: (env.ARIZE_MCP_AUTH_HEADER || '').trim(),
    },
  };
}

function locationFromResource(resource) {
  const m = String(resource || '').match(/\/locations\/([^/]+)\//);
  return m ? m[1] : '';
}

// A BYOK leaf wins only when it carries a real (non-empty) value, so a tenant
// can override just the model project and inherit our managed buckets.
function pick(over, base) {
  return over != null && over !== '' ? over : base;
}

function tenantConfigFromEnv(env) {
  const raw = (env.TENANT_PROVIDER_CONFIG || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A malformed tenant config must never crash a build — fall back to managed
    // and warn loudly (the deploy that set it should fix it).
    console.warn('[providerConfig] TENANT_PROVIDER_CONFIG is not valid JSON — ignoring, using managed config.');
    return {};
  }
}

/**
 * Resolve the provider/observability config for a build.
 * @param {object} [overrides] per-request BYOK config (future tenant context); wins over TENANT_PROVIDER_CONFIG and managed env.
 * @param {object} [env] env source (defaults to process.env; injectable for tests).
 * @returns {{agentEngine:{resource:string,location:string},image:{bucket:string,project:string,region:string,model:string},observability:{mcpUrl:string,apiKey:string,authHeader:string},source:'byok'|'managed'}}
 */
function resolveProviderConfig(overrides, env) {
  env = env || process.env;
  const managed = managedFromEnv(env);
  // BYOK input = per-deploy tenant env, with per-call overrides layered on top.
  const tenant = tenantConfigFromEnv(env);
  const byok = {
    agentEngine: { ...(tenant.agentEngine || {}), ...((overrides && overrides.agentEngine) || {}) },
    image: { ...(tenant.image || {}), ...((overrides && overrides.image) || {}) },
    observability: { ...(tenant.observability || {}), ...((overrides && overrides.observability) || {}) },
  };

  const ae = byok.agentEngine;
  const resource = pick(ae.resource, managed.agentEngine.resource);
  // When BYOK supplies a resource but no explicit location, derive it from the
  // BYOK resource rather than leaking the managed location.
  const location = ae.location
    ? ae.location
    : (ae.resource ? (locationFromResource(ae.resource) || 'us-central1') : managed.agentEngine.location);

  const img = byok.image;
  const obs = byok.observability;

  // `source` drives BYOK-B pricing: a build is BYOK only when the tenant brought
  // their own MODEL creds (Agent Engine resource or image project). Overriding
  // only a bucket or the Arize sink is still a managed-model build.
  const source = (ae.resource || img.project) ? 'byok' : 'managed';

  return Object.freeze({
    agentEngine: { resource: (resource || '').trim(), location: (location || 'us-central1').trim() },
    image: {
      bucket: pick(img.bucket, managed.image.bucket),
      project: pick(img.project, managed.image.project),
      region: pick(img.region, managed.image.region),
      model: pick(img.model, managed.image.model),
    },
    observability: {
      mcpUrl: pick(obs.mcpUrl, managed.observability.mcpUrl),
      apiKey: pick(obs.apiKey, managed.observability.apiKey),
      authHeader: pick(obs.authHeader, managed.observability.authHeader),
    },
    source,
  });
}

module.exports = { resolveProviderConfig, locationFromResource };
