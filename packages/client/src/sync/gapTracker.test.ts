import { describe, expect, it } from "vitest";
import { SequenceGapTracker } from "./gapTracker.js";

describe("SequenceGapTracker (API Spec §3.7.5)", () => {
  it("advances normally on contiguous seqs", () => {
    const tracker = new SequenceGapTracker(0);
    tracker.observe(1);
    tracker.observe(2);
    tracker.observe(3);
    expect(tracker.value).toBe(3);
    expect(tracker.hasGap).toBe(false);
  });

  it("opens a gap on a skipped seq and does NOT advance lastServerSeq past it", () => {
    const tracker = new SequenceGapTracker(5);
    tracker.observe(9); // skipped 6, 7, 8
    expect(tracker.hasGap).toBe(true);
    expect(tracker.value).toBe(5); // unchanged — "NOT advance lastServerSeq past the gap"
  });

  it("keeps the gap open (and lastServerSeq unchanged) as more frames arrive past it", () => {
    const tracker = new SequenceGapTracker(5);
    tracker.observe(9);
    tracker.observe(10);
    tracker.observe(11);
    expect(tracker.hasGap).toBe(true);
    expect(tracker.value).toBe(5);
  });

  it("records the timestamp a gap was first observed, and does not move it on subsequent gap frames", () => {
    const tracker = new SequenceGapTracker(0);
    let now = 1_000;
    tracker.observe(5, () => now);
    expect(tracker.gapOpenedAtMs).toBe(1_000);
    now = 2_000;
    tracker.observe(6, () => now); // still past the gap — must not reset the "opened at" timestamp
    expect(tracker.gapOpenedAtMs).toBe(1_000);
  });

  it("ignores a duplicate or stale seq (<= lastServerSeq) for tracking purposes", () => {
    const tracker = new SequenceGapTracker(5);
    tracker.observe(3); // stale
    expect(tracker.value).toBe(5);
    expect(tracker.hasGap).toBe(false);
    tracker.observe(5); // duplicate of current
    expect(tracker.value).toBe(5);
    expect(tracker.hasGap).toBe(false);
  });

  it("reset() re-seeds lastServerSeq and clears any open gap (a fresh SNAPSHOT after reconnect)", () => {
    const tracker = new SequenceGapTracker(5);
    tracker.observe(9);
    expect(tracker.hasGap).toBe(true);
    tracker.reset(100);
    expect(tracker.value).toBe(100);
    expect(tracker.hasGap).toBe(false);
    expect(tracker.gapOpenedAtMs).toBeNull();
  });
});
