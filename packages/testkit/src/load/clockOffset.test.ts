import { describe, expect, it } from "vitest";
import {
  ClockOffsetInsufficientSamplesError,
  ClockOffsetTracker,
  computeOffset,
  computeRtt,
  estimateClockOffset,
  type ClockOffsetSample,
} from "./clockOffset.js";

// A synthetic sample where the client's clock is `trueOffsetMs` ahead of the server's own
// clock, and the round trip has `oneWayMs` of (symmetric) network delay in each direction.
// `serverClockNoiseMs` perturbs ONLY the server's own collapsed t1/t2 reading (this
// project's disclosed t1=t2 simplification, PongMessage's own doc comment) — modeling real
// scheduling/timer jitter in the server's own Date.now() read, as opposed to `oneWayMs`,
// which models a symmetric, deliberately-injected network delay (e.g. via a fault-relay).
//
// Because t1 === t2 always in this project, `computeRtt` (= (t3-t0) - (t2-t1)) algebraically
// reduces to plain (t3-t0) — it is NOT affected by `serverClockNoiseMs` at all, only by
// `oneWayMs`. And `computeOffset` (= ((t1-t0)+(t2-t3))/2 = t1 - (t0+t3)/2) is NOT affected by
// `oneWayMs` at all when the delay is symmetric (it cancels), only by `trueOffsetMs` and
// `serverClockNoiseMs`. This is exactly the real-world property that makes Test Plan §4.2's
// own "150ms injected RTT... residual uncertainty < 10ms" combination possible at all: a
// SYMMETRIC injected delay (which a real fault-relay applies equally in both directions)
// contributes nothing to the classic NTP worst-case error bound in practice — only genuine
// per-sample scheduling noise does, and that stays small regardless of how large the
// injected RTT is.
function buildSample(
  clientSendMs: number,
  trueOffsetMs: number,
  oneWayMs: number,
  serverClockNoiseMs = 0,
): ClockOffsetSample {
  const t0 = clientSendMs;
  const serverNowMs = t0 - trueOffsetMs + oneWayMs + serverClockNoiseMs;
  const t1 = serverNowMs;
  const t2 = serverNowMs;
  const t3 = t0 + 2 * oneWayMs;
  return { t0, t1, t2, t3 };
}

describe("computeRtt / computeOffset (Test Plan §4.2)", () => {
  it("computes rtt as the round trip, independent of the collapsed server timestamp", () => {
    const sample = buildSample(1000, 50, 30);
    expect(computeRtt(sample)).toBeCloseTo(60, 5);
  });

  it("computes offset matching the synthetic true offset when the delay is symmetric", () => {
    const sample = buildSample(1000, 50, 30);
    expect(computeOffset(sample)).toBeCloseTo(-50, 5);
  });

  it("offset is unaffected by symmetric one-way delay magnitude — only asymmetry/noise moves it", () => {
    const shortDelay = computeOffset(buildSample(1000, 50, 10));
    const longDelay = computeOffset(buildSample(1000, 50, 250));
    expect(shortDelay).toBeCloseTo(longDelay, 5);
  });
});

