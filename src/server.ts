/**
 * @file Core mock server: routing, payload rules, sequences, latency and errors.
 *
 * `buildServer` assembles a {@link MockServer} whose `handler` implements the full
 * request pipeline over Web-standard `Request`/`Response`, so it is runtime-agnostic.
 */

import { normalizeConfig } from './config.js';
import { computeLatency, sleep } from './latency.js';
import { matchPath, matchesWhen, parseCookies, parseQuery } from './matcher.js';
import { createRng } from './random.js';
import {
  CONNECTION_CONTROL,
  buildResponse,
  corsHeaders,
  preflightResponse,
  statusText,
  type WithConnection,
} from './response.js';
import { interpolate } from './template.js';
import { extractGraphQLRequest, runGraphQL } from './graphql/handler.js';
import type {
  CompiledRoute,
  CorsOptions,
  ErrorInjectionOptions,
  GraphQLConfig,
  HttpMethod,
  MockServer,
  MockServerConfig,
  NormalizedConfig,
  NormalizedErrors,
  RequestContext,
  ResponseSpec,
  RouteConfig,
} from './types.js';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function normalizeMethods(method: RouteConfig['method']): Set<string> {
  if (!method || method === '*') return new Set(['*']);
  const list = Array.isArray(method) ? method : [method];
  return new Set(list.map((entry) => entry.toUpperCase()));
}

function routeMatches(route: CompiledRoute, method: string): boolean {
  if (route.matchAll) return true;
  if (route.methods.has(method.toUpperCase())) return true;
  // HEAD is served by GET handlers.
  return method.toUpperCase() === 'HEAD' && route.methods.has('GET');
}

function resolveEffectiveCors(
  routeCors: RouteConfig['cors'],
  globalCors: NormalizedConfig['cors'],
): CorsOptions | false {
  if (routeCors === false) return false;
  if (routeCors === true) return globalCors ? { ...globalCors } : { origin: '*' };
  if (routeCors && typeof routeCors === 'object') {
    return { ...(globalCors ? globalCors : {}), ...routeCors };
  }
  return globalCors;
}

