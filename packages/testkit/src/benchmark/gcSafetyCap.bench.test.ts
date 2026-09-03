import { describe, expect, it } from "vitest";
import { measureGcSafetyCap } from "./gcSafetyCap.js";

/**
 * Phase 21 DoD (safety-cap containment) — run via `pnpm test:benchmark`, gated out of the
 * default `pnpm test` for the same reason as the Phase 19/20 benchmarks in this same
 * directory (a timing-sensitive measurement doesn't belong in a shared-CPU inner-loop suite).
 * Prints the REAL measured number (not just pass/fail), per this project's own established
 * convention (CLAUDE.md's Phase 17 entry: "Give me the real numbers, not just the ratio").
 *
 * The claim under test: `Engine.collect()`'s wall-clock safety cap (`CollectOptions.budgetMs`/
 * `clock`) bounds the pathological 10,000-deep/90,000-node anchor-chain case — which measured
 * 853 SECONDS uncapped during M8-c's own DoD verification — to a small fraction of a second,
 * without ever collecting anything incorrectly (see engine.test.ts's own correctness suite for
 * the I4/I5 proof; this file is ONLY about the real timing claim).
 */
describe("GC safety cap — real wall-clock measurement (Phase 21 DoD)", () => {
  it("a capped sweep over the pathological chain completes in well under a second, not 853,000ms", () => {
    const budgetMs = 150;
    const m = measureGcSafetyCap(budgetMs);

    // eslint-disable-next-line no-console -- Phase 21 DoD explicitly requires real, reported numbers.
    console.log(
      `[gc-safety-cap] budgetMs=${budgetMs}  elapsed=${m.elapsedMs.toFixed(1)}ms ` +
        `(uncapped measured 853,000ms)  incomplete=${m.incomplete}  collectedCount=${m.collectedCount}  ` +
        `tombstones ${m.tombstonesBefore}->${m.tombstonesAfter}`,
    );

    // A small, generous multiple of the budget -- real timer/GC-pause noise gets headroom,
    // while remaining light-years away from the 853,000ms uncapped baseline.
    expect(m.elapsedMs).toBeLessThan(2_000);
    expect(m.incomplete).toBe(true);
    expect(m.collectedCount).toBe(0); // an incomplete sweep must never collect anything
    expect(m.tombstonesBefore).toBe(10_000);
    expect(m.tombstonesAfter).toBe(10_000); // unchanged -- nothing was physically removed
  });
});
