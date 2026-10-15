/**
 * A tiny, dependency-free, seedable PRNG (mulberry32) plus helpers.
 * A single `Rng` instance is created per mock server so a given `seed`
 * produces reproducible jitter, error injection and `faker.*` output.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  (): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** Pick one element at random. */
  pick<T>(items: readonly T[]): T;
  /** `true` with probability `p` (default 0.5). */
  bool(p?: number): boolean;
  /** Normally distributed value (Box–Muller). */
  normal(mean: number, stddev: number): number;
}

export function createRng(seed?: number): Rng {
  let state = (seed === undefined ? (Math.random() * 0x100000000) : seed) >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng = next as Rng;

  rng.int = (min, max) => {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    return lo + Math.floor(next() * (hi - lo + 1));
  };

  rng.float = (min, max) => next() * (max - min) + min;

  rng.pick = (items) => {
    if (items.length === 0) return undefined as unknown as never;
    return items[Math.floor(next() * items.length)]!;
  };

  rng.bool = (p = 0.5) => next() < p;

  rng.normal = (mean, stddev) => {
    // Guard against log(0).
    const u = Math.max(next(), Number.EPSILON);
    const v = next();
    return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  return rng;
}