function parseBody(raw: string, contentType: string | null): unknown {
  if (raw === '') return undefined;
  const ct = (contentType ?? '').toLowerCase();
  const looksJson = ct.includes('application/json') || /^\s*[[{]/.test(raw);
  if (looksJson) {
    try {
      return JSON.parse(raw);
    } catch {
      // fall through to raw text
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return raw;
}

interface EffectiveSpec {
  status?: number;
  headers: Record<string, string>;
  body?: unknown;
  latency?: ResponseSpec['latency'];
  delay?: number;
  error?: ErrorInjectionOptions;
  errorRate?: number;
}

function toSpec(source: ResponseSpec): EffectiveSpec {
  return {
    status: source.status,
    headers: { ...(source.headers ?? {}) },
    body: source.body,
    latency: source.latency,
    delay: source.delay,
    error: source.error,
    errorRate: source.errorRate,
  };
}

function applyOverride(base: EffectiveSpec, override: ResponseSpec | undefined): EffectiveSpec {
  if (!override) return base;
  return {
    status: override.status ?? base.status,
    headers: { ...base.headers, ...(override.headers ?? {}) },
    body: override.body !== undefined ? override.body : base.body,
    latency: override.latency !== undefined ? override.latency : base.latency,
    delay: override.delay !== undefined ? override.delay : base.delay,
    error: override.error !== undefined ? override.error : base.error,
    errorRate: override.errorRate !== undefined ? override.errorRate : base.errorRate,
  };
}

interface InjectedError {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  delay: number;
  hang: boolean;
  connection?: 'reset' | 'close';
}

function decideError(
  options: ErrorInjectionOptions | NormalizedErrors | null | undefined,
  rng: ReturnType<typeof createRng>,
): InjectedError | null {
  if (!options) return null;
  const rate = 'rate' in options ? options.rate : undefined;
  if (!rate || rng() >= rate) return null;

  const statuses = 'statuses' in options && options.statuses?.length ? options.statuses : [500];
  const status = rng.pick(statuses);

  const bodies = 'bodies' in options ? (options as NormalizedErrors).bodies : undefined;
  const single = 'body' in options ? (options as ErrorInjectionOptions).body : undefined;
  const messages = options.messages;

  let body: unknown;
  if (bodies && bodies.length > 0) body = rng.pick(bodies);
  else if (single !== undefined) body = single;
  else if (messages && messages.length > 0) body = { error: rng.pick(messages), status };
  else body = { error: statusText(status), status };

  return {
    status,
    body,
    headers: options.headers ?? {},
    delay: options.delay ?? 0,
    hang: options.hang ?? false,
    connection: options.connection,
  };
}

function resolveErrorOptions(
  error: ErrorInjectionOptions | undefined,
  errorRate: number | undefined,
  global: NormalizedErrors | null,
): ErrorInjectionOptions | NormalizedErrors | undefined {
  if (error || errorRate !== undefined) {
    return {
      ...(error ?? {}),
      rate: errorRate ?? error?.rate ?? error?.probability ?? 0,
    };
  }
  return global ?? undefined;
}

function logRequest(config: NormalizedConfig, entry: {
  method: string;
  path: string;
  status: number;
  ms: number;
  route: string | null;
  injected: boolean;
}): void {
  if (config.log === 'silent') return;
  if (config.log === 'error' && entry.status < 500) return;

  if (config.logFormat === 'json') {
    console.log(
      JSON.stringify({
        method: entry.method,
        path: entry.path,
        status: entry.status,
        durationMs: entry.ms,
        route: entry.route,
        injected: entry.injected || undefined,
      }),
    );
    return;
  }

  const color =
    entry.status >= 500 ? '\u001b[31m' : entry.status >= 400 ? '\u001b[33m' : '\u001b[32m';
  const reset = '\u001b[0m';
  const route = entry.route ?? '-';
  const injected = entry.injected ? ' (injected)' : '';
  console.log(
    `${entry.method.padEnd(6)} ${entry.path} ${color}${entry.status}${reset} ${entry.ms}ms${injected}  ${route}`,
  );
}

/* -------------------------------------------------------------------------- */
/*  Server                                                                    */
/* -------------------------------------------------------------------------- */

/** Build a mock server from an already-normalized config. */
export function buildServer(config: NormalizedConfig): MockServer {
  const rng = createRng(config.seed);
  const state = new Map<string, unknown>();

  const routes: CompiledRoute[] = config.routes
    .map((route, index) => ({
      config: route,
      methods: normalizeMethods(route.method),
      matchAll: !route.method || route.method === '*',
      stateKey: route.id ?? `${route.method ?? '*'}:${route.path}:${index}`,
      priority: route.priority ?? 0,
    }))
    .sort((a, b) => b.priority - a.priority);

  const graphqlEndpoints: GraphQLConfig[] = config.graphql.map((entry) => ({
    ...entry,
    path: entry.path ?? '/graphql',
  }));

  const baseHeaders = { ...config.headers };

  async function readRawBody(request: Request): Promise<string> {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') return '';
    try {
      return await request.text();
    } catch {
      return '';
    }
  }

  function buildContext(
    request: Request,
    url: URL,
    path: string,
    params: Record<string, string>,
    route: RouteConfig | null,
    rawBody: string,
  ): RequestContext {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    return {
      request,
      method: request.method.toUpperCase(),
      url,
      path,
      params,
      query: parseQuery(url),
      headers,
      cookies: parseCookies(request.headers.get('cookie')),
      body: parseBody(rawBody, request.headers.get('content-type')),
      rawBody,
      route,
      state,
      rng,
    };
  }

  function handleGraphQL(
    config: GraphQLConfig,
    ctx: RequestContext,
    url: URL,
  ): { status: number; body: unknown; headers: Record<string, string> } {
    const parts = extractGraphQLRequest({
      method: ctx.method,
      url,
      contentType: ctx.headers['content-type'] ?? null,
      body: ctx.rawBody,
    });
    const outcome = runGraphQL(config, parts, ctx);
    return {
      status: outcome.status,
      body: outcome.payload,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    };
  }

  async function proxyRequest(
    target: string,
    request: Request,
    url: URL,
    params: Record<string, string>,
    rawBody: string,
  ): Promise<Response> {
    let targetUrl = target;
    for (const [key, value] of Object.entries(params)) {
      targetUrl = targetUrl.replace(`:${key}`, encodeURIComponent(value));
    }

    const resolved = /^https?:\/\//.test(targetUrl)
      ? new URL(targetUrl)
      : new URL((config.proxy ?? '') + (targetUrl.startsWith('/') ? targetUrl : `/${targetUrl}`));

    // Preserve the original query string when the target has none.
    if (!/^https?:\/\//.test(targetUrl) || resolved.search === '') {
      for (const [key, value] of url.searchParams) resolved.searchParams.append(key, value);
    }

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('content-length');

    const init: RequestInit = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD' && rawBody !== '') {
      init.body = rawBody;
    }

    try {
      const upstream = await fetch(resolved, init);
      const responseHeaders = new Headers(upstream.headers);
      for (const [key, value] of Object.entries(corsHeaders(config.cors, request.headers.get('origin')))) {
        responseHeaders.set(key, value);
      }
      for (const [key, value] of Object.entries(baseHeaders)) {
        responseHeaders.set(key, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildResponse({
        status: 502,
        headers: { ...baseHeaders, ...corsHeaders(config.cors, request.headers.get('origin')) },
        body: { error: 'Bad Gateway', message, target: resolved.toString() },
      });
    }
  }

  async function handler(request: Request): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    let path = url.pathname;
    let withinBasePath = true;
    if (config.basePath) {
      if (path === config.basePath) {
        path = '/';
      } else if (path.startsWith(`${config.basePath}/`)) {
        path = path.slice(config.basePath.length);
      } else {
        withinBasePath = false;
      }
    }

    const origin = request.headers.get('origin');

    // CORS preflight short-circuit.
    if (method === 'OPTIONS' && request.headers.has('access-control-request-method')) {
      let routeCorsOption: RouteConfig['cors'] | undefined;
      for (const route of withinBasePath ? routes : []) {
        if (matchPath(route.config.path, path)) {
          routeCorsOption = route.config.cors;
          break;
        }
      }
      const effectiveCors = resolveEffectiveCors(routeCorsOption, config.cors);
      if (effectiveCors === false) {
        return new Response(null, { status: 204 });
      }
      if (effectiveCors) {
        return preflightResponse(effectiveCors, origin, request.headers.get('access-control-request-headers'));
      }
    }

    const rawBody = await readRawBody(request);
    const cors = corsHeaders(config.cors, origin);

    // GraphQL endpoints.
    for (const endpoint of withinBasePath ? graphqlEndpoints : []) {
      if (endpoint.path === path && (method === 'POST' || method === 'GET')) {
        const ctx = buildContext(request, url, path, {}, null, rawBody);
        const result = handleGraphQL(endpoint, ctx, url);

        const injected = decideError(
          resolveErrorOptions(endpoint.errors, endpoint.errorRate, config.errors),
          rng,
        );

        const delay = computeLatency(endpoint.latency, config.latency, rng);
        const totalDelay = delay + (injected?.delay ?? 0);
        if (totalDelay > 0) await sleep(totalDelay, request.signal);

        let response: Response;
        let status: number;
        if (injected) {
          if (injected.hang) {
            return new Promise<Response>((_, reject) => {
              if (request.signal?.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
              }
              request.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
              }, { once: true });
            });
          }
          status = injected.status;
          response = buildResponse({
            status,
            headers: {
              ...baseHeaders,
              ...cors,
              ...(endpoint.headers ?? {}),
              ...injected.headers,
              'content-type': 'application/json; charset=utf-8',
            },
            body: interpolate(injected.body, ctx),
          });
        } else {
          if (result.status >= 400) {
            status = result.status;
            response = buildResponse({
              status,
              headers: { ...baseHeaders, ...cors, 'content-type': 'application/json; charset=utf-8' },
              body: result.body,
            });
          } else {
            status = result.status;
            response = buildResponse({
              status,
              headers: { ...baseHeaders, ...cors, ...(endpoint.headers ?? {}), ...result.headers },
              body: result.body,
            });
          }
        }

        if (injected?.connection) {
          (response as unknown as WithConnection)[CONNECTION_CONTROL] = injected.connection;
        }

        logRequest(config, {
          method,
          path,
          status,
          ms: Date.now() - startedAt,
          route: `graphql:${endpoint.path}`,
          injected: Boolean(injected),
        });
        return response;
      }
    }

    // REST route matching.
    let matched: { route: CompiledRoute; params: Record<string, string> } | null = null;
    for (const route of withinBasePath ? routes : []) {
      if (!routeMatches(route, method)) continue;
      const result = matchPath(route.config.path, path);
      if (result) {
        matched = { route, params: result.params };
        break;
      }
    }

    if (!matched) {
      // Proxy mode: forward unmatched traffic to the configured upstream.
      if (config.proxy) {
        const response = await proxyRequest(config.proxy, request, url, {}, rawBody);
        logRequest(config, {
          method,
          path,
          status: response.status,
          ms: Date.now() - startedAt,
          route: 'proxy',
          injected: false,
        });
        return response;
      }

      if (config.fallback === 'echo') {
        const ctx = buildContext(request, url, path, {}, null, rawBody);
        const status = 200;
        const response = buildResponse({
          status,
          headers: { ...baseHeaders, ...cors },
          body: {
            method: ctx.method,
            path: ctx.path,
            query: ctx.query,
            headers: ctx.headers,
            body: ctx.body,
          },
          omitBody: method === 'HEAD',
        });
        logRequest(config, { method, path, status, ms: Date.now() - startedAt, route: 'echo', injected: false });
        return response;
      }

      const status = 404;
      const response = buildResponse({
        status,
        headers: { ...baseHeaders, ...cors },
        body: { error: 'Not Found', message: `No mock route for ${method} ${path}`, path, method },
        omitBody: method === 'HEAD',
      });
      logRequest(config, { method, path, status, ms: Date.now() - startedAt, route: null, injected: false });
      return response;
    }

    const { route, params } = matched;
    const ctx = buildContext(request, url, path, params, route.config, rawBody);

    // Proxy passthrough routes.
    if (route.config.passthrough) {
      const response = await proxyRequest(route.config.passthrough, request, url, params, rawBody);
      logRequest(config, {
        method,
        path,
        status: response.status,
        ms: Date.now() - startedAt,
        route: route.stateKey,
        injected: false,
      });
      return response;
    }

    // Resolve the effective response spec: base -> first matching rule -> sequence.
    let spec = toSpec(route.config);

    for (const rule of route.config.rules ?? []) {
      if (matchesWhen(rule.when, ctx)) {
        spec = applyOverride(spec, rule);
        break;
      }
    }

    const sequence = route.config.sequence;
    if (sequence && sequence.length > 0) {
      const counterKey = `${route.stateKey}:seq`;
      const count = Number(state.get(counterKey) ?? 0);
      const index = route.config.once
        ? Math.min(count, sequence.length - 1)
        : count % sequence.length;
      state.set(counterKey, count + 1);
      spec = applyOverride(spec, sequence[index]);
    }

    // Error injection precedence: spec > global.
    const injected = decideError(
      resolveErrorOptions(spec.error, spec.errorRate, config.errors),
      rng,
    );

    // Latency.
    let delay = spec.delay !== undefined
      ? Math.max(0, spec.delay)
      : computeLatency(spec.latency, config.latency, rng);
    delay += injected?.delay ?? 0;

    if (injected?.hang) {
      await sleep(delay, request.signal);
      return new Promise<Response>((_, reject) => {
        if (request.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        request.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    }

    // Resolve the body.
    let body: unknown;
    if (injected) {
      body = await resolveBody(injected.body, ctx);
    } else {
      body = await resolveBody(spec.body, ctx);
    }

    const status = injected ? injected.status : spec.status ?? 200;

    const routeEffectiveCors = resolveEffectiveCors(route.config.cors, config.cors);
    const routeCors = corsHeaders(routeEffectiveCors, origin);

    const headers: Record<string, string> = {
      ...baseHeaders,
      ...routeCors,
      ...spec.headers,
      ...(injected?.headers ?? {}),
    };
    // Interpolate header values too.
    for (const [key, value] of Object.entries(headers)) {
      const resolved = interpolate(value, ctx);
      if (resolved === undefined || resolved === null) {
        delete headers[key];
      } else {
        headers[key] = typeof resolved === 'string' ? resolved : String(resolved);
      }
    }

    if (delay > 0) await sleep(delay, request.signal);

    const response = buildResponse({
      status,
      headers,
      body,
      omitBody: method === 'HEAD',
    });

    if (injected?.connection) {
      (response as unknown as WithConnection)[CONNECTION_CONTROL] = injected.connection;
    }

    logRequest(config, {
      method,
      path,
      status,
      ms: Date.now() - startedAt,
      route: route.stateKey,
      injected: Boolean(injected),
    });

    return response;
  }

  return {
    config,
    routes,
    state,
    handler,
    reset() {
      state.clear();
    },
  };
}

async function resolveBody(body: unknown, ctx: RequestContext): Promise<unknown> {
  let value = body;
  if (typeof value === 'function') {
    value = await (value as (context: RequestContext) => unknown)(ctx);
  }
  return interpolate(value, ctx);
}

/** Create a mock server from a raw config object. */
export function createMockServer(config: MockServerConfig = {}): MockServer {
  return buildServer(normalizeConfig(config));
}

/** Convenience: derive the list of declared `METHOD /path` route labels. */
export function routeLabels(server: MockServer): string[] {
  const labels: string[] = [];
  for (const route of server.routes) {
    const methods = route.matchAll ? ['*'] : [...route.methods];
    labels.push(`${methods.join('|')} ${route.config.path}`);
  }
  for (const endpoint of server.config.graphql) {
    labels.push(`POST|GET ${endpoint.path ?? '/graphql'}`);
  }
  return labels;
}

export type { HttpMethod };
