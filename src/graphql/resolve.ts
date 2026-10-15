/**
 * @file Schema-less GraphQL execution.
 *
 * Projects a parsed query against a plain data map: flattens fragments, walks
 * selection sets, applies common list arguments and calls resolver functions.
 */

import type { RequestContext } from '../types.js';
import type { DocumentNode, FieldNode, OperationNode, SelectionNode } from './parser.js';

/** A resolver function stored in a GraphQL data map. */
export type GraphQLResolverFn = (
  args: Record<string, unknown> | undefined,
  ctx: RequestContext,
) => unknown;

/** The root data map keyed by top-level GraphQL field name. */
export type DataMap = Record<string, unknown | GraphQLResolverFn>;

/** Flatten fragment spreads and inline fragments into a flat field list. */
function expand(
  selection: readonly SelectionNode[],
  fragments: Map<string, { selection: SelectionNode[] }>,
  seen: Set<string> = new Set(),
): FieldNode[] {
  const out: FieldNode[] = [];
  for (const node of selection) {
    if (node.kind === 'field') {
      out.push(node);
    } else if (node.kind === 'spread') {
      if (seen.has(node.name)) continue; // guard against cyclic fragments
      const fragment = fragments.get(node.name);
      if (!fragment) continue;
      seen.add(node.name);
      out.push(...expand(fragment.selection, fragments, seen));
      seen.delete(node.name);
    } else {
      out.push(...expand(node.selection, fragments, seen));
    }
  }
  return out;
}

/** Apply common list arguments (`id`, `ids`, `first`, `last`, `offset`, `where`). */
function applyArgs(value: unknown, args: Record<string, unknown>): unknown {
  const keys = Object.keys(args);
  if (keys.length === 0) return value;
  if (!Array.isArray(value)) return value;

  let list = value;

  if (args.ids !== undefined) {
    const ids = (Array.isArray(args.ids) ? args.ids : [args.ids]).map(String);
    list = list.filter((item) => ids.includes(String(getField(item, 'id'))));
  }
  if (args.id !== undefined) {
    list = list.filter((item) => String(getField(item, 'id')) === String(args.id));
  }
  if (typeof args.where === 'object' && args.where !== null) {
    const where = args.where as Record<string, unknown>;
    list = list.filter((item) =>
      Object.entries(where).every(([key, expected]) => looseEqual(getField(item, key), expected)),
    );
  }

  const offset = toNumber(args.offset ?? args.skip);
  if (offset > 0) list = list.slice(offset);

  const limit = toNumber(args.limit ?? args.first ?? args.take);
  if (limit > 0) list = list.slice(0, limit);

  const last = toNumber(args.last);
  if (last > 0) list = list.slice(-last);

  return list;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function getField(value: unknown, key: string): unknown {
  if (value && typeof value === 'object') return (value as Record<string, unknown>)[key];
  return undefined;
}

function project(
  value: unknown,
  selection: readonly SelectionNode[],
  ctx: RequestContext,
  fragments: Map<string, { selection: SelectionNode[] }>,
  typename: string,
): unknown {
  const fields = expand(selection, fragments);

  if (typeof value === 'function') {
    const produced = (value as GraphQLResolverFn)(undefined, ctx);
    return project(produced, selection, ctx, fragments, typename);
  }

  if (Array.isArray(value)) {
    return value.map((item) => project(item, fields, ctx, fragments, typename));
  }

  if (fields.length === 0) {
    return value === undefined ? null : value;
  }

  if (value === null || value === undefined || typeof value !== 'object') {
    // Selection requires an object; emit null for each requested field.
    const nulls: Record<string, unknown> = {};
    for (const field of fields) {
      nulls[field.alias ?? field.name] = field.name === '__typename' ? typename : null;
    }
    return nulls;
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    const key = field.alias ?? field.name;

    if (field.name === '__typename') {
      result[key] = source.__typename ?? typename;
      continue;
    }

    let child = source[field.name];
    if (typeof child === 'function') child = (child as GraphQLResolverFn)(field.args, ctx);
    child = applyArgs(child, field.args);

    result[key] = project(child, field.selection, ctx, fragments, field.name);
  }

  return result;
}

/** The result of executing a GraphQL operation. */
export interface ExecutionResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string; path?: string[] }>;
}

/** Execute a parsed operation against a schema-less data map. */
export function resolveOperation(
  operation: OperationNode,
  doc: DocumentNode,
  data: DataMap,
  ctx: RequestContext,
): ExecutionResult {
  const rootType =
    operation.operation === 'mutation'
      ? 'Mutation'
      : operation.operation === 'subscription'
        ? 'Subscription'
        : 'Query';

  const fields = expand(operation.selection, doc.fragments);
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    const key = field.alias ?? field.name;

    if (field.name === '__typename') {
      result[key] = rootType;
      continue;
    }

    if (field.name === '__schema' || field.name === '__type') {
      result[key] = field.selection.length > 0 ? {} : null;
      continue;
    }

    let value = data[field.name];
    if (typeof value === 'function') value = (value as GraphQLResolverFn)(field.args, ctx);
    value = applyArgs(value, field.args);

    result[key] = project(value, field.selection, ctx, doc.fragments, field.name);
  }

  return { data: result };
}
