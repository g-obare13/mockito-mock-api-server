/**
 * @file Public type definitions for mock-server.
 *
 * This module is intentionally dependency-free (types only) so it can be imported
 * from any runtime. It describes the full configuration surface — routes, payload
 * rules, latency, error injection, CORS and GraphQL — plus the internal runtime
 * context passed to resolver and `body` functions.
 */

import type { Rng } from './random.js';

/* -------------------------------------------------------------------------- */
/*  Primitives                                                                */
/* -------------------------------------------------------------------------- */

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;

/** Any JSON-serializable value. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** HTTP methods accepted by a route, or `'*'` to match every method. */
export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS'
  | 'TRACE'
  | '*';

/**
 * A mock body. In JSON configs this is a literal (with `{{ template }}` support).
 * In JS/TS configs it may also be a function that is called per-request.
 *
 * The function's return is intentionally `unknown` so the union keeps a single
 * call signature — that's what lets editors infer `ctx` for `body: (ctx) => …`.
 */
export type BodySource<T = JsonValue> =
  | T
  | Uint8Array
  | ((ctx: RequestContext) => unknown | Promise<unknown>);

/* -------------------------------------------------------------------------- */
/*  Latency                                                                   */
/* -------------------------------------------------------------------------- */

/** Supported delay distributions. */
export type LatencyDistribution = 'fixed' | 'uniform' | 'normal' | 'exponential';

/** Fine-grained latency configuration. */
export interface LatencyOptions {
  /** Shape of the random delay. Defaults to `fixed` when only `fixed` is set. */
  distribution?: LatencyDistribution;
  /** Exact delay in milliseconds. */
  fixed?: number;
  /** Lower bound for `uniform` distribution. */
  min?: number;
  /** Upper bound for `uniform` distribution. */
  max?: number;
  /** Mean for `normal` / `exponential` distributions. */
  mean?: number;
  /** Standard deviation for `normal` distribution. */
  stddev?: number;
  /** Symmetric random spread applied to a fixed delay. */
  jitter?: number;
}

/** A latency can be a plain number of milliseconds or a full options object. */
export type Latency = number | LatencyOptions;

/* -------------------------------------------------------------------------- */
/*  Matching (payload rules)                                                  */
/* -------------------------------------------------------------------------- */

/** Operator form of a value matcher. */
export interface MatcherOperators {
  equals?: unknown;
  not?: unknown;
  in?: unknown[];
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  regex?: string;
  flags?: string;
  exists?: boolean;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';
}

/**
 * Matches a value. A bare primitive is treated as `{ equals: value }`.
 */
export type ValueMatcher = JsonPrimitive | MatcherOperators;

/** A map of (dot-path) keys to value matchers. */
export type MatchRecord = Record<string, ValueMatcher>;

/** Conditions evaluated to decide whether a payload rule applies. */
export interface WhenCondition {
  method?: HttpMethod | HttpMethod[];
  /** Exact path, or a regex (as `RegExp` in TS configs or `{ regex }` in JSON). */
  path?: string | RegExp | { regex: string; flags?: string };
  query?: MatchRecord;
  headers?: MatchRecord;
  cookies?: MatchRecord;
  /** Dot-paths into the parsed request body, e.g. `{ "user.role": "admin" }`. */
  body?: MatchRecord;
}

/* -------------------------------------------------------------------------- */
/*  Errors + CORS                                                             */
/* -------------------------------------------------------------------------- */

/** Configuration for probabilistic error injection. */
export interface ErrorInjectionOptions {
  /** Probability (0..1) that this error is injected. */
  rate?: number;
  /** Alias for `rate`. */
  probability?: number;
  /** Single status code to use. */
  status?: number;
  /** Pool of status codes to choose from at random. */
  statuses?: number[];
  /** Alias for `statuses`. */
  codes?: number[];
  /** Response body(s) used when injecting an error. */
  body?: BodySource;
  /** Convenience: builds a `{ error: message }` body when `body` is unset. */
  messages?: string[];
  headers?: Record<string, string>;
  /** Extra delay (ms) applied *before* returning the error — simulates a timeout. */
  delay?: number;
  /** Never respond. The client hangs until it times out. */
  hang?: boolean;
  /** Low-level socket behaviour (only supported by the Node adapter). */
  connection?: 'reset' | 'close';
}

