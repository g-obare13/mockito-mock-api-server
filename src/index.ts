/**
 * Public, runtime-agnostic API. This entrypoint has no Node built-in imports,
 * so it can be bundled for Workers, Deno, Bun, browsers or serverless hosts.
 * For the Node HTTP adapter and file-based config loading use `@mockito/mock-api-server/node`.
 */

export { createMockServer, buildServer, routeLabels } from './server.js';
export { defineConfig, normalizeConfig, demoConfig, MockConfigError } from './config.js';

// GraphQL
export { parseGraphQL, selectOperation, GraphQLSyntaxError } from './graphql/parser.js';
export type {
  DocumentNode,
  OperationNode,
  FragmentNode,
  SelectionNode,
  FieldNode,
  SpreadNode,
  InlineFragmentNode,
} from './graphql/parser.js';
export { resolveOperation } from './graphql/resolve.js';
export { runGraphQL, extractGraphQLRequest, readGraphQLRequest } from './graphql/handler.js';
export type { DataMap, GraphQLResolverFn, ExecutionResult } from './graphql/resolve.js';
export type { GraphQLRequestParts, GraphQLOutcome } from './graphql/handler.js';

// Faker
export { registerFaker, listFakers, hasFaker, builtinFakers } from './faker.js';
export type { FakerFn } from './faker.js';

// Internals useful for advanced use / testing
export { interpolate } from './template.js';
export { matchPath, matchValue, matchesWhen, parseQuery, parseCookies } from './matcher.js';
export { computeLatency, sleep } from './latency.js';
export { createRng } from './random.js';
export { buildResponse, corsHeaders, preflightResponse } from './response.js';

// Types
export type {
  MockServer,
  MockServerConfig,
  NormalizedConfig,
  NormalizedErrors,
  RouteConfig,
  ResponseSpec,
  Rule,
  WhenCondition,
  ValueMatcher,
  MatchRecord,
  RequestContext,
  HttpMethod,
  Latency,
  LatencyOptions,
  LatencyDistribution,
  ErrorInjectionOptions,
  CorsOptions,
  GraphQLConfig,
  GraphQLResolver,
  BodySource,
  LogLevel,
  LogFormat,
  FallbackMode,
  CompiledRoute,
  JsonValue,
} from './types.js';

export { VERSION } from './version.js';
