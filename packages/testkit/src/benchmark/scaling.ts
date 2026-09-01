import { Engine } from "@collab-editor/engine";

/**
 * Phase 19 DoD: "Re-run scaling.js-equivalent benchmarks: apply p95 at
 * 1,000 / 32,000 / 100,000 nodes. The curve must be logarithmic, not the
 * previous 61x growth" and "M3-c (100,000-char document) local insert p99
 * ≤ 16 ms." Lives in packages/testkit (the project's own "load harness"
 * package, per its package.json description), not packages/engine —
 * timing measurement needs `performance.now()`, which packages/engine's
 * purity rules forbid everywhere, including test files (see
 * scripts/check-engine-purity.mjs's own comment: "Test files are scanned
 * too, deliberately").
 *
 * Methodology: for each target size N, build a document of N characters
 * via N sequential end-appends (the realistic "someone typed this
 * document" shape — also the shape RC-27/M3-c's own "100,000-char
 * document" scenario describes), then perform `sampleCount` FURTHER
 * `localInsert()` calls at uniformly random VISIBLE positions across the
 * now-large document — deliberately not more appends, since an
 * append-only workload never actually exercises `indexOfOrigin`'s worst
 * case (a lookup near the front of a huge structure) the way a random
 * insert does, and a random-position workload is what actually
 * distinguishes O(log N) from the pre-Phase-19 O(N) linear scan. Each
 * sampled call is timed individually; p50/p95/p99 are computed from
 * those individual samples, not from a single aggregate average (an
 * average would hide the exact tail-latency question M3-c and RC-27 are
 * both actually asking about).
 */

export interface ScalingSample {
  readonly size: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly buildMs: number;
}

function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) {
    return 0;
  }
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)] ?? 0;
}

/** mulberry32 — same shape as this project's other seeded PRNGs (packages/testkit/src/fuzz/prng.ts). Kept local and self-contained rather than importing that module, so this file has no dependency on the fuzz harness's own internals. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds an `size`-character document via sequential end-appends, then
 * times `sampleCount` further `localInsert()` calls at random visible
 * positions. Deterministic given `seed` — same PRNG discipline as the
 * rest of this project's fuzz infrastructure, so a reported regression is
 * reproducible rather than a one-off timing fluke.
 */
export function measureScaling(
  size: number,
  sampleCount: number,
  seed = 1,
): ScalingSample {
  const rng = mulberry32(seed);
  const engine = new Engine(1);

  const buildStart = performance.now();
  for (let i = 0; i < size; i++) {
    engine.localInsert(i, 97 + (i % 26));
  }
  const buildMs = performance.now() - buildStart;

  const samplesMs: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const currentLength = engine.stats().visibleLength;
    const position = Math.floor(rng() * (currentLength + 1));
    const start = performance.now();
    engine.localInsert(position, 97 + (i % 26));
    samplesMs.push(performance.now() - start);
  }
  samplesMs.sort((a, b) => a - b);

  return {
    size,
    p50Ms: percentile(samplesMs, 50),
    p95Ms: percentile(samplesMs, 95),
    p99Ms: percentile(samplesMs, 99),
    maxMs: samplesMs[samplesMs.length - 1] ?? 0,
    buildMs,
  };
}
