import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchPath,
  matchValue,
  parseQuery,
  interpolate,
  createRng,
  registerFaker,
  resetFakers,
  hasFaker,
} from '../src/index.js';
import { normalizeConfig, MockConfigError } from '../src/config.js';
import type { RequestContext } from '../src/types.js';

/* -------------------------------------------------------------------------- */
/*  Path matching                                                             */
/* -------------------------------------------------------------------------- */

test('matchPath: static segments', () => {
  assert.deepEqual(matchPath('/users', '/users'), { params: {} });
  assert.equal(matchPath('/users', '/posts'), null);
  assert.equal(matchPath('/users', '/users/1'), null);
});

test('matchPath: parameters', () => {
  assert.deepEqual(matchPath('/users/:id', '/users/42'), { params: { id: '42' } });
  assert.deepEqual(matchPath('/u/:a/p/:b', '/u/1/p/2'), { params: { a: '1', b: '2' } });
});

test('matchPath: optional params', () => {
  assert.deepEqual(matchPath('/users/:id?', '/users'), { params: { id: '' } });
  assert.deepEqual(matchPath('/users/:id?', '/users/9'), { params: { id: '9' } });
});

test('matchPath: catch-all', () => {
  assert.deepEqual(matchPath('/files/*rest', '/files/a/b.txt'), { params: { rest: 'a/b.txt' } });
  assert.deepEqual(matchPath('*', '/anything/here'), { params: { wildcard: 'anything/here' } });
  assert.deepEqual(matchPath('/files/*path/download', '/files/a/b/download'), { params: { path: 'a/b' } });
  assert.equal(matchPath('/files/*path/download', '/files/a/b/other'), null);
});

test('matchPath: decodes URI components', () => {
  assert.deepEqual(matchPath('/users/:id', '/users/a%20b'), { params: { id: 'a b' } });
});

/* -------------------------------------------------------------------------- */
/*  Value matching                                                            */
/* -------------------------------------------------------------------------- */

test('matchValue: primitives and loose equality', () => {
  assert.equal(matchValue('5', 5), true);
  assert.equal(matchValue('true', true), true);
  assert.equal(matchValue('x', 'x'), true);
  assert.equal(matchValue('x', 'y'), false);
  assert.equal(matchValue('', 0), false);
  assert.equal(matchValue('   ', 0), false);
});

test('matchValue: operators', () => {
  assert.equal(matchValue('hello', { contains: 'ell' }), true);
  assert.equal(matchValue('hello', { startsWith: 'he' }), true);
  assert.equal(matchValue('hello', { endsWith: 'lo' }), true);
  assert.equal(matchValue('hello', { regex: '^h.*o$' }), true);
  assert.equal(matchValue('hello', { in: ['a', 'hello'] }), true);
  assert.equal(matchValue(5, { gt: 3 }), true);
  assert.equal(matchValue(5, { lt: 3 }), false);
  assert.equal(matchValue(null, { gte: 0 }), false);
  assert.equal(matchValue(false, { gte: 0 }), false);
  assert.equal(matchValue('', { gte: 0 }), false);
  assert.equal(matchValue(undefined, { exists: false }), true);
  assert.equal(matchValue(undefined, { exists: true }), false);
  assert.equal(matchValue('x', { not: 'y' }), true);
  assert.equal(matchValue([], { type: 'array' }), true);
});

/* -------------------------------------------------------------------------- */
/*  Query parsing                                                             */
/* -------------------------------------------------------------------------- */

test('parseQuery: single and repeated values', () => {
  const url = new URL('http://localhost/?a=1&b=2&b=3');
  assert.deepEqual(parseQuery(url), { a: '1', b: ['2', '3'] });
});

/* -------------------------------------------------------------------------- */
/*  Templating                                                                */
/* -------------------------------------------------------------------------- */

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  const url = new URL('http://localhost/users/1?role=admin');
  return {
    request: new Request(url),
    method: 'GET',
    url,
    path: '/users/1',
    params: { id: '1' },
    query: { role: 'admin' },
    headers: { 'x-key': 'secret' },
    cookies: { session: 'abc' },
    body: { user: { name: 'Ada' } },
    rawBody: '',
    route: null,
    state: new Map(),
    rng: createRng(1),
    ...overrides,
  };
}

