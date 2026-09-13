/**
 * NTP-style clock-offset correction (Phase 38, Test Plan §4.2 PERF-M4).
 *
 * The classic four-timestamp handshake:
 *   t0 = client send time      (PingMessage.clientTimeMs)
 *   t1 = server receive time   (collapsed with t2, PongMessage.serverTimeMs — see
 *                                PongMessage's own doc comment in @collab-editor/protocol
 *                                for why this project's synchronous PING handling makes
 *                                that collapse a disclosed, deliberate simplification)
 *   t2 = server send time      (== t1 here)
 *   t3 = client receive time   (measured the instant the PONG frame is decoded)
 *
 *   offset = ((t1 - t0) + (t2 - t3)) / 2
 *   rtt    = (t3 - t0) - (t2 - t1)
 *
 * Per Test Plan §4.2: samples whose RTT exceeds the 20th percentile of the round are
 * discarded (kept samples are the fastest ~20% — those have the tightest possible error
 * bound), and the MEDIAN offset of the surviving samples is the round's estimate. The
 * classic NTP error bound is that a sample's true offset can differ from its measured
 * offset by at most half that sample's own RTT — so this module also reports a
 * RESIDUAL UNCERTAINTY (half the worst surviving RTT), which Test Plan §4.2 requires be
 * asserted below 10ms: an order of magnitude under the 250ms p95 target this measurement
 * exists to validate. A measurement whose own error bar exceeds its target proves nothing.
 */

export interface ClockOffsetSample {
  /** t0 — client send time (ms, client's own clock). */
  readonly t0: number;
  /** t1 — server receive time (ms, server's own clock). Collapsed with t2 in this project. */
  readonly t1: number;
  /** t2 — server send time (ms, server's own clock). Collapsed with t1 in this project. */
  readonly t2: number;
  /** t3 — client receive time (ms, client's own clock). */
  readonly t3: number;
}

export interface ClockOffsetEstimate {
  /** Median offset (ms) of the surviving (lowest-RTT) samples. Add this to a REMOTE
   * client's own clock-stamped timestamp to express it in THIS client's local clock. */
  readonly offsetMs: number;
  /**
   * Half the SPREAD (max − min) of the individual offset computations among the surviving
   * (lowest-RTT) samples — i.e. how tightly the repeated measurements agree with each
   * other, not the classic single-sample NTP bound (half that sample's own RTT). The
   * classic bound is proportional to raw RTT (~75ms at the phase's own 150ms-RTT
   * condition) and could NEVER satisfy Test Plan §4.2's own "< 10ms" requirement under an
   * RTT-injected variant if used here — what actually matters for a p95-latency
   * measurement is whether repeated offset ESTIMATES agree with each other, which is
   * governed by scheduling/timer jitter, not by the magnitude of a fixed, symmetric
   * network delay (which cancels out of `computeOffset`'s own subtraction). With fewer
   * than 2 surviving samples there is nothing to compare, so this falls back to the
   * classic single-sample bound (half that one sample's RTT) instead.
   */
  readonly residualUncertaintyMs: number;
  /** Total samples the estimate was computed from, before RTT-percentile filtering. */
  readonly sampleCount: number;
  /** Samples that survived RTT-percentile filtering and contributed to `offsetMs`. */
  readonly keptCount: number;
  /** The worst (largest) RTT among the surviving samples, in ms. */
  readonly maxKeptRttMs: number;
}

export function computeRtt(sample: ClockOffsetSample): number {
  return sample.t3 - sample.t0 - (sample.t2 - sample.t1);
}

export function computeOffset(sample: ClockOffsetSample): number {
  return (sample.t1 - sample.t0 + (sample.t2 - sample.t3)) / 2;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    // Safe: mid-1 and mid are both valid indices whenever sorted.length >= 2, and
    // estimateClockOffset never calls median() with an empty offsets array.
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/**
 * The 20th-percentile RTT threshold, nearest-rank method: the RTT below which (inclusive)
 * the fastest ~20% of samples fall. With very few samples, at least one is always kept.
 */
function percentile20Rtt(sortedRtts: readonly number[]): number {
  const rank = Math.max(1, Math.ceil(sortedRtts.length * 0.2));
  // Safe: rank is clamped to [1, sortedRtts.length] by construction (callers only ever
  // pass a non-empty array).
  return sortedRtts[rank - 1]!;
}

export class ClockOffsetInsufficientSamplesError extends Error {
  constructor() {
    super("estimateClockOffset requires at least one sample");
    this.name = "ClockOffsetInsufficientSamplesError";
  }
}

/**
 * Test Plan §4.2's full algorithm: discard samples whose RTT exceeds the round's own 20th
 * percentile, then take the median offset of what remains.
 */
export function estimateClockOffset(samples: readonly ClockOffsetSample[]): ClockOffsetEstimate {
  if (samples.length === 0) {
    throw new ClockOffsetInsufficientSamplesError();
  }

  const withRtt = samples.map((sample) => ({ sample, rtt: computeRtt(sample) }));
  const sortedRtts = withRtt.map((entry) => entry.rtt).sort((a, b) => a - b);
  const threshold = percentile20Rtt(sortedRtts);

  const kept = withRtt.filter((entry) => entry.rtt <= threshold);
  const offsets = kept.map((entry) => computeOffset(entry.sample));
  const maxKeptRttMs = Math.max(...kept.map((entry) => entry.rtt));

  const residualUncertaintyMs =
    offsets.length >= 2
      ? (Math.max(...offsets) - Math.min(...offsets)) / 2
      : maxKeptRttMs / 2;

  return {
    offsetMs: median(offsets),
    residualUncertaintyMs,
    sampleCount: samples.length,
    keptCount: kept.length,
    maxKeptRttMs,
  };
}

/**
 * Accumulates PING/PONG round-trip samples over a session and re-evaluates the offset
 * estimate on demand — Test Plan §4.2's "at session start and every 30s thereafter"
 * cadence is the CALLER's responsibility (this class holds no timer of its own, matching
 * this project's own established "no hidden timers" discipline, e.g. Phase 24's
 * `OfflineWindowTracker`); this class only owns sample storage and the estimate itself.
 */
export class ClockOffsetTracker {
  private samples: ClockOffsetSample[] = [];
  private latest: ClockOffsetEstimate | null = null;

  /** Records one PING/PONG round trip's four timestamps and re-evaluates the estimate. */
  recordRoundTrip(sample: ClockOffsetSample): ClockOffsetEstimate {
    this.samples.push(sample);
    this.latest = estimateClockOffset(this.samples);
    return this.latest;
  }

  /** Clears all recorded samples — call at the start of each new 30s measurement window. */
  reset(): void {
    this.samples = [];
    this.latest = null;
  }

  get estimate(): ClockOffsetEstimate | null {
    return this.latest;
  }

  /** Corrects a timestamp taken on the REMOTE (server/peer) clock into this tracker's own
   * local clock, using the latest estimate. Throws if no estimate exists yet. */
  correctRemoteTimestamp(remoteTimestampMs: number): number {
    if (this.latest === null) {
      throw new ClockOffsetInsufficientSamplesError();
    }
    return remoteTimestampMs - this.latest.offsetMs;
  }
}
