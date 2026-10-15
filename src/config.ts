/**
 * @file Configuration loading, validation and normalization.
 *
 * Turns a raw user config (JSON or TS/JS) into a fully-resolved {@link NormalizedConfig}
 * by applying defaults, coercing shorthands and validating problematic values.
 */

import { normalizeLatency } from './latency.js';
import type {
  CorsOptions,
  ErrorInjectionOptions,
  FallbackMode,
  GraphQLConfig,
  LatencyOptions,
  LogFormat,
  LogLevel,
  MockServerConfig,
  NormalizedConfig,
  NormalizedErrors,
  RouteConfig,
} from './types.js';

/** Error thrown when a configuration is missing required values or is malformed. */
export class MockConfigError extends Error {
  constructor(message: string, public issues: string[] = []) {
    super(issues.length > 0 ? `${message}\n  - ${issues.join('\n  - ')}` : message);
    this.name = 'MockConfigError';
  }
}

/** Identity helper that gives editors full autocomplete + type checking for a config. */
export function defineConfig(config: MockServerConfig): MockServerConfig {
  return config;
}

const DEFAULT_CORS: CorsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  headers: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  maxAge: 86400,
};

const LOG_LEVELS: LogLevel[] = ['silent', 'error', 'info', 'debug'];

function toLogLevel(log: MockServerConfig['log']): LogLevel {
  if (log === undefined || log === true) return 'info';
  if (log === false) return 'silent';
  return LOG_LEVELS.includes(log) ? log : 'info';
}

function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath || basePath === '/') return '';
  const trimmed = basePath.trim().replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeCors(cors: MockServerConfig['cors']): CorsOptions | false {
  if (cors === false) return false;
  if (cors === undefined || cors === true) return { ...DEFAULT_CORS };
  return { ...DEFAULT_CORS, ...cors };
}

function clampRate(rate: number | undefined): number | undefined {
  if (rate === undefined) return undefined;
  if (!Number.isFinite(rate)) return undefined;
  return Math.min(1, Math.max(0, rate));
}

function normalizeErrors(
  errors: ErrorInjectionOptions | undefined,
  rateOverride: number | undefined,
): NormalizedErrors | null {
  const explicitRate = clampRate(rateOverride ?? errors?.rate ?? errors?.probability);
  if (!errors && explicitRate === undefined) return null;

  const rate = explicitRate ?? 0.1;
  const statuses =
    errors?.statuses ??
    errors?.codes ??
    (errors?.status !== undefined ? [errors.status] : [500]);

  return {
    rate,
    statuses,
    bodies: errors?.body !== undefined ? [errors.body] : undefined,
    messages: errors?.messages,
    headers: errors?.headers,
    delay: errors?.delay,
    hang: errors?.hang,
    connection: errors?.connection,
  };
}

function validateRoutes(routes: RouteConfig[], issues: string[]): void {
  routes.forEach((route, index) => {
    if (typeof route.path !== 'string' || route.path.trim() === '') {
      issues.push(`routes[${index}].path must be a non-empty string`);
    }
    if (route.status !== undefined && (route.status < 100 || route.status > 599)) {
      issues.push(`routes[${index}].status must be a valid HTTP status code`);
    }
  });
}

/** Apply defaults and validate a raw config, producing a fully-resolved config. */
export function normalizeConfig(input: MockServerConfig = {}): NormalizedConfig {
  const issues: string[] = [];
  const routes = input.routes ?? [];

  if (!Array.isArray(routes)) issues.push('routes must be an array');
  else validateRoutes(routes, issues);

  const graphql: GraphQLConfig[] = input.graphql
    ? Array.isArray(input.graphql)
      ? input.graphql
      : [input.graphql]
    : [];

  if (issues.length > 0) throw new MockConfigError('Invalid mock server config:', issues);

  const latency: LatencyOptions =
    normalizeLatency(input.latency) ?? { distribution: 'fixed', fixed: 0 };

  return {
    name: input.name ?? 'mock-server',
    port: input.port ?? 4000,
    host: input.host ?? '0.0.0.0',
    basePath: normalizeBasePath(input.basePath),
    seed: input.seed ?? Math.floor(Math.random() * 0x7fffffff),
    latency,
    errors: normalizeErrors(input.errors, clampRate(input.errorRate)),
    cors: normalizeCors(input.cors),
    headers: { ...(input.headers ?? {}) },
    log: toLogLevel(input.log),
    logFormat: (input.logFormat ?? 'pretty') as LogFormat,
    routes,
    graphql,
    fallback: (input.fallback ?? '404') as FallbackMode,
    proxy: input.proxy,
  };
}

/* -------------------------------------------------------------------------- */
/*  Zero-config demo                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The config used when no config file is found — so `npx mock-server` always
 * does something useful instead of erroring out.
 */
export function demoConfig(): MockServerConfig {
  return {
    name: 'demo',
    latency: { distribution: 'uniform', min: 20, max: 120 },
    errors: { rate: 0, statuses: [500] },
    routes: [
      {
        method: 'GET',
        path: '/health',
        delay: 0,
        body: { status: 'ok', uptime: '{{ faker.float(1, 1000) }}', at: '{{ now }}' },
      },
      {
        method: 'GET',
        path: '/users',
        body: [
          { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', role: 'admin' },
          { id: 2, name: 'Alan Turing', email: 'alan@example.com', role: 'member' },
        ],
      },
      {
        method: 'GET',
        path: '/users/:id',
        body: { id: '{{ params.id }}', name: '{{ faker.fullName }}', email: '{{ faker.email }}', createdAt: '{{ now }}' },
      },
      {
        method: 'POST',
        path: '/users',
        status: 201,
        body: {
          id: '{{ faker.id }}',
          name: '{{ body.name }}',
          email: '{{ body.email }}',
          echo: '{{ body }}',
        },
      },
    ],
    graphql: {
      data: {
        users: [
          { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' },
          { id: '2', name: 'Alan Turing', email: 'alan@example.com' },
        ],
        viewer: { id: '1', name: 'Ada Lovelace' },
      },
    },
  };
}
