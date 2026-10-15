# @mockito/mock-api-server

**Zero-config mock REST & GraphQL endpoints with customizable latency, error injection and payload rules — from a simple config file.**

Pure TypeScript. **No runtime dependencies.** The core is a Web-standard `Request → Response` handler, so the same mock API runs in Node, Bun, Deno, Cloudflare Workers, Vercel/Netlify functions, or right inside your test suite.

```
┌──────────────┐   Request    ┌───────────────────────────┐   Response
│ fetch / test │ ───────────▶ │  mock-server core handler │ ───────────▶
│ HTTP client  │              │  routing · rules · faker  │
└──────────────┘              │  latency · errors · gql   │
                              └───────────────────────────┘
```

## Features

- 🚀 **Zero config to start** — `npx mock-server` boots a working demo API.
- 🧩 **REST routes** with path params (`:id`), wildcards (`*rest`), optional segments and priorities.
- 🎛️ **Payload rules** — override status/body/headers based on query, headers, cookies or JSON body.
- ⏱️ **Latency simulation** — fixed, uniform, normal or exponential distributions, with jitter.
- 💥 **Error injection** — probabilistic 5xx/4xx, custom bodies, hangs and connection resets.
- 🧬 **Templating + faker** — `{{ params.id }}`, `{{ body.name }}`, `{{ faker.email }}`, `{{ faker.int(1, 9) }}`.
- 🔁 **Response sequences** — return a different response on each request (great for retry/polling logic).
- 🧠 **GraphQL mocking** — schema-less field resolution with aliases, variables, fragments and list args.
- 🔌 **Passthrough / proxy** — forward some (or all) traffic to a real backend.
- 🅰️ **CORS** on by default; configurable or disabled.
- 🧾 **JSON or TypeScript configs** — TS configs get autocomplete, functions and imports.
- 🌍 **Runs anywhere** — library-first core, plus a thin Node adapter and CLI.

## Quick start

```bash
# 1. Just try it — no config needed
npx @mockito/mock-api-server

# 2. Or scaffold a config
npx @mockito/mock-api-server --init
npx @mockito/mock-api-server mock.config.json
```

```bash
curl http://localhost:4000/users/42
# {"id":"42","name":"Grace Lovelace","email":"grace.lovelace@example.com"}
```

## Configuration

A config is an object, in JSON or TypeScript. Config files are auto-discovered:
`mock.config.ts|js|mjs|cjs|json`, `mock-server.config.*`, or `.mockrc.json`.

### JSON

```json
{
  "$schema": "./node_modules/@mockito/mock-api-server/schema.json",
  "port": 4000,
  "latency": { "distribution": "uniform", "min": 50, "max": 250 },
  "errors": { "rate": 0.05, "statuses": [500, 503] },
  "routes": [
    { "method": "GET", "path": "/users/:id", "body": { "id": "{{ params.id }}" } }
  ],
  "graphql": { "data": { "viewer": { "id": "1", "name": "Ada" } } }
}
```

Adding the `$schema` line gives you editor autocomplete + validation.

### TypeScript

```ts
import { defineConfig } from '@mockito/mock-api-server';

export default defineConfig({
  port: 4001,
  routes: [
    {
      method: 'GET',
      path: '/products/:sku',
      // function bodies receive the full request context (and may be async)
      body: async (ctx) => ({ sku: ctx.params.sku, at: '{{ now }}' }),
    },
  ],
});
```

> **Loading `.ts` configs:** the CLI uses your current Node runtime. On Node 22.18+/24+ `.ts` works out of the box; on Node 22.6–22.17 run with `node --experimental-strip-types`.

## Routes

```json
{
  "method": "GET",
  "path": "/users/:id",
  "status": 200,
  "headers": { "cache-control": "no-store" },
  "body": { "id": "{{ params.id }}" },
  "delay": 100
}
```

| Path pattern | Matches |
| --- | --- |
| `/users/:id` | `/users/42` → `params.id = "42"` |
| `/users/:id?` | `/users` (empty) and `/users/42` |
| `/files/*rest` | `/files/a/b.txt` → `params.rest = "a/b.txt"` |
| `*` | anything |

- `method` accepts one method, an array, or `*`. `HEAD` is served by `GET` handlers.
- `body` may be any JSON value, a template string, or a **function** (TS configs).
- `file` serves the body from a JSON/text file relative to the config file.
- `priority` (default `0`) orders competing routes; higher wins. First declared wins ties.

## Templating & faker

Any string may contain `{{ expressions }}`. A whole-string expression keeps its native type:

