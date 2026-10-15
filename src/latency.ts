/**
 * @file Latency computation and sleep helpers.
 *
 * Resolves a `Latency` shorthand/object into a concrete millisecond delay using
 * the seeded RNG, and provides an abort-aware `sleep`.
 */

import type { Latency, LatencyOptions } from './types.js';
import type { Rng } from './random.js';

const DEFAULT_LATENCY: LatencyOptions = { distribution: 'fixed', fixed: 0 };

/**
 * Resolve a `Latency` shorthand/object into a concrete millisecond delay.
 * `override` (route- or rule-level) wins over the global `fallback`.
 */
export function computeLatency(
  latency: Latency | undefined,
  fallback: LatencyOptions,
  rng: Rng,
): number {
  const options = resolveOptions(latency) ?? fallback ?? DEFAULT_LATENCY;
  const delay = evaluate(options, rng);
  return Math.max(0, Math.round(delay));
}

/** Normalize a latency shorthand into an options object (or `undefined`). */
export function normalizeLatency(latency: Latency | undefined): LatencyOptions | undefined {
  return resolveOptions(latency);
}

function resolveOptions(latency: Latency | undefined): LatencyOptions | undefined {
  if (latency === undefined) return undefined;
  if (typeof latency === 'number') return { distribution: 'fixed', fixed: latency };
  return latency;
}

function evaluate(options: LatencyOptions, rng: Rng): number {
  const distribution = options.distribution ?? inferDistribution(options);

  switch (distribution) {
    case 'uniform': {
      const min = options.min ?? 0;
      const max = options.max ?? Math.max(min, (options.mean ?? min) * 2);
      return rng.float(min, max);
    }
    case 'normal': {
      const mean = options.mean ?? options.fixed ?? 0;
      const stddev = options.stddev ?? Math.max(1, mean * 0.25);
      return Math.max(0, rng.normal(mean, stddev));
    }
    case 'exponential': {
      const mean = options.mean ?? options.fixed ?? 100;
      return -Math.log(1 - Math.min(rng(), 0.999999)) * mean;
    }
    case 'fixed':
    default: {
      const base = options.fixed ?? options.mean ?? options.min ?? 0;
      const jitter = options.jitter ?? 0;
      return jitter > 0 ? base + rng.float(-jitter, jitter) : base;
    }
  }
}

function inferDistribution(options: LatencyOptions): LatencyOptions['distribution'] {
  if (options.min !== undefined || options.max !== undefined) return 'uniform';
  if (options.stddev !== undefined) return 'normal';
  return 'fixed';
}

/** Sleep for `ms`, resolving early if the request signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
