import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApiServer, extractModelIds, loadConfig, normalizeModelListUrl } from './api-server.mjs';
import { HttpError, isPublicIpAddress, matchesHostPattern, validateTargetUrl } from './security.mjs';

test('host patterns only match exact hosts or explicit suffixes', () => {
  assert.equal(matchesHostPattern('api.openai.com', 'api.openai.com'), true);
  assert.equal(matchesHostPattern('evil-api.openai.com', 'api.openai.com'), false);
  assert.equal(matchesHostPattern('cdn.openai.com', '*.openai.com'), true);
  assert.equal(matchesHostPattern('openai.com', '*.openai.com'), false);
  assert.equal(matchesHostPattern('openai.com', '.openai.com'), true);
});

test('private, reserved, and documentation IP ranges are blocked', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.103', '169.254.1.1', '100.64.0.1', '203.0.113.10', '::1', 'fd00::1', '::ffff:7f00:1']) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
});

test('target validation rejects a whitelisted hostname resolving privately', async () => {
  await assert.rejects(
    validateTargetUrl('https://api.example.com/v1', ['api.example.com'], async () => [
      { address: '192.168.1.10', family: 4 },
    ]),
    error => error instanceof HttpError && error.statusCode === 403 && error.type === 'private_target_blocked'
  );
});

test('target validation rejects non-HTTPS and non-whitelisted URLs before forwarding', async () => {
  await assert.rejects(
    validateTargetUrl('http://api.openai.com/v1', ['api.openai.com']),
    error => error instanceof HttpError && error.statusCode === 400
  );
  await assert.rejects(
    validateTargetUrl('https://example.com/v1', ['api.openai.com']),
    error => error instanceof HttpError && error.statusCode === 403
  );
});

test('model list helpers preserve existing provider response formats', () => {
  assert.equal(normalizeModelListUrl('https://api.openai.com/v1/chat/completions', 'openai'), 'https://api.openai.com/v1/models');
  assert.equal(normalizeModelListUrl('https://generativelanguage.googleapis.com/v1beta', 'gemini'), 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.deepEqual(extractModelIds({
    data: [{ id: 'gpt-4.1' }],
    models: [{ name: 'models/gemini-2.5-pro' }],
  }), ['gpt-4.1', 'gemini-2.5-pro']);
});

const startServer = async overrides => {
  const server = createApiServer({
    ...loadConfig({}),
    host: '127.0.0.1',
    port: 0,
    publicOrigins: [],
    rateMax: 100,
    expensiveRateMax: 100,
    ...overrides,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
};

test('health endpoint works while desktop file APIs stay disabled', async t => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.close());

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const desktop = await fetch(`${baseUrl}/api/choose-save-directory`, { method: 'POST' });
  assert.equal(desktop.status, 501);
  assert.equal((await desktop.json()).error.type, 'desktop_api_disabled');
});

test('cross-site API requests and non-whitelisted targets are rejected', async t => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.close());

  const crossSite = await fetch(`${baseUrl}/api/openai-chat-proxy`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://attacker.example',
      'sec-fetch-site': 'cross-site',
    },
    body: '{}',
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.type, 'cross_site_request');

  const blocked = await fetch(`${baseUrl}/api/openai-chat-proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetUrl: 'https://example.com/v1/chat/completions', apiKey: 'not-logged', payload: {} }),
  });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.type, 'target_not_allowed');
});

test('upload proxy is off until an approved target is configured', async t => {
  const { server, baseUrl } = await startServer({ uploadTarget: '' });
  t.after(() => server.close());
  const response = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: 'test' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.type, 'upload_proxy_disabled');
});

test('rate limiting returns 429 without contacting an upstream service', async t => {
  const { server, baseUrl } = await startServer({ rateMax: 1, expensiveRateMax: 1 });
  t.after(() => server.close());
  const first = await fetch(`${baseUrl}/api/not-found`, { method: 'POST' });
  assert.equal(first.status, 404);
  const second = await fetch(`${baseUrl}/api/not-found`, { method: 'POST' });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.type, 'rate_limited');
});
