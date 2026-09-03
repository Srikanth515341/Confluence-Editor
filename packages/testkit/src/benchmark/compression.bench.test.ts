import { describe, expect, it } from "vitest";
import {
  buildMemoryTestDocument,
  pureSequentialTyping,
  randomPositionEditing,
  realisticProse,
} from "./compression.js";

/**
 * Phase 20 DoD — run via `pnpm test:benchmark`, gated out of the default
 * `pnpm test` (same reasoning as Phase 19's scaling benchmark). Prints
 * REAL measured numbers via console.log (this project's own established
 * convention — CLAUDE.md's Phase 17 entry: "Give me the real numbers, not
 * just the ratio") for all three Engine Spec §7.5 workloads, plus M8-b's
 * replica memory re-measurement.
 */
describe("Block compression benchmark (Phase 20 DoD)", () => {
  it("pure sequential typing compresses > 1000x", () => {
    const r = pureSequentialTyping(50_000);
    // eslint-disable-next-line no-console -- DoD explicitly requires real, reported numbers.
    console.log(
      `[compression] ${r.workload}: ${r.operationCount} ops -> ${r.blockCount} block(s), ratio ${r.compressionRatio.toFixed(1)}x`,
    );
    expect(r.compressionRatio).toBeGreaterThan(1000);
  });

  it("realistic prose (2% reposition, 8% backspace) compresses > 4x", () => {
    const r = realisticProse(50_000);
    // eslint-disable-next-line no-console -- see above.
    console.log(
      `[compression] ${r.workload}: ${r.operationCount} ops -> ${r.blockCount} block(s), ` +
        `visible ${r.visibleLength}, ratio ${r.compressionRatio.toFixed(2)}x`,
    );
    expect(r.compressionRatio).toBeGreaterThan(4);
  });

  it("random-position editing compresses ~1x (recorded, not asserted beyond a sanity bound)", () => {
    const r = randomPositionEditing(10_000);
    // eslint-disable-next-line no-console -- see above.
    console.log(
      `[compression] ${r.workload}: ${r.operationCount} ops -> ${r.blockCount} block(s), ` +
        `ratio ${r.compressionRatio.toFixed(3)}x`,
    );
    // Engine Spec §7.5's own framing: "random-position editing ≈ 1x, recorded not asserted" — the
    // only real assertion is a sanity bound ruling out a gross implementation error (e.g.
    // everything accidentally collapsing into one block, or compression somehow inflating count).
    expect(r.compressionRatio).toBeGreaterThanOrEqual(1);
    expect(r.compressionRatio).toBeLessThan(3);
  });

  it("M8-b: replica memory at 100,000 operations / ~10,000 visible", () => {
    // Warm up the JIT/allocator with a throwaway build of the same shape before the real
    // measurement, so the measured run isn't paying one-time compilation/allocator-warmup cost.
    buildMemoryTestDocument(20_000);

    const gc = (globalThis as { gc?: () => void }).gc;
    const measure = (): number => {
      gc?.();
      return process.memoryUsage().heapUsed;
    };

    const before = measure();
    const engine = buildMemoryTestDocument(100_000);
    const after = measure();
    const deltaBytes = after - before;
    const deltaMb = deltaBytes / (1024 * 1024);

    const stats = engine.stats();
    // eslint-disable-next-line no-console -- DoD explicitly requires the real number to be recorded.
    console.log(
      `[memory] M8-b: 100,000 ops / ${stats.visibleLength} visible / ${engine.blockCount} block(s) -> ` +
        `heapUsed delta ${deltaMb.toFixed(2)} MB (gc available: ${gc !== undefined}). ` +
        `RFC §2.5 measured 12.9 MB pre-blocks against a 10 MB target.`,
    );
    // Recorded, not hard-gated on the 10 MB target — Phase 20's own DoD: "If still over 10 MB:
    // record the exact number in CLAUDE.md as Test Plan C1 unresolved, and proceed — Phase 21's
    // GC is the next lever." This assertion only guards against a gross regression (memory usage
    // growing WITHOUT bound relative to document size), not the 10 MB target itself.
    expect(deltaMb).toBeGreaterThan(0);
    expect(deltaMb).toBeLessThan(200);
  });
});
