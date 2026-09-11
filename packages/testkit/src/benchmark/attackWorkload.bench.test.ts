import { describe, it } from "vitest";
import { measureAttackWorkload, type AttackWorkloadSample } from "./attackWorkload.js";

/**
 * Phase 30 (RFC §8.2 (T2), Test Plan SEC-08) — run via `pnpm test:benchmark`, gated out of the
 * default `pnpm test` for the same reason every other timing-sensitive benchmark in this file's
 * own directory is. This is a REAL MEASUREMENT, not an assertion-bearing test: the phase brief's
 * own explicit question ("does a sustained 1,000 ops/s attack cause the server itself to become
 * unresponsive due to Fugue's own per-op cost BEFORE the rate limiter even has a chance to
 * throttle it?") is a finding to REPORT, not a pass/fail this file is positioned to gate on —
 * see this project's own CLAUDE.md Phase 30 entry for the answer this measurement produced and
 * the reasoning built on top of it.
 *
 * Sizes deliberately bounded to 500/2,000/4,000 -- the SAME scale Phase 25's own M8-a benchmark
 * (finalMemoryLatency.bench.test.ts) already established as practical under Fugue's real,
 * disclosed O(N²) sequential-insertion cost (CLAUDE.md's Open Item 3); that same phase found even
 * 100,000 total operations impractical to build in a fast test's own real time budget (killed
 * after 71 real minutes). This benchmark's own numbers at true production scale (tens of
 * thousands of nodes and beyond) therefore remain genuinely UNKNOWN, exactly like M8-a's own
 * still-open memory question -- both close automatically once Item 3's balanced-storage redesign
 * lands. What CAN be measured here, honestly, is the TREND across the sizes that are practical to
 * build today, which is what this test reports.
 */
describe("Attack-workload apply-latency benchmark (Phase 30, SEC-08 -- 'does Fugue's own per-op cost outrun the rate limiter?')", () => {
  it("measures Engine.localInsert's real per-op cost under the scattered insert-then-delete attack shape, at increasing structure sizes", () => {
    const SAMPLE_COUNT = 300;
    const sizes = [500, 2_000, 4_000];
    const results: AttackWorkloadSample[] = sizes.map((size) => measureAttackWorkload(size, SAMPLE_COUNT, size));

    for (const r of results) {
      // eslint-disable-next-line no-console -- this project's own established convention (Phase 17 CLAUDE.md entry): "give me the real numbers."
      console.log(
        `[attackWorkload] structureSize=${r.structureSize.toString().padStart(6)}  build=${r.buildMs.toFixed(1)}ms  ` +
          `p50=${r.p50Ms.toFixed(3)}ms  p95=${r.p95Ms.toFixed(3)}ms  p99=${r.p99Ms.toFixed(3)}ms  max=${r.maxMs.toFixed(3)}ms  ` +
          `impliedMaxOpsPerSecondAtP95=${r.impliedMaxOpsPerSecondAtP95.toFixed(0)}`,
      );
    }

    // The actual question this benchmark exists to answer, stated as a real computed number
    // rather than left implicit: at each measured scale, how does the per-session rate limiter's
    // own default cap (200 accepted messages/second, config.ts's DEFAULT_RATE_LIMIT_PER_SESSION_MAX)
    // compare against the maximum throughput this per-op cost alone would allow?
    for (const r of results) {
      const utilizationAtCap = 200 / r.impliedMaxOpsPerSecondAtP95;
      // eslint-disable-next-line no-console
      console.log(
        `[attackWorkload] at structureSize=${r.structureSize}: accepting the full 200/s per-session ` +
          `cap would consume ${(utilizationAtCap * 100).toFixed(2)}% of the per-op-cost-implied ` +
          `throughput ceiling (${r.impliedMaxOpsPerSecondAtP95.toFixed(0)} ops/s)`,
      );
    }
  });
});
