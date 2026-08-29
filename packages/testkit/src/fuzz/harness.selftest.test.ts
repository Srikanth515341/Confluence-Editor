import { describe, expect, it } from "vitest";
import { createToyAdapter } from "./toyAdapter.js";
import { runFuzzSuite, runTrial } from "./runTrial.js";
import { C1_BASELINE } from "./configs.js";

/**
 * Meta-test: proves the harness ITSELF works, using the deliberately
 * broken toy engine (Test Plan Phase 2 Definition of Done). This is
 * distinct from — and runs under the ordinary `pnpm test`, unlike —
 * convergence.test.ts, which exercises the real engine and is expected to
 * fail until Phase 3.
 */
describe("fuzz harness self-test", () => {
  it("detects the deliberately broken toy engine as divergent within 10 seeds", () => {
    const factory = createToyAdapter();
    let firstDivergentSeed: number | null = null;

    for (let seed = 0; seed < 10; seed++) {
      const outcome = runTrial(seed, C1_BASELINE, factory);
      if (outcome.status === "diverged") {
        firstDivergentSeed = seed;
        break;
      }
    }

    expect(firstDivergentSeed).not.toBeNull();
  });

  it("completes 10,000 seeds of the toy engine in under 30 seconds", () => {
    const factory = createToyAdapter();
    const start = performance.now();
    const summary = runFuzzSuite(C1_BASELINE, factory, 10_000);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(30_000);

    // The toy engine is wrong on purpose — most seeds should diverge, not
    // converge. This proves the run did real work rather than silently
    // no-op'ing (e.g. every replica staying empty).
    expect(summary.diverged.length).toBeGreaterThan(0);
  });

  it("pendingCount() assertion is independent of the text-equality assertion", () => {
    // Test Plan §2.8: a replica that silently dropped an operation instead
    // of buffering it can still produce matching text if the drop
    // happened to be a duplicate. The toy engine never buffers anything
    // (pendingCount() is hardwired to 0), so this test only documents the
    // property the real engine's fuzz run will rely on — it does not
    // exercise a genuine stuck-pending case, since the toy has none.
    const factory = createToyAdapter();
    const outcome = runTrial(0, C1_BASELINE, factory);
    expect(outcome.status).not.toBe("stuck-pending");
  });
});
