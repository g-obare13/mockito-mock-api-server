import { fakerValue } from './faker.js';
import type { RequestContext } from './types.js';

/**
 * Extremely small `{{ ... }}` template engine used inside JSON configs.
 *
 * Supported expressions:
 *   {{ params.id }}          route params
 *   {{ query.role }}         query string values
 *   {{ headers.x-api-key }}  request headers
 *   {{ cookies.session }}    cookies
 *   {{ body.user.name }}     dot-path into the parsed body
 *   {{ method }} {{ path }} {{ url }}
 *   {{ now }} {{ uuid }} {{ timestamp }}
 *   {{ faker.email }} {{ faker.int(1, 10) }} {{ faker.pick("a", "b") }}
 *
 * If an entire string is a single expression (`"{{ faker.int(1, 5) }}"`) the
 * raw, un-stringified value is returned — so numbers/objects stay typed.
 */

const EXACT = /^\s*\{\{\s*([\s\S]+?)\s*\}\}\s*$/;
const TOKEN = /\{\{\s*([\s\S]+?)\s*\}\}/g;
const CALL = /^([A-Za-z_][\w.-]*)\s*\(([\s\S]*)\)$/;

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === '\\' && i + 1 < input.length) {
        current += input[++i];
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '' || args.length > 0) args.push(current.trim());
  return args.filter((a) => a !== '');
}

function getIn(target: unknown, path: string[]): unknown {
  let current: unknown = target;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
      current = (current as Record<string, unknown>)[key];
      continue;
    }
    return undefined;
  }
  return current;
}

function resolveRoot(name: string, ctx: RequestContext): unknown {
  switch (name) {
    case 'params':
      return ctx.params;
    case 'query':
      return ctx.query;
    case 'headers':
    case 'header':
      return ctx.headers;
    case 'cookies':
    case 'cookie':
      return ctx.cookies;
    case 'body':
      return ctx.body;
    case 'method':
      return ctx.method;
    case 'path':
      return ctx.path;
    case 'url':
      return ctx.url.toString();
    case 'route':
      return ctx.route;
    case 'uuid':
      return fakerValue('uuid', [], ctx.rng);
    case 'timestamp':
      return Date.now();
    case 'now':
      return new Date().toISOString();
    default:
      return undefined;
  }
}

interface Resolution {
  found: boolean;
  value: unknown;
}

function evaluate(expression: string, ctx: RequestContext): Resolution {
  const expr = expression.trim();

  const call = CALL.exec(expr);
  if (call) {
    const target = call[1]!;
    const args = splitArgs(call[2] ?? '');
    if (target === 'faker' || target.startsWith('faker.')) {
      // `faker.int(1,5)` -> target "faker", first arg is the generator name.
      const rest = target === 'faker' ? args : [target.slice('faker.'.length), ...args];
      const [name, ...rest2] = rest;
      if (!name) return { found: false, value: undefined };
      const value = fakerValue(name, rest2, ctx.rng);
      return { found: value !== undefined, value };
    }
    // Namespaced helper such as `query.get` is uncommon — fall through to path lookup.
    return { found: false, value: undefined };
  }

  const path = expr
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean);
  if (path.length === 0) return { found: false, value: undefined };

  const first = path[0]!;

  // `now.iso`, `now.time` etc. — special-case the `now` root.
  if (first === 'now') {
    const iso = new Date().toISOString();
    if (path.length === 1) return { found: true, value: iso };
    const part = path[1]!;
    if (part === 'iso' || part === 'toISOString') return { found: true, value: iso };
    if (part === 'date') return { found: true, value: iso.slice(0, 10) };
    if (part === 'time') return { found: true, value: iso.slice(11, 19) };
    if (part === 'timestamp' || part === 'epoch') return { found: true, value: Date.now() };
    return { found: false, value: undefined };
  }

  // Bare `{{ faker.email }}` (no parens) is also allowed.
  if (first === 'faker' && path.length >= 2) {
    const value = fakerValue(path[1]!, [], ctx.rng);
    return { found: value !== undefined, value };
  }

  const root = resolveRoot(first, ctx);
  if (root === undefined && path.length === 1 && !isKnownRoot(first)) {
    return { found: false, value: undefined };
  }
  const value = path.length === 1 ? root : getIn(root, path.slice(1));
  return { found: value !== undefined, value };
}

function isKnownRoot(name: string): boolean {
  return [
    'params', 'query', 'headers', 'header', 'cookies', 'cookie', 'body',
    'method', 'path', 'url', 'route', 'uuid', 'timestamp', 'now',
  ].includes(name);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Recursively interpolate a value against the request context. */
export function interpolate<T = unknown>(value: T, ctx: RequestContext): unknown {
  if (typeof value === 'string') {
    const exact = EXACT.exec(value);
    if (exact) {
      const { found, value: resolved } = evaluate(exact[1]!, ctx);
      // Unknown expressions fall back to the original literal string.
      return found ? resolved : value;
    }
    if (!value.includes('{{')) return value;
    return value.replace(TOKEN, (match, expr: string) => {
      const { found, value: resolved } = evaluate(expr, ctx);
      return found ? stringify(resolved) : match;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item, ctx));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolate(entry, ctx);
    }
    return out;
  }

  return value;
}

/** Internals exposed solely to make the template engine unit-testable. */
export const __internal = { evaluate, splitArgs, getIn };