```json
{ "count": "{{ faker.int(5, 5) }}", "label": "id-{{ params.id }}" }
```
→ `{ "count": 5, "label": "id-42" }`

| Expression | Value |
| --- | --- |
| `{{ params.x }}` | route parameter |
| `{{ query.x }}` | query-string value |
| `{{ headers.x-api-key }}` | request header |
| `{{ cookies.session }}` | cookie |
| `{{ body.user.name }}` | dot-path into the parsed body |
| `{{ method }}` `{{ path }}` `{{ url }}` | request metadata |
| `{{ now }}` / `{{ now.date }}` / `{{ now.timestamp }}` | timestamps |
| `{{ faker.<fn>(args) }}` | generated value |

Built-in fakers: `firstName`, `lastName`, `fullName`/`name`, `email`, `username`, `phone`, `uuid`, `id`, `int`/`number`, `float`, `decimal`, `bool`/`boolean`, `price`, `date`, `isoDate`, `time`, `timestamp`, `url`, `domain`, `ipv4`, `ipv6`, `mac`, `city`, `country`, `countryCode`, `zip`/`postalCode`, `street`, `address`, `latitude`, `longitude`, `company`, `jobTitle`, `slug`, `word`, `words`, `sentence`, `paragraph`, `color`/`hexColor`, `avatar`, `image`, `token`, `password`, `currency`, `pick`, `random`.

Register your own:

```ts
import { registerFaker } from '@mockito/mock-api-server';
registerFaker('orderId', (rng) => `ORD-${rng.int(1000, 9999)}`);
// → "{{ faker.orderId }}"
```

## Payload rules

The first rule whose `when` matches wins, and only the fields it sets are overridden.

```json
{
  "method": "GET",
  "path": "/users/:id",
  "body": { "id": "{{ params.id }}", "role": "member" },
  "rules": [
    {
      "name": "missing user",
      "when": { "query": { "id": "404" } },
      "status": 404,
      "body": { "error": "User not found" }
    },
    {
      "when": { "headers": { "x-tenant": { "exists": true } } },
      "headers": { "x-tenant-seen": "yes" }
    }
  ]
}
```

Conditions can inspect `method`, `path` (string or `{ "regex": "..." }`), `query`, `headers`, `cookies` and `body` (dot-paths). Values use these matchers:

| Matcher | Example |
| --- | --- |
| literal equality | `"role": "admin"` |
| `equals` / `not` | `{ "not": "guest" }` |
| `in` | `{ "in": ["a", "b"] }` |
| `contains` / `startsWith` / `endsWith` | `{ "contains": "adm" }` |
| `regex` (+`flags`) | `{ "regex": "^v\\d+$" }` |
| `exists` | `{ "exists": true }` |
| `gt` / `gte` / `lt` / `lte` | `{ "gte": 10 }` |
| `type` | `{ "type": "array" }` |

## Sequences

Return a different response per request. `once: true` holds the last entry.

```json
{
  "method": "GET",
  "path": "/flaky",
  "sequence": [
    { "status": 500, "body": { "error": "boom" } },
    { "status": 200, "body": { "ok": true } }
  ]
}
```

## Latency

```json
{ "latency": 200 }                                                   // fixed
{ "latency": { "distribution": "uniform", "min": 50, "max": 300 } }
{ "latency": { "distribution": "normal", "mean": 120, "stddev": 40 } }
{ "latency": { "distribution": "exponential", "mean": 100 } }
{ "latency": { "fixed": 100, "jitter": 25 } }
```

Set globally, per-route, per-rule or per-sequence-entry. `delay` is shorthand for a fixed latency. Give a `seed` for reproducible jitter.

## Error injection

```json
{
  "errors": {
    "rate": 0.1,
    "statuses": [500, 503],
    "messages": ["upstream timeout"],
    "headers": { "retry-after": "1" },
    "delay": 500
  }
}
```

- `rate` (or `probability`) — fraction of requests affected, `0..1`.
- `status` / `statuses` (alias `codes`) — status code(s) to choose from.
- `body` / `messages` — response body (a random message becomes `{ error, status }`).
- `hang: true` — never respond (client times out). `connection: "reset" | "close"` (Node adapter) — abort the socket.
- Override globally, per-route (`errorRate` / `error`) or per-rule.

## GraphQL

Schema-less: the query is parsed and projected against your `data` map.

```json
{
  "graphql": {
    "path": "/graphql",
    "data": {
      "viewer": { "id": "1", "name": "Ada Lovelace" },
      "users": [
        { "id": "1", "name": "Ada Lovelace" },
        { "id": "2", "name": "Alan Turing" }
      ]
    }
  }
}
```

