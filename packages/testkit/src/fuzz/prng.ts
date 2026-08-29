/**
 * Seeded PRNG (mulberry32). Every fuzz trial is deterministic from its
 * seed alone, so a failure is reproducible by re-running that exact seed —
 * the entire regression-corpus story (Test Plan §2.3, tests/regression/)
 * depends on this. Matches the technique the design spike used (RFC §2.1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inclusive random integer in [min, max], drawn from `rand`. */
export function randInt(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

/**
 * In-place Fisher-Yates shuffle. Used to destroy any ordering the harness's
 * generation loop happened to produce — the engine must never be able to
 * rely on delivery order (Engine Spec §4.2; causal readiness is the
 * engine's problem, never the harness's).
 */
export function fisherYatesShuffle<T>(items: T[], rand: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const temp = items[i] as T;
    items[i] = items[j] as T;
    items[j] = temp;
  }
}
