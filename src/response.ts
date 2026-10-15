/**
 * @file Response construction, CORS headers and connection-control signalling.
 *
 * Serializes loose developer-friendly values into a Web-standard `Response`,
 * computes CORS headers and preflight responses, and exposes the private symbol
 * the Node adapter reads to reset or close a socket.
 */

import type { CorsOptions } from './types.js';

/**
 * A private symbol attached to a `Response` describing low-level socket
 * behaviour the caller (Node adapter) should apply. Standard `fetch` consumers
 * simply ignore it.
 */
export const CONNECTION_CONTROL = Symbol.for('mock-server.connection');

/** Socket behaviour requested for a response. */
export type ConnectionControl = 'reset' | 'close';

/** A `Response` carrying an optional connection-control directive. */
export interface WithConnection {
  [CONNECTION_CONTROL]?: ConnectionControl;
}

/** Loose input accepted by {@link buildResponse}. */
export interface BuildResponseInput {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Skip the body entirely (HEAD requests). */
  omitBody?: boolean;
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 418: "I'm a teapot",
  422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function statusText(status: number): string {
  return STATUS_TEXT[status] ?? 'Unknown';
}

function isBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === 'string' ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    (typeof Blob !== 'undefined' && value instanceof Blob) ||
    (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) ||
    (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) ||
    (typeof FormData !== 'undefined' && value instanceof FormData)
  );
}

/** Build a Web-standard `Response` from a loose, developer-friendly body value. */
export function buildResponse(input: BuildResponseInput): Response {
  const status = input.status ?? 200;
  const headers = new Headers();

  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (value !== undefined && value !== null) headers.set(key, String(value));
  }

  // 204/304 must not carry a body.
  const bodyless = status === 204 || status === 304 || input.omitBody;
  let body: BodyInit | null = null;

  if (!bodyless && input.body !== undefined) {
    if (isBodyInit(input.body)) {
      body = input.body;
      if (input.body instanceof Uint8Array && !headers.has('content-type')) {
        headers.set('content-type', 'application/octet-stream');
      }
    } else {
      const serialized = JSON.stringify(input.body);
      body = serialized === undefined ? null : serialized;
      if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
    }
  }

  return new Response(body, { status, statusText: statusText(status), headers });
}

/** Pretty-print a value as indented JSON (used for file/log payloads). */
export function jsonBody(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/** Compute CORS headers for a request origin. Returns an empty object when disabled. */
export function corsHeaders(
  cors: CorsOptions | false,
  requestOrigin: string | null,
): Record<string, string> {
  if (!cors) return {};

  const origin = resolveOrigin(cors.origin, requestOrigin);
  const headers: Record<string, string> = {};

  if (origin) headers['access-control-allow-origin'] = origin;
  if (origin && origin !== '*') headers['vary'] = 'Origin';
  if (cors.credentials) headers['access-control-allow-credentials'] = 'true';
  if (cors.exposedHeaders?.length) headers['access-control-expose-headers'] = cors.exposedHeaders.join(', ');
  if (cors.methods?.length) headers['access-control-allow-methods'] = cors.methods.join(', ');
  if (cors.headers?.length) headers['access-control-allow-headers'] = cors.headers.join(', ');
  if (cors.maxAge !== undefined) headers['access-control-max-age'] = String(cors.maxAge);

  return headers;
}

function resolveOrigin(origin: CorsOptions['origin'], requestOrigin: string | null): string | null {
  if (!origin) return requestOrigin ? requestOrigin : '*';
  if (origin === '*') return '*';
  const list = Array.isArray(origin) ? origin : [origin];
  if (requestOrigin && list.includes(requestOrigin)) return requestOrigin;
  if (list.includes('*')) return requestOrigin ?? '*';
  return requestOrigin ?? list[0] ?? null;
}

/** Build a CORS preflight (`OPTIONS`) response. */
export function preflightResponse(
  cors: CorsOptions | false,
  requestOrigin: string | null,
  requestHeaders: string | null,
): Response {
  const headers = corsHeaders(cors, requestOrigin);

  // Echo the requested method/headers when the config doesn't pin them.
  if (requestHeaders && !headers['access-control-allow-headers']) {
    headers['access-control-allow-headers'] = requestHeaders;
  }
  if (!headers['access-control-allow-methods']) {
    headers['access-control-allow-methods'] = 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS';
  }
  return new Response(null, { status: 204, headers });
}