```graphql
query {
  viewer { id name }
  admins: users(role: "admin") { id }   # aliases + arguments
  users(first: 2) { id name }           # list args: id, ids, first, last, limit, offset, where
}
```

Supports variables, fragments, inline fragments, directives and `__typename`. Values may be resolver functions in TS configs:

```ts
graphql: {
  data: {
    product: (args) => ({ id: String(args?.id ?? '1'), name: 'Widget' }),
  },
}
```

## Passthrough & proxy

Forward some routes to a real backend (path params are substituted):

```json
{ "method": "*", "path": "/external/*rest", "passthrough": "https://api.example.com/:rest" }
```

Or proxy **all** unmatched traffic by setting a base URL:

```json
{ "proxy": "https://api.example.com" }
```

Unmatched requests are then forwarded (method, headers and body preserved).

## Using it as a library

### Runtime-agnostic core

```ts
import { createMockServer } from '@mockito/mock-api-server';

const server = createMockServer({
  routes: [{ method: 'GET', path: '/users/:id', body: { id: '{{ params.id }}' } }],
});

const res = await server.handler(new Request('http://localhost/users/1'));
await res.json(); // { id: '1' }
```

### Cloudflare Worker / edge / serverless

```ts
import { createMockServer } from '@mockito/mock-api-server';

const server = createMockServer({
  routes: [{ method: 'GET', path: '/health', body: { ok: true } }],
});

export default { fetch: (request: Request) => server.handler(request) };
```

### Node

```ts
import { loadConfig, serve } from '@mockito/mock-api-server/node';
import { buildServer } from '@mockito/mock-api-server';

const node = await serve(buildServer(await loadConfig('mock.config.json')));
console.log(node.url);
// ... later
await node.close();
```

### In unit tests (no network, no ports)

```ts
import { createMockServer } from '@mockito/mock-api-server';

const server = createMockServer({ routes: [/* ... */] });
globalThis.fetch = ((input: RequestInfo, init?: RequestInit) =>
  server.handler(new Request(input as string, init))) as typeof fetch;
```

## CLI

```
mock-server [config] [options]

  -p, --port <n>         Port to listen on              (default 4000)
  -H, --host <host>      Host/interface to bind         (default 0.0.0.0)
      --base-path <path> Prefix stripped before matching
      --latency <ms>     Fixed latency added to every response
      --error-rate <0-1> Fraction of requests that error
      --seed <n>         Deterministic seed for jitter/faker
      --no-cors          Disable CORS headers
      --log <level>      silent | error | info | debug   (default info)
      --json             Emit logs as JSON
  -w, --watch            Reload when the config file changes
      --init [file]      Write a starter config and exit (default mock.config.json)
  -h, --help             Show help
  -v, --version          Show version
```

## Config reference

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | `mock-server` | Banner label |
| `port` / `host` | number / string | `4000` / `0.0.0.0` | Listen address |
| `basePath` | string | — | Prefix stripped before matching |
| `seed` | number | random | Deterministic RNG seed |
| `latency` | number \| object | `0` | Global default latency |
| `errorRate` | number | — | Global error probability |
| `errors` | object | — | Full error-injection config |
| `cors` | boolean \| object | on (`*`) | CORS policy |
| `headers` | object | — | Headers added to every response (templated) |
| `log` / `logFormat` | level / `pretty`\|`json` | `info` / `pretty` | Logging |
| `routes` | array | `[]` | REST routes |
| `graphql` | object \| array | — | GraphQL endpoints |
| `fallback` | `404` \| `echo` | `404` | Unmatched-request behaviour |
| `proxy` | string | — | Upstream base URL for unmatched requests |

## Project layout

```
src/
  index.ts        public, runtime-agnostic entrypoint
  node.ts         Node http adapter + config loading
  cli.ts/bin.ts   command-line interface
  server.ts       routing, rules, sequences, error/latency pipeline
  matcher.ts      path + condition matching
  template.ts     {{ ... }} engine
  faker.ts        dependency-free generators (+ registry)
  latency.ts      delay distributions
  response.ts     Response building, CORS
  graphql/        query parser, schema-less resolver, handler
  types.ts        all public types
test/             node:test suites (52 tests)
examples/         JSON + TS example configs
schema.json       JSON Schema for editor autocomplete
```

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node:test via tsx
npm run build         # tsup → ESM + CJS + .d.ts
npm run cli -- --init # run the CLI from source
```

## License

[MIT](./LICENSE)
