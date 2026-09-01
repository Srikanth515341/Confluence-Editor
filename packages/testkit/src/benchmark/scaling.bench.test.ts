import { describe, expect, it } from "vitest";
import { measureScaling, type ScalingSample } from "./scaling.js";

/**
 * Phase 19 DoD — run via `pnpm test:benchmark`, gated out of the default
 * `pnpm test` (a timing-sensitive benchmark doesn't belong in a shared-CPU
 * inner-loop suite the same way convergence/properties/mutation don't).
 * Prints REAL measured numbers (not just a pass/fail) via console.log —
 * this project's own established convention (see CLAUDE.md's Phase 17
 * entry: "Give me the real numbers, not just the ratio") — and asserts
 * two things directly:
 *  1. p95 growth from 1,000 → 100,000 nodes is LOGARITHMIC, not linear.
 *     A O(N) linear scan (the pre-Phase-19 implementation) would grow
 *     roughly with N itself — Phase 19's own brief cites a measured 61x
 *     growth. O(log N) growth over a 100x size increase is
 *     log2(100,000)/log2(1,000) ≈ 1.67x — asserting the observed ratio
 *     stays under 10x leaves generous headroom for real timer noise
 *     while remaining utterly incompatible with linear (~100x) growth:
 *     nothing between "genuinely logarithmic" and "genuinely linear" would
 *     plausibly land under 10x by accident.
 *  2. M3-c: p99 local-insert latency at 100,000 nodes is ≤ 16ms.
 */
describe("PositionIndex scaling benchmark (Phase 19 DoD)", () => {
  it("p95 grows logarithmically from 1,000 to 100,000 nodes, and M3-c's p99 ≤ 16ms holds at 100,000", () => {
    const SAMPLE_COUNT = 500;
    const sizes = [1_000, 32_000, 100_000];
    const results: ScalingSample[] = sizes.map((size) => measureScaling(size, SAMPLE_COUNT, size));

    for (const r of results) {
      // eslint-disable-next-line no-console -- Phase 19 DoD explicitly requires real, reported numbers.
      console.log(
        `[scaling] N=${r.size.toString().padStart(6)}  build=${r.buildMs.toFixed(1)}ms  ` +
          `p50=${r.p50Ms.toFixed(3)}ms  p95=${r.p95Ms.toFixed(3)}ms  p99=${r.p99Ms.toFixed(3)}ms  ` +
          `max=${r.maxMs.toFixed(3)}ms`,
      );
    }

    const at1k = results[0]!;
    const at32k = results[1]!;
    const at100k = results[2]!;

    const p95GrowthRatio = at100k.p95Ms / Math.max(at1k.p95Ms, 0.001);
    // eslint-disable-next-line no-console -- see above.
    console.log(
      `[scaling] p95 growth 1,000 -> 100,000 nodes: ${p95GrowthRatio.toFixed(2)}x ` +
        `(expected ~1.67x for O(log N); a pre-Phase-19 O(N) scan measured ~61x)`,
    );

    expect(p95GrowthRatio).toBeLessThan(10);
    // Monotonic sanity: 32,000 shouldn't be slower than 100,000 by more than noise allows.
    expect(at32k.p95Ms).toBeLessThan(at100k.p95Ms + 5);

    // M3-c (Engine Spec §8.3 / RFC §10.4): 100,000-char document, local insert p99 ≤ 16ms.
    expect(at100k.p99Ms).toBeLessThanOrEqual(16);
  });
});
