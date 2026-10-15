import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../src/index.js';
import type { MockServer, MockServerConfig } from '../src/index.js';

function setup(config: MockServerConfig): MockServer {
  return createMockServer({ log: 'silent', seed: 42, latency: 0, ...config });
}

function req(server: MockServer, path: string, init?: RequestInit): Promise<Response> {
  return server.handler(new Request(new URL(path, 'http://localhost'), init));
}

test('matches static routes', async () => {
  const server = setup({ routes: [{ method: 'GET', path: '/health', body: { ok: true } }] });
  const res = await req(server, '/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await res.json(), { ok: true });
});

test('captures path params and query values', async () => {
  const server = setup({
    routes: [{ method: 'GET', path: '/users/:id/posts/:postId', body: { id: '{{ params.id }}', post: '{{ params.postId }}', q: '{{ query.q }}' } }],
  });
  const res = await req(server, '/users/42/posts/7?q=hello');
  assert.deepEqual(await res.json(), { id: '42', post: '7', q: 'hello' });
});

test('supports catch-all wildcard routes', async () => {
  const server = setup({ routes: [{ method: 'GET', path: '/files/*path', body: { path: '{{ params.path }}' } }] });
  const res = await req(server, '/files/a/b/c.txt');
  assert.deepEqual(await res.json(), { path: 'a/b/c.txt' });
});

test('parses JSON request bodies and exposes them to templates', async () => {
  const server = setup({
    routes: [{ method: 'POST', path: '/users', status: 201, body: { name: '{{ body.name }}', nested: '{{ body.profile.age }}' } }],
  });
  const res = await req(server, '/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada', profile: { age: 36 } }),
  });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { name: 'Ada', nested: 36 });
});

test('returns typed values for whole-string faker expressions', async () => {
  const server = setup({
    seed: 1,
    routes: [{ method: 'GET', path: '/n', body: { count: '{{ faker.int(5, 5) }}', label: 'value-{{ faker.int(5, 5) }}' } }],
  });
  const data = (await (await req(server, '/n')).json()) as { count: unknown; label: string };
  assert.equal(typeof data.count, 'number');
  assert.equal(data.count, 5);
  assert.equal(data.label, 'value-5');
});

test('applies the first matching payload rule', async () => {
  const server = setup({
    routes: [
      {
        method: 'GET',
        path: '/me',
        body: { role: 'user' },
        rules: [
          { when: { query: { role: 'admin' } }, body: { role: 'admin', secret: true } },
          { when: { headers: { 'x-tenant': { exists: true } } }, headers: { 'x-tenant-seen': 'yes' } },
        ],
      },
    ],
  });

  assert.deepEqual(await (await req(server, '/me')).json(), { role: 'user' });
  assert.deepEqual(await (await req(server, '/me?role=admin')).json(), { role: 'admin', secret: true });

  const tenant = await req(server, '/me', { headers: { 'x-tenant': 'acme' } });
  assert.equal(tenant.headers.get('x-tenant-seen'), 'yes');
});

test('matches rules against dot-paths in the body', async () => {
  const server = setup({
    routes: [
      {
        method: 'POST',
        path: '/orders',
        body: { tier: 'standard' },
        rules: [{ when: { body: { 'customer.vip': true } }, body: { tier: 'vip' } }],
      },
    ],
  });
  const res = await req(server, '/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customer: { vip: true } }),
  });
  assert.deepEqual(await res.json(), { tier: 'vip' });
});

test('cycles through a response sequence', async () => {
  const server = setup({
    routes: [
      {
        method: 'GET',
        path: '/flaky',
        sequence: [
          { status: 200, body: { attempt: 1 } },
          { status: 503, body: { attempt: 2 } },
        ],
      },
    ],
  });

  assert.equal((await req(server, '/flaky')).status, 200);
  assert.equal((await req(server, '/flaky')).status, 503);
  assert.equal((await req(server, '/flaky')).status, 200);
});

test('sequence with once=true holds the last entry', async () => {
  const server = setup({
    routes: [
      { method: 'GET', path: '/once', once: true, sequence: [{ status: 201 }, { status: 202 }] },
    ],
  });
  assert.equal((await req(server, '/once')).status, 201);
  assert.equal((await req(server, '/once')).status, 202);
  assert.equal((await req(server, '/once')).status, 202);
});

