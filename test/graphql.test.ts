import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer, parseGraphQL } from '../src/index.js';
import type { MockServer, JsonValue, GraphQLResolver } from '../src/index.js';

function graphqlServer(data: Record<string, JsonValue | GraphQLResolver>): MockServer {
  return createMockServer({ log: 'silent', latency: 0, graphql: { data } });
}

function gql(server: MockServer, body: unknown, init?: RequestInit): Promise<Response> {
  return server.handler(
    new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...init,
    }),
  );
}

test('parses fields, aliases, arguments and nested selections', () => {
  const doc = parseGraphQL(`
    query GetUser($id: ID = "1") {
      user(id: $id) {
        id
        handle: name
      }
      users(first: 2) {
        id
      }
    }
  `);

  assert.equal(doc.operations.length, 1);
  const op = doc.operations[0]!;
  const user = op.selection[0]!;
  assert.equal(user.kind, 'field');
  if (user.kind !== 'field') return;
  assert.equal(user.name, 'user');
  assert.deepEqual(user.args, { id: '1' }); // default applied from variable definition
  assert.equal(user.selection[1]!.kind, 'field');
});

test('expands fragment spreads during execution', async () => {
  const server = graphqlServer({ viewer: { id: '1', name: 'Ada', email: 'ada@example.com' } });
  const res = await gql(server, {
    query: `
      query { viewer { ...Fields } }
      fragment Fields on User { id name }
    `,
  });
  assert.deepEqual(await res.json(), { data: { viewer: { id: '1', name: 'Ada' } } });
});

test('resolves nested arrays and aliases', async () => {
  const server = graphqlServer({
    users: [
      { id: '1', name: 'Ada', address: { city: 'London' } },
      { id: '2', name: 'Alan', address: { city: 'London' } },
    ],
  });
  const res = await gql(server, { query: '{ users { id handle: name address { city } } }' });
  assert.deepEqual(await res.json(), {
    data: {
      users: [
        { id: '1', handle: 'Ada', address: { city: 'London' } },
        { id: '2', handle: 'Alan', address: { city: 'London' } },
      ],
    },
  });
});

test('applies list arguments (id, first)', async () => {
  const server = graphqlServer({ users: [{ id: '1' }, { id: '2' }, { id: '3' }] });
  assert.deepEqual(await (await gql(server, { query: '{ users(id: "2") { id } }' })).json(), {
    data: { users: [{ id: '2' }] },
  });
  assert.deepEqual(await (await gql(server, { query: '{ users(first: 2) { id } }' })).json(), {
    data: { users: [{ id: '1' }, { id: '2' }] },
  });
});

test('supports resolver functions with arguments', async () => {
  const server = createMockServer({
    log: 'silent',
    latency: 0,
    graphql: {
      data: {
        echo: (args) => ({ value: args?.value ?? null }),
      },
    },
  });
  assert.deepEqual(await (await gql(server, { query: '{ echo(value: "hi") { value } }' })).json(), {
    data: { echo: { value: 'hi' } },
  });
});

test('supports GET requests with query + variables', async () => {
  const server = graphqlServer({ user: { id: '7', name: 'Grace' } });
  const url = new URL('http://localhost/graphql');
  url.searchParams.set('query', 'query ($id: ID) { user(id: $id) { id name } }');
  url.searchParams.set('variables', JSON.stringify({ id: '7' }));
  const res = await server.handler(new Request(url));
  assert.deepEqual(await res.json(), { data: { user: { id: '7', name: 'Grace' } } });
});

test('injects __typename', async () => {
  const server = graphqlServer({ viewer: { id: '1' } });
  const res = await gql(server, { query: '{ __typename viewer { __typename id } }' });
  assert.deepEqual(await res.json(), { data: { __typename: 'Query', viewer: { __typename: 'viewer', id: '1' } } });
});

test('returns a 400 with GraphQL errors for invalid queries', async () => {
  const server = graphqlServer({});
  const res = await gql(server, { query: '{ users { id ' });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { errors: Array<{ message: string }> };
  assert.match(body.errors[0]!.message, /Syntax Error/);
});

test('returns an error when the query is missing', async () => {
  const server = graphqlServer({});
  const res = await gql(server, {});
  assert.equal(res.status, 400);
});

test('ignores unknown fields by returning null', async () => {
  const server = graphqlServer({ viewer: { id: '1' } });
  const res = await gql(server, { query: '{ viewer { id missing } }' });
  assert.deepEqual(await res.json(), { data: { viewer: { id: '1', missing: null } } });
});

test('honours a custom graphql path', async () => {
  const server = createMockServer({ log: 'silent', latency: 0, graphql: { path: '/api/gql', data: { ping: 'pong' } } });
  const res = await server.handler(
    new Request('http://localhost/api/gql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ ping }' }),
    }),
  );
  assert.deepEqual(await res.json(), { data: { ping: 'pong' } });
});
