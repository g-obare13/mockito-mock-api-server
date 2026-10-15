import { loadConfigFile, serve } from '../src/node.js';
import { buildServer } from '../src/server.js';
import { normalizeConfig } from '../src/config.js';
import type { MockServerConfig } from '../src/types.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}`, detail ?? '');
  }
}

async function start(configPath: string) {
  const loaded = await loadConfigFile(configPath);
  // Disable probabilistic error injection so the smoke run is deterministic;
  // error injection itself is exercised explicitly below and in unit tests.
  loaded.config.errorRate = 0;
  const server = buildServer(normalizeConfig(loaded.config as MockServerConfig));
  const node = await serve(server, { port: 0, host: '127.0.0.1' });
  return { node, base: node.url };
}

async function json(res: Response): Promise<any> {
  return res.json();
}

async function main(): Promise<void> {
  console.log('JSON config:');
  {
    const { node, base } = await start('examples/mock.config.json');

    const health = await fetch(`${base}/health`);
    const healthBody = await json(health);
    check('GET /health -> 200', health.status === 200, health.status);
    check('global header applied', health.headers.get('x-mock') === 'acme');
    check('templated now', typeof healthBody.at === 'string');

    const users = await fetch(`${base}/users?page=2`);
    const usersBody = await json(users);
    check('GET /users pages', usersBody.results.length === 2 && usersBody.page === '2', usersBody);

    const empty = await json(await fetch(`${base}/users?page=15`));
    check('payload rule (page >= 10)', Array.isArray(empty.results) && empty.results.length === 0, empty);

    const user = await json(await fetch(`${base}/users/9`));
    check('param + faker', user.id === '9' && typeof user.name === 'string' && user.name.length > 0, user);

    const notFound = await fetch(`${base}/users/9?id=404`);
    check('rule -> 404', notFound.status === 404, notFound.status);

    const created = await fetch(`${base}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Grace', email: 'grace@example.com' }),
    });
    const createdBody = await json(created);
    check('POST /users -> 201 + echo', created.status === 201 && createdBody.name === 'Grace', createdBody);

    const seq: number[] = [];
    for (let i = 0; i < 3; i++) seq.push((await fetch(`${base}/flaky`)).status);
    check('sequence 200,503,200', seq.join(',') === '200,503,200', seq);

    const gql = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ viewer { name } users { id name } }' }),
    });
    const gqlBody = await json(gql);
    check('graphql query', gqlBody.data?.viewer?.name === 'Ada Lovelace' && gqlBody.data.users.length === 2, gqlBody);

    const missing = await fetch(`${base}/nope`);
    check('unknown -> 404', missing.status === 404, missing.status);

    const cors = await fetch(`${base}/health`, { headers: { origin: 'https://x.test' } });
    check('CORS header', cors.headers.get('access-control-allow-origin') === '*');

    await node.close();
  }

  console.log('TS config:');
  {
    const { node, base } = await start('examples/mock.config.ts');

    const product = await json(await fetch(`${base}/products/ABC`));
    check('function body', product.sku === 'ABC' && typeof product.price === 'number', product);

    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada', password: 'secret' }),
    });
    check('login success', login.status === 200, login.status);

    const badLogin = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada', password: 'wrong' }),
    });
    check('login rule -> 401', badLogin.status === 401, badLogin.status);

    const countries = await json(await fetch(`${base}/countries`));
    check('fixture file route', Array.isArray(countries) && countries.length === 4, countries);

    await node.close();
  }

  console.log('Error injection:');
  {
    const loaded = await loadConfigFile('examples/mock.config.json');
    loaded.config.errorRate = 1;
    loaded.config.errors = { rate: 1, statuses: [503], body: { error: 'down' }, headers: { 'retry-after': '2' } };
    const server = buildServer(normalizeConfig(loaded.config as MockServerConfig));
    const node = await serve(server, { port: 0, host: '127.0.0.1' });

    const res = await fetch(`${node.url}/health`);
    check('forced error -> 503', res.status === 503, res.status);
    check('error header applied', res.headers.get('retry-after') === '2');
    check('error body applied', (await json(res)).error === 'down');

    await node.close();
  }

  console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