test('interpolate: parameters, query, headers, body paths', () => {
  const ctx = context({
    body: { user: { name: 'Ada' }, items: [{ title: 'Widget' }] },
  });
  assert.equal(interpolate('{{ params.id }}', ctx), '1');
  assert.equal(interpolate('{{ query.role }}', ctx), 'admin');
  assert.equal(interpolate('{{ headers.x-key }}', ctx), 'secret');
  assert.equal(interpolate('{{ cookies.session }}', ctx), 'abc');
  assert.equal(interpolate('{{ body.user.name }}', ctx), 'Ada');
  assert.equal(interpolate('{{ body.items[0].title }}', ctx), 'Widget');
  assert.equal(interpolate('{{ body.constructor }}', ctx), '{{ body.constructor }}');
  assert.equal(interpolate('id-{{ params.id }}', ctx), 'id-1');
});

test('interpolate: recurses through objects and arrays', () => {
  const ctx = context();
  assert.deepEqual(interpolate({ a: ['{{ params.id }}', '{{ query.role }}'] }, ctx), { a: ['1', 'admin'] });
});

test('interpolate: returns raw values for whole-string expressions', () => {
  const ctx = context();
  assert.equal(interpolate('{{ body }}', ctx), ctx.body);
  assert.equal(typeof interpolate('{{ faker.int(1, 1) }}', ctx), 'number');
});

test('interpolate: leaves unknown expressions untouched', () => {
  const ctx = context();
  assert.equal(interpolate('{{ nope.missing }}', ctx), '{{ nope.missing }}');
  assert.equal(interpolate('a {{ unknown }} b', ctx), 'a {{ unknown }} b');
});

test('faker: registerFaker and resetFakers', () => {
  assert.equal(hasFaker('customFoo'), false);
  registerFaker('customFoo', () => 'bar');
  assert.equal(hasFaker('customFoo'), true);
  resetFakers();
  assert.equal(hasFaker('customFoo'), false);
});

/* -------------------------------------------------------------------------- */
/*  Config normalization                                                      */
/* -------------------------------------------------------------------------- */

test('normalizeConfig: applies sensible defaults', () => {
  const config = normalizeConfig({});
  assert.equal(config.port, 4000);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.fallback, '404');
  assert.equal(config.basePath, '');
  assert.deepEqual(config.latency, { distribution: 'fixed', fixed: 0 });
  assert.equal(config.errors, null);
  assert.notEqual(config.cors, false);
});

test('normalizeConfig: normalizes basePath and latency shorthand', () => {
  const config = normalizeConfig({ basePath: 'api/', latency: 250 });
  assert.equal(config.basePath, '/api');
  assert.deepEqual(config.latency, { distribution: 'fixed', fixed: 250 });
});

test('normalizeConfig: builds error config from errorRate shorthand', () => {
  const config = normalizeConfig({ errorRate: 0.25 });
  assert.equal(config.errors?.rate, 0.25);
  assert.deepEqual(config.errors?.statuses, [500]);
});

test('normalizeConfig: clamps out-of-range error rates', () => {
  assert.equal(normalizeConfig({ errorRate: 5 }).errors?.rate, 1);
  assert.equal(normalizeConfig({ errorRate: -1 }).errors?.rate, 0);
});

test('normalizeConfig: rejects invalid routes', () => {
  assert.throws(() => normalizeConfig({ routes: [{ path: '' }] }), MockConfigError);
  assert.throws(() => normalizeConfig({ routes: [{ path: '/x', status: 999 }] }), MockConfigError);
});

test('normalizeConfig: normalizes graphql into an array', () => {
  assert.equal(normalizeConfig({ graphql: { data: {} } }).graphql.length, 1);
  assert.equal(normalizeConfig({ graphql: [{}, {}] }).graphql.length, 2);
});
