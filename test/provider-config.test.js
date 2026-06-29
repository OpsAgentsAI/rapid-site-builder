'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveProviderConfig, locationFromResource } = require('../lib/providerConfig');

const RES = 'projects/p/locations/europe-west4/reasoningEngines/123';

test('managed: empty env yields the documented defaults, source=managed', () => {
  const c = resolveProviderConfig({}, {});
  assert.strictEqual(c.source, 'managed');
  assert.strictEqual(c.agentEngine.resource, '');
  assert.strictEqual(c.agentEngine.location, 'us-central1');
  assert.strictEqual(c.image.region, 'us-central1');
  assert.strictEqual(c.image.model, 'gemini-2.5-flash-image');
});

test('managed: reads env exactly as engine.js/images.js did before this slice', () => {
  const env = {
    AGENT_ENGINE_RESOURCE: RES,
    SITE_IMAGES_BUCKET: 'b', IMAGE_PROJECT: 'imgproj', IMAGE_REGION: 'global', IMAGE_MODEL: 'm',
    ARIZE_MCP_URL: 'https://x/mcp', ARIZE_MCP_API_KEY: 'k',
  };
  const c = resolveProviderConfig(undefined, env);
  assert.strictEqual(c.source, 'managed');
  assert.strictEqual(c.agentEngine.resource, RES);
  assert.strictEqual(c.agentEngine.location, 'europe-west4'); // derived from resource
  assert.strictEqual(c.image.project, 'imgproj');
  assert.strictEqual(c.image.region, 'global');
  assert.strictEqual(c.observability.mcpUrl, 'https://x/mcp');
});

test('AGENT_ENGINE_LOCATION env overrides the location parsed from the resource', () => {
  const c = resolveProviderConfig(undefined, { AGENT_ENGINE_RESOURCE: RES, AGENT_ENGINE_LOCATION: 'me-west1' });
  assert.strictEqual(c.agentEngine.location, 'me-west1');
});

test('BYOK override: tenant model creds flip source to byok and win over managed env', () => {
  const env = { AGENT_ENGINE_RESOURCE: RES, IMAGE_PROJECT: 'managed-img' };
  const overrides = {
    agentEngine: { resource: 'projects/t/locations/asia-east1/reasoningEngines/999' },
    image: { project: 'tenant-img' },
  };
  const c = resolveProviderConfig(overrides, env);
  assert.strictEqual(c.source, 'byok');
  assert.strictEqual(c.agentEngine.resource, 'projects/t/locations/asia-east1/reasoningEngines/999');
  assert.strictEqual(c.agentEngine.location, 'asia-east1'); // derived from the BYOK resource, not the managed one
  assert.strictEqual(c.image.project, 'tenant-img');
});

test('partial override without model creds stays managed but still applies the leaf', () => {
  const env = { AGENT_ENGINE_RESOURCE: RES, SITE_IMAGES_BUCKET: 'managed-bucket' };
  const c = resolveProviderConfig({ image: { bucket: 'tenant-bucket' } }, env);
  assert.strictEqual(c.source, 'managed'); // bucket-only override is not bringing model creds
  assert.strictEqual(c.image.bucket, 'tenant-bucket');
  assert.strictEqual(c.agentEngine.resource, RES); // managed model untouched
});

test('TENANT_PROVIDER_CONFIG json env injects BYOK without a per-call argument', () => {
  const env = {
    AGENT_ENGINE_RESOURCE: RES,
    TENANT_PROVIDER_CONFIG: JSON.stringify({ image: { project: 'env-tenant-img' } }),
  };
  const c = resolveProviderConfig(undefined, env);
  assert.strictEqual(c.source, 'byok');
  assert.strictEqual(c.image.project, 'env-tenant-img');
});

test('per-call overrides win over TENANT_PROVIDER_CONFIG', () => {
  const env = { TENANT_PROVIDER_CONFIG: JSON.stringify({ image: { project: 'from-env' } }) };
  const c = resolveProviderConfig({ image: { project: 'from-call' } }, env);
  assert.strictEqual(c.image.project, 'from-call');
});

test('malformed TENANT_PROVIDER_CONFIG never throws — falls back to managed', () => {
  const c = resolveProviderConfig(undefined, { AGENT_ENGINE_RESOURCE: RES, TENANT_PROVIDER_CONFIG: '{not json' });
  assert.strictEqual(c.source, 'managed');
  assert.strictEqual(c.agentEngine.resource, RES);
});

test('result is frozen so a build cannot mutate shared provider config', () => {
  const c = resolveProviderConfig({}, {});
  assert.ok(Object.isFrozen(c));
});

test('locationFromResource parses /locations/<x>/ and is empty on garbage', () => {
  assert.strictEqual(locationFromResource(RES), 'europe-west4');
  assert.strictEqual(locationFromResource('garbage'), '');
});
