import { defineConfig } from '../src/index.js';

/**
 * A TypeScript config gets full autocomplete, functions and imports.
 * Run it with: mock-server examples/mock.config.ts
 */
export default defineConfig({
  name: 'ts-config-demo',
  port: 4001,
  seed: 7,
  latency: { distribution: 'normal', mean: 120, stddev: 40 },
  errors: { rate: 0.02, statuses: [429, 503], headers: { 'retry-after': '1' } },

  routes: [
    // Function bodies get the full request context and can be async.
    {
      method: 'GET',
      path: '/products/:sku',
      body: async (ctx) => ({
        sku: ctx.params.sku,
        name: `Product ${ctx.params.sku}`,
        price: '{{ faker.price(5, 500) }}',
        inStock: ctx.query.inStock !== 'false',
      }),
    },

    // Conditional payloads driven by request shape.
    {
      method: 'POST',
      path: '/auth/login',
      body: { token: '{{ faker.token }}', user: { name: '{{ body.username }}' } },
      rules: [
        {
          name: 'reject bad credentials',
          when: { body: { password: { not: 'secret' } } },
          status: 401,
          body: { error: 'Invalid credentials' },
        },
      ],
    },

    // Proxy anything under /external to a real backend.
    { method: '*', path: '/external/*rest', passthrough: 'https://httpbin.org/anything/:rest' },

    // Serve a fixture file (resolved relative to this config).
    { method: 'GET', path: '/countries', file: './fixtures/countries.json' },
  ],

  graphql: {
    data: {
      products: [
        { id: '1', sku: 'ABC', name: 'Widget', price: 9.99 },
        { id: '2', sku: 'XYZ', name: 'Gadget', price: 24.5 },
      ],
      product: (args) => ({ id: String(args?.id ?? '1'), name: 'Widget', sku: 'ABC' }),
    },
  },
});
