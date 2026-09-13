import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startLoadHarness, type LoadHarnessHandle } from "./loadHarness.js";

/**
 * A fast, small-scale smoke test proving the M7 load harness itself works correctly —
 * real handshake, real SNAPSHOT seeding, real typing/broadcast, real NTP-style clock-offset
 * sampling — before it's ever trusted to run the actual, much larger M7 sweep (Phase 38,
 * Test Plan §4.4/§4.2). Deliberately tiny (1 editor + 1 viewer, a few hundred ms, a small
 * baseline) — this is NOT the M7 curve itself, just proof the mechanism is sound.
 */
describe("M7 load harness — smoke test (Phase 38)", () => {
  let harness: LoadHarnessHandle | null = null;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = null;
  });

  it("connects, seeds a small baseline, runs one editor + one viewer, and produces real metrics", async () => {
    harness = await startLoadHarness(randomUUID());
    await harness.ensureCoordinator();
    const { elapsedMs: baselineElapsedMs } = harness.buildBaselineDocument(200);
    expect(baselineElapsedMs).toBeGreaterThanOrEqual(0);

    const result = await harness.runLevel({
      editorCount: 1,
      viewerCount: 1,
      durationMs: 1500,
      charsPerSecondPerEditor: 5,
    });

    expect(result.documentTotalElements).toBeGreaterThan(200); // 200 baseline + whatever the editor typed
    expect(result.opsBroadcastPerSecond).toBeGreaterThan(0); // the viewer must have received the editor's ops
    expect(result.latencySampleCount).toBeGreaterThan(0);
    expect(Number.isFinite(result.latencyP50Ms)).toBe(true);
    expect(result.latencyP50Ms).toBeGreaterThanOrEqual(0);
    // Same-machine, same-process harness — no real network skew, so the clock-offset
    // mechanism should report a tiny residual uncertainty regardless (Test Plan §4.2's own
    // "< 10ms" requirement, exercised here at 0ms injected RTT).
    expect(result.clockOffsetEstimate).not.toBeNull();
    expect(result.clockOffsetEstimate!.residualUncertaintyMs).toBeLessThan(10);
  }, 20_000);
});
