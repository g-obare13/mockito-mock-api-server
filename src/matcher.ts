/**
 * @file Path-pattern matching, request-value matching and query/cookie parsing.
 *
 * Provides the primitives the router uses to resolve a request to a route
 * (`matchPath`) and to decide whether a payload rule applies (`matchesWhen`,
 * `matchValue`), plus small helpers for reading query strings and cookies.
 */

import type { HttpMethod, RequestContext, ValueMatcher, WhenCondition } from './types.js';

/* -------------------------------------------------------------------------- */
/*  Path matching                                                             */
/* -------------------------------------------------------------------------- */

/** The result of a successful path match: captured named parameters. */
export interface PathMatch {
  params: Record<string, string>;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * Match a pathname against a route pattern.
 *
 *   :id        named single-segment param
 *   :id?       optional named param
 *   *name      catch-all, captures the remaining path as `name`
 *   literal?   optional literal segment
 */
export function matchPath(pattern: string, pathname: string): PathMatch | null {
  const trimmed = pattern.trim();
  if (trimmed === '*' || trimmed === '/*') return { params: { wildcard: pathname.replace(/^\//, '') } };

  const patternSegments = splitPath(trimmed);
  const pathSegments = splitPath(pathname);
  const params: Record<string, string> = {};
  let index = 0;

  for (let i = 0; i < patternSegments.length; i++) {
    const segment = patternSegments[i]!;

    // Catch-all takes every remaining segment (or segments up to remaining pattern tail).
    if (segment.startsWith('*')) {
      const name = segment.slice(1) || 'wildcard';
      const remainingPatternCount = patternSegments.length - 1 - i;
      if (remainingPatternCount === 0) {
        params[name] = pathSegments.slice(index).map(safeDecode).join('/');
        return { params };
      }
      if (pathSegments.length - index < remainingPatternCount) return null;
      const tailStartIndex = pathSegments.length - remainingPatternCount;
      params[name] = pathSegments.slice(index, tailStartIndex).map(safeDecode).join('/');
      index = tailStartIndex;
      continue;
    }

    if (segment.startsWith(':')) {
      const optional = segment.endsWith('?');
      const name = segment.slice(1).replace(/\?$/, '');
      if (index >= pathSegments.length) {
        if (optional) {
          params[name] = '';
          continue;
        }
        return null;
      }
      params[name] = safeDecode(pathSegments[index]!);
      index++;
      continue;
    }

    // Optional literal segment.
    if (segment.endsWith('?')) {
      const literal = segment.slice(0, -1);
      if (index < pathSegments.length && pathSegments[index] === literal) index++;
      continue;
    }

    if (index >= pathSegments.length || pathSegments[index] !== segment) return null;
    index++;
  }

  if (index !== pathSegments.length) return null;
  return { params };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/* -------------------------------------------------------------------------- */
/*  Value matching                                                            */
/* -------------------------------------------------------------------------- */

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || actual === undefined) return expected === null || expected === undefined;
  if (typeof expected === 'number' && typeof actual === 'string') {
    if (actual.trim() === '') return false;
    const n = Number(actual);
    return Number.isFinite(n) && n === expected;
  }
  if (typeof expected === 'boolean' && typeof actual === 'string') return String(expected) === actual;
  return String(actual) === String(expected);
}

function toComparableNumber(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Test a single value against a matcher (primitive shorthand or operator object). */
export function matchValue(actual: unknown, matcher: ValueMatcher): boolean {
  if (matcher === null || typeof matcher !== 'object' || Array.isArray(matcher)) {
    return looseEquals(actual, matcher);
  }

  const m = matcher as Record<string, unknown>;

  if ('exists' in m) {
    const present = actual !== undefined && actual !== null;
    if (Boolean(m.exists) !== present) return false;
  }

  if ('equals' in m && !looseEquals(actual, m.equals)) return false;

  if ('not' in m) {
    const not = m.not as ValueMatcher;
    if (matchValue(actual, not)) return false;
  }

  if ('in' in m) {
    const list = toArray(m.in);
    if (!list.some((candidate) => looseEquals(actual, candidate))) return false;
  }

  if ('type' in m) {
    const expected = m.type as string;
    const actualType = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual;
    if (actualType !== expected) return false;
  }

  const str = actual === null || actual === undefined ? '' : String(actual);

  if ('contains' in m && !str.includes(String(m.contains))) return false;
  if ('startsWith' in m && !str.startsWith(String(m.startsWith))) return false;
  if ('endsWith' in m && !str.endsWith(String(m.endsWith))) return false;

  if ('regex' in m) {
    try {
      const re = new RegExp(String(m.regex), typeof m.flags === 'string' ? m.flags : undefined);
      if (!re.test(str)) return false;
    } catch {
      return false;
    }
  }

  if ('gt' in m) {
    const num = toComparableNumber(actual);
    if (num === null || !(num > Number(m.gt))) return false;
  }
  if ('gte' in m) {
    const num = toComparableNumber(actual);
    if (num === null || !(num >= Number(m.gte))) return false;
  }
  if ('lt' in m) {
    const num = toComparableNumber(actual);
    if (num === null || !(num < Number(m.lt))) return false;
  }
  if ('lte' in m) {
    const num = toComparableNumber(actual);
    if (num === null || !(num <= Number(m.lte))) return false;
  }

  return true;
}

/** Resolve a dot-path inside an arbitrary object/array. */
export function getIn(target: unknown, path: string): unknown {
  const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current: unknown = target;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    if (Array.isArray(current)) {
      const asIndex = Number(key);
      current = Number.isInteger(asIndex) ? current[asIndex] : current.map((item) => getIn(item, key));
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

function matchRecord(actual: Record<string, unknown>, matchers: Record<string, ValueMatcher>): boolean {
  for (const [key, matcher] of Object.entries(matchers)) {
    const value = getIn(actual, key);
    if (!matchValue(value, matcher)) return false;
  }
  return true;
}

function matchMethod(expected: HttpMethod | HttpMethod[], method: string): boolean {
  const list = Array.isArray(expected) ? expected : [expected];
  return list.some((entry) => entry === '*' || entry.toUpperCase() === method.toUpperCase());
}

/** Evaluate a `when` condition against a request. Returns `true` when it applies. */
export function matchesWhen(when: WhenCondition | undefined, ctx: RequestContext): boolean {
  if (!when) return true;

  if (when.method && !matchMethod(when.method, ctx.method)) return false;

  if (when.path) {
    if (typeof when.path === 'string') {
      if (when.path !== ctx.path) return false;
    } else if (when.path instanceof RegExp) {
      if (!when.path.test(ctx.path)) return false;
    } else {
      try {
        if (!new RegExp(when.path.regex, when.path.flags).test(ctx.path)) return false;
      } catch {
        return false;
      }
    }
  }

  if (when.query && !matchRecord(ctx.query as Record<string, unknown>, when.query)) return false;
  if (when.headers && !matchRecord(ctx.headers as Record<string, unknown>, when.headers)) return false;
  if (when.cookies && !matchRecord(ctx.cookies as Record<string, unknown>, when.cookies)) return false;
  if (when.body && !matchRecord((ctx.body ?? {}) as Record<string, unknown>, when.body)) return false;

  return true;
}

/* -------------------------------------------------------------------------- */
/*  Query-string + cookie parsing                                             */
/* -------------------------------------------------------------------------- */

/** Parse a URL's query string into a map, preserving repeated keys as arrays. */
export function parseQuery(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length > 1 ? all : all[0]!;
  }
  return out;
}

/** Parse a `Cookie` header into a name/value map. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = safeDecode(value);
  }
  return out;
}
