import { Engine } from "@collab-editor/engine";

/**
 * Phase 20 DoD: measured compression across Engine Spec §7.5's three named
 * workloads, plus M8-b's replica memory re-measurement (RFC §2.5: 12.9 MB
 * pre-blocks against a 10 MB target). Lives in packages/testkit (the
 * project's own "load harness" package) for the same reason Phase 19's
 * scaling.ts does — `process.memoryUsage()` needs Node APIs packages/engine's
 * purity rules forbid.
 */

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

export interface CompressionResult {
  readonly workload: string;
  readonly operationCount: number;
  readonly visibleLength: number;
  readonly blockCount: number;
  readonly compressionRatio: number;
}

/** Workload 1 (Engine Spec §7.5): pure sequential typing — N characters appended one at a time, nothing else. */
export function pureSequentialTyping(n: number): CompressionResult {
  const engine = new Engine(1);
  for (let i = 0; i < n; i++) {
    engine.localInsert(i, 97 + (i % 26));
  }
  return summarize("pure sequential typing", n, engine);
}

/**
 * Workload 2 (Engine Spec §7.5): realistic prose — typing with occasional
 * repositioning (2%) and backspacing (8%), otherwise sequential appends —
 * the shape ordinary human typing actually produces (moving the cursor
 * back to fix a typo, then continuing).
 */
export function realisticProse(n: number, seed = 1): CompressionResult {
  const rng = mulberry32(seed);
  const engine = new Engine(1);
  let cursor = 0;
  let ops = 0;
  while (ops < n) {
    const visibleLength = engine.stats().visibleLength;
    const action = rng();
    if (action < 0.02 && visibleLength > 0) {
      // Reposition: jump the cursor somewhere else, then resume typing from there.
      cursor = Math.floor(rng() * (visibleLength + 1));
    } else if (action < 0.1 && cursor > 0) {
      // Backspace.
      engine.localDelete(cursor - 1, 1);
      cursor -= 1;
    } else {
      engine.localInsert(cursor, 97 + Math.floor(rng() * 26));
      cursor += 1;
    }
    ops += 1;
  }
  return summarize("realistic prose (2% reposition, 8% backspace)", n, engine);
}

/** Workload 3 (Engine Spec §7.5): random-position editing — every insert lands at a uniformly random position, no locality at all (the worst case for block compression). */
export function randomPositionEditing(n: number, seed = 1): CompressionResult {
  const rng = mulberry32(seed);
  const engine = new Engine(1);
  for (let i = 0; i < n; i++) {
    const visibleLength = engine.stats().visibleLength;
    const pos = Math.floor(rng() * (visibleLength + 1));
    engine.localInsert(pos, 97 + Math.floor(rng() * 26));
  }
  return summarize("random-position editing", n, engine);
}

function summarize(workload: string, operationCount: number, engine: Engine): CompressionResult {
  const stats = engine.stats();
  const blockCount = engine.blockCount;
  return {
    workload,
    operationCount,
    visibleLength: stats.visibleLength,
    blockCount,
    compressionRatio: stats.totalElements / Math.max(1, blockCount),
  };
}

/**
 * M8-b: replica memory at N operations, ~N/10 visible (matching RFC §2.5's
 * "100,000 operations / ~10,000 visible" scenario shape — a document typed,
 * then roughly 90% deleted, leaving 10% visible, the tombstone-heavy case
 * RFC §2.5 measured 12.9 MB for pre-blocks). Measures REAL V8 heap usage
 * (`process.memoryUsage().heapUsed`), not a byte-accounting estimate —
 * forcing a GC first (`--expose-gc`, wired by the caller) so the
 * measurement reflects retained memory, not transient garbage.
 *
 * Built via sequential-typing BURSTS (each ~50-500 characters, appended at
 * the current end of a growing "paragraph" position), followed by a second
 * pass of CONTIGUOUS range deletes (`Engine.localDelete(pos, count)` with
 * count in the hundreds — "select a paragraph, delete it," not scattered
 * single-character deletes at random positions) down to the target visible
 * count. A first version used random-position single-character edits
 * throughout and measured ZERO compression (100,000 ops -> 100,000
 * blocks) — not a bug, just proof that fixture wasn't exercising what
 * M8-b is actually asking about.
 *
 * A genuine, load-bearing finding from actually measuring this, worth
 * recording: even with this REALISTIC, locally-contiguous fixture,
 * TOMBSTONES barely compress at all (measured ~90,000 deleted characters
 * -> ~80,000+ separate tombstone blocks). Root cause: `Engine.localDelete
 * (pos, count)` issues `count` SEPARATE `DeleteOperation`s (Engine Spec
 * §4.1 — a delete is single-target only), each freshly minted with its
 * OWN identity. Definition 7.5's condition 4 requires a block's members to
 * share `deletedBy` — but every character in ONE "select a paragraph,
 * press Delete" user action gets a DIFFERENT `deletedBy` (a different
 * mint() counter each), so those tombstones can never merge into one
 * block even though they were deleted together and sit contiguously. This
 * is a genuine, spec-consistent limitation of block compression for
 * tombstones specifically (not a bug in this implementation) — visible
 * text compresses dramatically (the "pure sequential typing" and
 * "realistic prose" benchmarks below), but a heavily-tombstoned document's
 * MEMORY footprint is dominated by tombstones that compression barely
 * touches. This is exactly why Phase 20's own DoD anticipates M8-b
 * possibly staying over the 10 MB target and names Phase 21's GC (real
 * physical removal of causally-stable tombstones) as the next lever —
 * compression alone cannot fix what is fundamentally an operation-identity
 * problem, only removal can.
 */
export function buildMemoryTestDocument(totalOps: number, seed = 1): Engine {
  const rng = mulberry32(seed);
  const engine = new Engine(1);
  const targetVisible = Math.floor(totalOps / 10);

  // Phase 1: insert all `totalOps` characters via sequential bursts (each burst appended at a
  // random existing position, then typed forward from there — the shape of starting a new
  // "paragraph" at some point in an existing document and typing forward).
  let inserted = 0;
  while (inserted < totalOps) {
    const visibleLength = engine.stats().visibleLength;
    const burstLength = Math.min(totalOps - inserted, 50 + Math.floor(rng() * 450));
    const startPos = Math.floor(rng() * (visibleLength + 1));
    for (let i = 0; i < burstLength; i++) {
      engine.localInsert(startPos + i, 97 + Math.floor(rng() * 26));
    }
    inserted += burstLength;
  }

  // Phase 2: delete CONTIGUOUS ranges (paragraph-sized, "select and delete") down to the target
  // visible count — exercising real block splitting against the runs Phase 1 just formed.
  let visibleLength = engine.stats().visibleLength;
  while (visibleLength > targetVisible) {
    const deleteCount = Math.min(visibleLength - targetVisible, 50 + Math.floor(rng() * 450));
    const pos = Math.floor(rng() * (visibleLength - deleteCount + 1));
    engine.localDelete(pos, deleteCount);
    visibleLength = engine.stats().visibleLength;
  }
  return engine;
}
