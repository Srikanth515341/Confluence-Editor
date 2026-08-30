/**
 * Sequence-gap tracking (API Spec §3.7.5): "If a client receives an OPS
 * frame with seq > lastServerSeq + 1, frames were lost... Client MUST:
 * apply the operation anyway... record the gap, and NOT advance
 * lastServerSeq past the gap. If the gap persists for 5 seconds, close the
 * socket and reconnect, which triggers a normal catch-up over exactly the
 * missing range."
 *
 * This class only tracks the contiguous high-water mark and whether a gap
 * is currently open — it does NOT apply operations (SyncClient does that
 * unconditionally, "apply anyway", before ever consulting this tracker)
 * and does NOT itself close any socket (SyncClient arms a plain timer off
 * {@link hasGap} and reuses the ordinary reconnect path — "Do not build a
 * second gap-repair mechanism; reconnection already is one").
 */
export const GAP_RECONNECT_TIMEOUT_MS = 5_000;

export class SequenceGapTracker {
  private lastServerSeq: number;
  private gapOpenedAtMsValue: number | null = null;

  constructor(initialLastServerSeq = 0) {
    this.lastServerSeq = initialLastServerSeq;
  }

  /** The highest seq confirmed CONTIGUOUS from the start — never advances past an open gap. */
  get value(): number {
    return this.lastServerSeq;
  }

  get hasGap(): boolean {
    return this.gapOpenedAtMsValue !== null;
  }

  /** `null` when no gap is open; otherwise the `now()` timestamp the gap was first observed. */
  get gapOpenedAtMs(): number | null {
    return this.gapOpenedAtMsValue;
  }

  /**
   * Records one inbound OPS frame's `seq`, AFTER its operation(s) have
   * already been applied — this method never gates applying, only
   * bookkeeping. `seq === lastServerSeq + 1` advances normally;
   * `seq > lastServerSeq + 1` opens (or continues) a gap without
   * advancing; `seq <= lastServerSeq` (a duplicate, or — once
   * reconnection/CATCHUP exists in Phase 23 — a backfilled frame) is
   * ignored for tracking purposes, relying on `Engine.applyRemote`'s own
   * idempotence for correctness.
   */
  observe(seq: number, now: () => number = Date.now): void {
    if (seq === this.lastServerSeq + 1) {
      this.lastServerSeq = seq;
    } else if (seq > this.lastServerSeq + 1 && this.gapOpenedAtMsValue === null) {
      this.gapOpenedAtMsValue = now();
    }
  }

  /** Re-seeds tracking after a fresh SNAPSHOT (a new document state, seq-numbered from scratch as far as this client is concerned) — clears any open gap. */
  reset(newLastServerSeq: number): void {
    this.lastServerSeq = newLastServerSeq;
    this.gapOpenedAtMsValue = null;
  }
}