describe("estimateClockOffset (Test Plan §4.2)", () => {
  it("throws ClockOffsetInsufficientSamplesError on an empty sample set", () => {
    expect(() => estimateClockOffset([])).toThrow(ClockOffsetInsufficientSamplesError);
  });

  it("recovers the true offset exactly when every sample has identical, symmetric rtt", () => {
    const samples = Array.from({ length: 10 }, (_, i) => buildSample(1000 + i * 100, 42, 20));
    const estimate = estimateClockOffset(samples);
    expect(estimate.offsetMs).toBeCloseTo(-42, 5);
    expect(estimate.sampleCount).toBe(10);
  });

  it("discards the slowest 80% of samples by rtt, keeping only the fastest 20th percentile", () => {
    const fast = Array.from({ length: 8 }, (_, i) => buildSample(1000 + i * 100, 10, 5));
    const slow = Array.from({ length: 32 }, (_, i) => buildSample(2000 + i * 100, 500, 200));
    const samples = [...fast, ...slow];
    const estimate = estimateClockOffset(samples);
    expect(estimate.sampleCount).toBe(40);
    expect(estimate.keptCount).toBeLessThanOrEqual(8);
    expect(estimate.keptCount).toBeGreaterThan(0);
    expect(estimate.offsetMs).toBeCloseTo(-10, 5);
  });

  it("reports a residual uncertainty of half the SPREAD of offsets among kept samples, not raw rtt", () => {
    // 5 samples, all identical rtt (16ms — all survive filtering), with small server-clock
    // noise spread across ±2ms — the offset estimates disagree by up to 4ms, so the
    // residual uncertainty (half that spread) is 2ms, NOT half the 16ms rtt (8ms).
    const samples = [-2, -1, 0, 1, 2].map((noise, i) => buildSample(1000 + i * 100, 10, 8, noise));
    const estimate = estimateClockOffset(samples);
    expect(estimate.keptCount).toBe(5);
    expect(estimate.maxKeptRttMs).toBeCloseTo(16, 5);
    expect(estimate.residualUncertaintyMs).toBeCloseTo(2, 5);
  });

  it("falls back to half the single sample's own rtt when fewer than 2 samples survive filtering", () => {
    const estimate = estimateClockOffset([buildSample(1000, 5, 3)]);
    expect(estimate.keptCount).toBe(1);
    expect(estimate.residualUncertaintyMs).toBeCloseTo(3, 5); // rtt = 2*3 = 6, half = 3
  });

  it("satisfies Test Plan §4.2's own residual-uncertainty assertion (< 10ms) at the phase's own 150ms-RTT condition", () => {
    // 16 samples at the phase's own 150ms injected RTT (oneWayMs=75) with small (±2ms)
    // server-clock scheduling noise, plus 4 jitter/congestion outliers at a much higher rtt
    // (oneWayMs=400) that the 20th-percentile filter is expected to discard. This directly
    // demonstrates the real-world property explained in buildSample's own comment above:
    // a large but SYMMETRIC injected RTT does not, by itself, threaten the residual-
    // uncertainty bound — only genuine per-sample noise does, and that stays small.
    const tight = Array.from({ length: 16 }, (_, i) =>
      buildSample(1000 + i * 1000, 15, 75, (i % 5) - 2),
    );
    const outliers = Array.from({ length: 4 }, (_, i) =>
      buildSample(20000 + i * 1000, 15, 400, 100),
    );
    const estimate = estimateClockOffset([...tight, ...outliers]);
    expect(estimate.maxKeptRttMs).toBeCloseTo(150, 5);
    expect(estimate.residualUncertaintyMs).toBeLessThan(10);
  });
});

describe("ClockOffsetTracker", () => {
  it("re-evaluates the estimate on every recorded round trip", () => {
    const tracker = new ClockOffsetTracker();
    expect(tracker.estimate).toBeNull();
    const est1 = tracker.recordRoundTrip(buildSample(1000, 20, 10));
    expect(est1.sampleCount).toBe(1);
    const est2 = tracker.recordRoundTrip(buildSample(1100, 20, 10));
    expect(est2.sampleCount).toBe(2);
    expect(tracker.estimate).toBe(est2);
  });

  it("reset() clears samples and the estimate, per the 30s re-evaluation window", () => {
    const tracker = new ClockOffsetTracker();
    tracker.recordRoundTrip(buildSample(1000, 20, 10));
    tracker.reset();
    expect(tracker.estimate).toBeNull();
  });

  it("correctRemoteTimestamp throws before any sample has been recorded", () => {
    const tracker = new ClockOffsetTracker();
    expect(() => tracker.correctRemoteTimestamp(1000)).toThrow(
      ClockOffsetInsufficientSamplesError,
    );
  });

  it("correctRemoteTimestamp converts a remote (server) timestamp into local clock terms", () => {
    const tracker = new ClockOffsetTracker();
    // Client is 50ms AHEAD of the server (trueOffsetMs = 50 means client - server = 50).
    for (let i = 0; i < 5; i++) {
      tracker.recordRoundTrip(buildSample(1000 + i * 100, 50, 15));
    }
    // A server-stamped event at server-clock time 2000 should read as 2050 on the client's
    // own clock (client is ahead), i.e. remoteTimestamp - offsetMs where offsetMs = -50.
    const corrected = tracker.correctRemoteTimestamp(2000);
    expect(corrected).toBeCloseTo(2050, 0);
  });
});
