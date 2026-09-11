import { Engine } from "@collab-editor/engine";

/**
 * Phase 30 (RFC §8.2 (T2), Test Plan SEC-08) — measures `Engine.localInsert`'s REAL per-op cost
 * under the metadata-exhaustion attack's own shape (insert-then-delete at SCATTERED positions),
 * at the CURRENT engine's actual document size, to answer the phase brief's own explicit
 * question: "given Fugue's disclosed O(N²) cost at scale (CLAUDE.md's Open Item 3), does a
 * sustained 1,000 ops/second attack cause the SERVER ITSELF to become unresponsive due to
 * Fugue's own per-op cost BEFORE the rate limiter even has a chance to throttle it?"
 *
 * Lives in packages/testkit (not packages/engine) for the SAME reason scaling.ts does — timing
 * measurement needs `performance.now()`, which engine-purity rules forbid everywhere in
 * packages/engine/src, including test files.
 *
 * Deliberately a DIFFERENT shape than scaling.ts's own sequential-append build: that file builds
 * the worst-case single unbroken right-child chain (Fugue's own documented pathological case);
 * this file builds the ATTACK's own actual shape (scattered insert-then-delete pairs), since
 * SEC-08's own real workload is not sequential typing and this project's own discipline (Phase 14/
 * 20/25) is to measure the SPECIFIC scenario in question, not assume a different one's numbers
 * transfer.
 */

export interface AttackWorkloadSample {
  /** The engine's real `stats().totalElements` once the build loop finished — not necessarily exactly the requested target (the loop stops once it reaches or exceeds it). */
  readonly structureSize: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly buildMs: number;
  /** 1000 / p95Ms — the maximum SUSTAINED accepted-ops/second throughput this per-op cost alone would allow before the event loop itself becomes the bottleneck, independent of any rate limiter. */
  readonly impliedMaxOpsPerSecondAtP95: number;
}

function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)] ?? 0;
}

/** Same mulberry32 shape as this project's other seeded PRNGs — kept local, no cross-package dependency. */
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
 * Builds a document to (at least) `targetStructureSize` nodes via REPEATED insert-then-delete at
 * scattered (uniformly random) positions — SEC-08's own literal attack shape — then times
 * `sampleCount` FURTHER individual `localInsert()` calls at the resulting (already-large)
 * structure size. Each sampled insert is timed alone, matching scaling.ts's own methodology, so
 * p50/p95/p99/max reflect the actual per-operation cost DISTRIBUTION at that scale, not a hidden
 * average across a mix of cheap and expensive calls.
 */
export function measureAttackWorkload(
  targetStructureSize: number,
  sampleCount: number,
  seed = 1,
): AttackWorkloadSample {
  const rng = mulberry32(seed);
  const engine = new Engine(1);

  const buildStart = performance.now();
  // Roughly 70% of inserts are immediately followed by a delete elsewhere (never the character
  // just inserted, matching SEC-08's own "insert-then-delete at scattered positions" -- not
  // "insert-then-immediately-undo," which would never grow the structure at all) -- the
  // remaining 30% are left live, so the document actually accumulates VISIBLE content too,
  // exactly like a real (if malicious) editing session rather than an all-tombstone degenerate
  // case.
  while (engine.stats().totalElements < targetStructureSize) {
    const text = engine.text();
    const insertAt = text.length === 0 ? 0 : Math.floor(rng() * (text.length + 1));
    engine.localInsert(insertAt, 97 + Math.floor(rng() * 26));
    const afterText = engine.text();
    if (afterText.length > 1 && rng() < 0.7) {
      const deleteAt = Math.floor(rng() * afterText.length);
      engine.localDelete(deleteAt, 1);
    }
  }
  const buildMs = performance.now() - buildStart;

  const samplesMs: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const text = engine.text();
    const insertAt = text.length === 0 ? 0 : Math.floor(rng() * (text.length + 1));
    const start = performance.now();
    engine.localInsert(insertAt, 97 + (i % 26));
    samplesMs.push(performance.now() - start);
  }
  samplesMs.sort((a, b) => a - b);

  const p95Ms = percentile(samplesMs, 95);
  return {
    structureSize: engine.stats().totalElements,
    p50Ms: percentile(samplesMs, 50),
    p95Ms,
    p99Ms: percentile(samplesMs, 99),
    maxMs: samplesMs[samplesMs.length - 1] ?? 0,
    buildMs,
    impliedMaxOpsPerSecondAtP95: p95Ms > 0 ? 1000 / p95Ms : Number.POSITIVE_INFINITY,
  };
}
