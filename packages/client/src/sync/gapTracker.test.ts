import { describe, expect, it } from "vitest";
import { GAP_RECONNECT_TIMEOUT_MS, SequenceGapTracker } from "./gapTracker.js";

describe("SequenceGapTracker (API Spec §3.7.5, corrected Phase 14 — see this class's own doc comment)", () => {
  it("advances normally on contiguous seqs, with no gap", () => {
    const tracker = new SequenceGapTracker(0);
    tracker.observe(1);
    tracker.observe(2);
    tracker.observe(3);
    expect(tracker.value).toBe(3);
    expect(tracker.hasGap).toBe(false);
  });

  it("a skipped seq STILL advances value (unlike the pre-Phase-14 behavior) and marks hasGap informationally", () => {
    const tracker = new SequenceGapTracker(5);
    tracker.observe(9); // skipped 6, 7, 8 — e.g. this client's own 3 excluded operations
    expect(tracker.value).toBe(9); // advances anyway — a permanently-missing number must not freeze progress
    expect(tracker.hasGap).toBe(true); // informational only, not tied to reconnection (see hasStalled)
  });

  it("hasGap clears once a later seq arrives that IS exactly contiguous with the new high-water mark", () => {
    const tracker = new SequenceGapTracker(5);
    tracker.observe(9);
    expect(tracker.hasGap).toBe(true);
    tracker.observe(10); // exactly value+1 — a genuinely contiguous delivery
    expect(tracker.hasGap).toBe(false);
  });

  it("ignores a duplicate or stale seq (<= value) for tracking purposes", () => {
    const tracker = new SequenceGapTracker(5);
    tracker.observe(3); // stale
    expect(tracker.value).toBe(5);
    tracker.observe(5); // duplicate of current
    expect(tracker.value).toBe(5);
  });

  it("reset() re-seeds value and clears any open gap (a fresh SNAPSHOT after reconnect)", () => {
    const tracker = new SequenceGapTracker(5);
    tracker.observe(9);
    expect(tracker.hasGap).toBe(true);
    tracker.reset(100);
    expect(tracker.value).toBe(100);
    expect(tracker.hasGap).toBe(false);
  });

  describe("hasStalled — the actual reconnect signal (replaces the old per-number gap check)", () => {
    it("is false immediately, and stays false as long as SOME seq keeps arriving, even non-contiguously", () => {
      let now = 0;
      const tracker = new SequenceGapTracker(0, () => now);
      expect(tracker.hasStalled(() => now)).toBe(false);

      now = 4_000;
      tracker.observe(9, () => now); // a "gap" (own excluded ops), but still forward progress
      expect(tracker.hasStalled(() => now)).toBe(false);

      now = 4_000 + GAP_RECONNECT_TIMEOUT_MS - 1;
      // no new seq arrived, but we're still under the threshold since the LAST advance
      expect(tracker.hasStalled(() => now)).toBe(false);

      now = 4_000 + GAP_RECONNECT_TIMEOUT_MS;
      tracker.observe(15, () => now); // fresh progress resets the clock
      expect(tracker.hasStalled(() => now)).toBe(false);
    });

    it("becomes true once GAP_RECONNECT_TIMEOUT_MS passes with NO forward progress at all — a genuine stall", () => {
      let now = 0;
      const tracker = new SequenceGapTracker(0, () => now);
      tracker.observe(9, () => now);

      now = GAP_RECONNECT_TIMEOUT_MS - 1;
      expect(tracker.hasStalled(() => now)).toBe(false);

      now = GAP_RECONNECT_TIMEOUT_MS;
      expect(tracker.hasStalled(() => now)).toBe(true);
    });

    it("this client's OWN permanently-excluded operations never cause a false stall, even over a long session", () => {
      // Simulates exactly the Phase 14 finding: a client whose own ops create permanent numeric
      // holes, but where OTHER clients' ops keep arriving every ~200ms for well over 5 seconds.
      let now = 0;
      const tracker = new SequenceGapTracker(0, () => now);
      let seq = 0;
      for (let i = 0; i < 100; i++) {
        now += 200;
        seq += 2; // every OTHER seq is this client's own, permanently never observed
        tracker.observe(seq, () => now);
        expect(tracker.hasStalled(() => now)).toBe(false);
      }
    });

    it("reset() clears a stall", () => {
      let now = 0;
      const tracker = new SequenceGapTracker(0, () => now);
      now = GAP_RECONNECT_TIMEOUT_MS;
      expect(tracker.hasStalled(() => now)).toBe(true);
      tracker.reset(0, () => now);
      expect(tracker.hasStalled(() => now)).toBe(false);
    });
  });
});
