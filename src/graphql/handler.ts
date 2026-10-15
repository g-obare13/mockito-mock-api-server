/**
 * @file GraphQL HTTP handling.
 *
 * Reads `{ query, variables, operationName }` from GET/POST requests, runs the
 * parser + resolver, and returns a standard GraphQL JSON body with an HTTP status.
 */

import type { GraphQLConfig, RequestContext } from '../types.js';
import { GraphQLSyntaxError, parseGraphQL, selectOperation } from './parser.js';
import { resolveOperation } from './resolve.js';
import type { DataMap, ExecutionResult } from './resolve.js';

/** The decomposed parts of a GraphQL request. */
export interface GraphQLRequestParts {
  query: string;
  variables: Record<string, unknown>;
  operationName: string | null;
}

/** Inputs needed to extract a GraphQL request from a pre-read body. */
export interface GraphQLRequestInput {
  method: string;
  url: URL;
  contentType: string | null;
  /** Already-read request body (may be empty). */
  body: string;
}

/**
 * Extract `{ query, variables, operationName }` from the parts of a request.
 * Takes a pre-read body so callers can consume the stream exactly once.
 */
export function extractGraphQLRequest(input: GraphQLRequestInput): GraphQLRequestParts {
  const method = input.method.toUpperCase();

  if (method === 'GET') {
    return {
      query: input.url.searchParams.get('query') ?? '',
      variables: parseVariables(input.url.searchParams.get('variables')),
      operationName: input.url.searchParams.get('operationName'),
    };
  }

  const contentType = (input.contentType ?? '').toLowerCase();
  const text = input.body;

  if (contentType.includes('application/graphql')) {
    return { query: text, variables: {}, operationName: null };
  }

  if (text.trim() === '') {
    return { query: '', variables: {}, operationName: null };
  }

  try {
    const parsed = JSON.parse(text) as {
      query?: string;
      variables?: unknown;
      operationName?: string;
    };
    return {
      query: parsed.query ?? '',
      variables: isRecord(parsed.variables) ? parsed.variables : {},
      operationName: parsed.operationName ?? null,
    };
  } catch {
    // Fall back to treating the raw body as a query string.
    return { query: text, variables: {}, operationName: null };
  }
}

/** Extract `{ query, variables, operationName }` from a GET or POST request. */
export async function readGraphQLRequest(request: Request): Promise<GraphQLRequestParts> {
  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? '' : await request.text();
  return extractGraphQLRequest({
    method,
    url: new URL(request.url),
    contentType: request.headers.get('content-type'),
    body,
  });
}

function parseVariables(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A GraphQL execution outcome: the HTTP status and JSON payload to return. */
export interface GraphQLOutcome {
  status: number;
  payload: ExecutionResult;
}

/** Parse + execute a GraphQL request against the configured data map. */
export function runGraphQL(
  config: GraphQLConfig,
  parts: GraphQLRequestParts,
  ctx: RequestContext,
): GraphQLOutcome {
  if (!parts.query.trim()) {
    return {
      status: 400,
      payload: { errors: [{ message: 'GraphQL request is missing a "query".' }] },
    };
  }

  let doc;
  let operation;
  try {
    doc = parseGraphQL(parts.query, parts.variables);
    operation = selectOperation(doc, parts.operationName);
  } catch (error) {
    const message = error instanceof GraphQLSyntaxError ? error.message : String(error);
    return { status: 400, payload: { errors: [{ message: `Syntax Error: ${message}` }] } };
  }

  const data: DataMap = (config.data ?? {}) as DataMap;

  try {
    const result = resolveOperation(operation, doc, data, ctx, config.schema);
    return { status: 200, payload: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, payload: { data: null, errors: [{ message }] } };
  }
}