/** Cross-origin resource sharing policy. */
export interface CorsOptions {
  origin?: string | string[];
  methods?: string[];
  headers?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

/** Error injection after normalization (arrays and defaults resolved). */
export interface NormalizedErrors {
  rate: number;
  statuses: number[];
  bodies?: BodySource[];
  messages?: string[];
  headers?: Record<string, string>;
  delay?: number;
  hang?: boolean;
  connection?: 'reset' | 'close';
}

/* -------------------------------------------------------------------------- */
/*  Response spec + routes                                                    */
/* -------------------------------------------------------------------------- */

/** The response fields shared by routes, rules and sequence entries. */
export interface ResponseSpec<T = JsonValue> {
  status?: number;
  headers?: Record<string, string>;
  body?: BodySource<T>;
  latency?: Latency;
  /** Shorthand for `latency: { fixed: n }`. Wins over `latency`. */
  delay?: number;
  /** Per-response error injection override. */
  error?: ErrorInjectionOptions;
  /** Per-response error rate shorthand. */
  errorRate?: number;
}

/** A conditional override applied when its `when` condition matches. */
export interface Rule<T = JsonValue> extends ResponseSpec<T> {
  name?: string;
  when?: WhenCondition;
}

/** A single REST route definition. */
export interface RouteConfig<T = JsonValue> extends ResponseSpec<T> {
  id?: string;
  method?: HttpMethod | HttpMethod[];
  /** Path pattern, e.g. `/users/:id` or `/files/*path`. */
  path: string;
  /** Ordered conditional overrides; the first matching rule wins. */
  rules?: Rule<T>[];
  /** Cycled per request; overrides the base response spec. */
  sequence?: ResponseSpec<T>[];
  /** Once exhausted, the last sequence entry keeps being served. */
  once?: boolean;
  /** Per-route error injection rate shorthand. */
  errorRate?: number;
  /** Serve the body from a JSON/text file (relative to the config file). */
  file?: string;
  cors?: CorsOptions | boolean;
  /** Proxy the request to a real URL instead of mocking (string, with `:param` support). */
  passthrough?: string;
  /** Higher priority routes are matched first. Defaults to `0`. */
  priority?: number;
}

/* -------------------------------------------------------------------------- */
/*  GraphQL                                                                   */
/* -------------------------------------------------------------------------- */

/** A resolver invoked for a GraphQL field; receives parsed arguments and the request. */
export type GraphQLResolver = (
  args: Record<string, unknown> | undefined,
  ctx: RequestContext,
) => unknown;

/** Configuration for a single GraphQL endpoint. */
export interface GraphQLConfig {
  /** Endpoint path. Defaults to `/graphql`. */
  path?: string;
  /** Root data keyed by top-level field name. Values may be literals or resolvers. */
  data?: Record<string, JsonValue | GraphQLResolver>;
  /** Optional SDL — used for `__typename` defaults only, no validation. */
  schema?: string;
  latency?: Latency;
  errorRate?: number;
  errors?: ErrorInjectionOptions;
  headers?: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/*  Server config                                                             */
/* -------------------------------------------------------------------------- */

/** Log verbosity levels. */
export type LogLevel = 'silent' | 'error' | 'info' | 'debug';

/** Log output format. */
export type LogFormat = 'pretty' | 'json';

/** Behaviour when no route matches an incoming request. */
export type FallbackMode = '404' | 'echo';

/** The raw, user-authored configuration object. */
export interface MockServerConfig {
  name?: string;
  port?: number;
  host?: string;
  /** Prefix stripped from every incoming path before matching routes. */
  basePath?: string;
  /** Deterministic seed for latency jitter, error injection and `faker.*`. */
  seed?: number;
  /** Global default latency applied to every route. */
  latency?: Latency;
  /** Global error injection rate shorthand. */
  errorRate?: number;
  errors?: ErrorInjectionOptions;
  cors?: CorsOptions | boolean;
  /** Headers merged into every response. */
  headers?: Record<string, string>;
  log?: boolean | LogLevel;
  logFormat?: LogFormat;
  routes?: RouteConfig[];
  graphql?: GraphQLConfig | GraphQLConfig[];
  /** Behaviour when no route matches. Defaults to `404`. */
  fallback?: FallbackMode;
  /** Base URL used by route-level `passthrough`. */
  proxy?: string;
}

/** A configuration with all defaults resolved and validated. */
export interface NormalizedConfig {
  name: string;
  port: number;
  host: string;
  basePath: string;
  seed: number;
  latency: LatencyOptions;
  errors: NormalizedErrors | null;
  cors: CorsOptions | false;
  headers: Record<string, string>;
  log: LogLevel;
  logFormat: LogFormat;
  routes: RouteConfig[];
  graphql: GraphQLConfig[];
  fallback: FallbackMode;
  proxy?: string;
}

/* -------------------------------------------------------------------------- */
/*  Runtime context                                                           */
/* -------------------------------------------------------------------------- */

/** Per-request context passed to templates, rules, `body` and resolver functions. */
export interface RequestContext<TBody = unknown> {
  request: Request;
  method: string;
  url: URL;
  /** Path with `basePath` stripped. */
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  body: TBody;
  rawBody: string;
  route: RouteConfig | null;
  /** Per-server mutable state, keyed by route. Used for sequences. */
  state: Map<string, unknown>;
  rng: Rng;
}

/** Internal: a compiled route with its method set and a unique state key. */
export interface CompiledRoute {
  config: RouteConfig;
  methods: Set<string>;
  matchAll: boolean;
  stateKey: string;
  priority: number;
}

/** A running mock server exposing a Web-standard handler. */
export interface MockServer {
  readonly config: NormalizedConfig;
  readonly routes: CompiledRoute[];
  readonly state: Map<string, unknown>;
  /** Web-standard handler — usable with `fetch`, Workers, Bun, Deno, Node, etc. */
  handler(request: Request): Promise<Response>;
  /** Reset sequence counters and other per-server state. */
  reset(): void;
}