test('injects errors deterministically at rate 1', async () => {
  const server = setup({
    routes: [{ method: 'GET', path: '/boom', body: { ok: true } }],
    errors: { rate: 1, statuses: [503], body: { error: 'down' } },
  });
  const res = await req(server, '/boom');
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'down' });
});

test('honours per-route error rate', async () => {
  const server = setup({
    routes: [{ method: 'GET', path: '/x', body: { ok: true }, errorRate: 1, error: { status: 500 } }],
  });
  assert.equal((await req(server, '/x')).status, 500);
});

test('applies latency', async () => {
  const server = setup({ routes: [{ method: 'GET', path: '/slow', delay: 60, body: {} }] });
  const start = Date.now();
  await req(server, '/slow');
  assert.ok(Date.now() - start >= 55, 'should wait at least ~60ms');
});

test('falls back to 404 when nothing matches', async () => {
  const server = setup({ routes: [{ method: 'GET', path: '/known', body: {} }] });
  const res = await req(server, '/nope');
  assert.equal(res.status, 404);
  assert.match(((await res.json()) as { error: string }).error, /Not Found/);
});

test('echo fallback reflects the request', async () => {
  const server = setup({ fallback: 'echo', routes: [] });
  const res = await req(server, '/anything?a=1', { method: 'POST', body: 'hello' });
  const data = (await res.json()) as { method: string; path: string; query: Record<string, string>; body: string };
  assert.equal(data.method, 'POST');
  assert.equal(data.path, '/anything');
  assert.deepEqual(data.query, { a: '1' });
  assert.equal(data.body, 'hello');
});

test('strips basePath before matching', async () => {
  const server = setup({ basePath: '/api/v1', routes: [{ method: 'GET', path: '/ping', body: { pong: true } }] });
  assert.equal((await req(server, '/api/v1/ping')).status, 200);
  assert.equal((await req(server, '/ping')).status, 404);
});

test('answers CORS preflight', async () => {
  const server = setup({ cors: { origin: ['https://app.test'] }, routes: [] });
  const res = await req(server, '/users', {
    method: 'OPTIONS',
    headers: { origin: 'https://app.test', 'access-control-request-method': 'POST' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.test');
  assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
});

test('reflects wildcard CORS origin as *', async () => {
  const server = setup({ routes: [{ method: 'GET', path: '/x', body: {} }] });
  const res = await req(server, '/x', { headers: { origin: 'https://app.test' } });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('omits the body for HEAD requests', async () => {
  const server = setup({ routes: [{ method: 'GET', path: '/thing', body: { a: 1 } }] });
  const res = await req(server, '/thing', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

test('204 responses carry no body', async () => {
  const server = setup({ routes: [{ method: 'DELETE', path: '/users/:id', status: 204, body: { ignored: true } }] });
  const res = await req(server, '/users/1', { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
});

test('uses a function body from TS configs', async () => {
  const server = setup({
    routes: [
      {
        method: 'GET',
        path: '/dynamic',
        body: (ctx) => ({ method: ctx.method, id: ctx.params.id ?? null }),
      },
    ],
  });
  assert.deepEqual(await (await req(server, '/dynamic')).json(), { method: 'GET', id: null });
});

test('is deterministic for a fixed seed', async () => {
  const config: MockServerConfig = {
    seed: 123,
    latency: 0,
    log: 'silent',
    routes: [{ method: 'GET', path: '/r', body: { n: '{{ faker.int(1, 1000000) }}' } }],
  };
  const a = await (await req(createMockServer(config), '/r')).json();
  const b = await (await req(createMockServer(config), '/r')).json();
  assert.deepEqual(a, b);
});

test('merges global headers and interpolates them', async () => {
  const server = setup({
    headers: { 'x-powered-by': 'mock-server', 'x-id': '{{ params.id }}' },
    routes: [{ method: 'GET', path: '/u/:id', body: {} }],
  });
  const res = await req(server, '/u/9');
  assert.equal(res.headers.get('x-powered-by'), 'mock-server');
  assert.equal(res.headers.get('x-id'), '9');
});

test('serves the demo config with the expected routes', async () => {
  const { demoConfig } = await import('../src/index.js');
  const server = createMockServer({ ...demoConfig(), log: 'silent' });
  assert.equal((await server.handler(new Request('http://localhost/health'))).status, 200);
  assert.equal((await server.handler(new Request('http://localhost/users'))).status, 200);
  assert.equal((await server.handler(new Request('http://localhost/users/7'))).status, 200);
});
