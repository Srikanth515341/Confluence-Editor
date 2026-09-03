/**
 * Sequence-gap tracking (API Spec §3.7.5): "If a client receives an OPS
 * frame with seq > lastServerSeq + 1, frames were lost... Client MUST:
 * apply the operation anyway... If [the connection] persists in a stalled
 * state for 5 seconds, close the socket and reconnect, which triggers a
 * normal catch-up over exactly the missing range."
 *
 * Phase 14 correction, found only by actually running a real multi-client
 * session for longer than 5 seconds (Test Plan §2.7's own E2E-CONV-01):
 * the server NEVER echoes a client's own operation back to it
 * (gateway.ts's `otherSessions(fromSessionId)` — Phase 8's own design).
 * That means EVERY client's own operations are permanent, structural
 * "holes" in the seq sequence it observes — not evidence of a dropped
 * frame, and not something that will EVER resolve by waiting. The
 * original implementation treated `seq > lastServerSeq + 1` as opening a
 * gap that only closes on an EXACT `lastServerSeq + 1` delivery — which,
 * for a hole that is structurally never going to be filled (the client's
 * own excluded op), can never happen. The practical effect: in ANY
 * session with two or more concurrent editors, every client force-
 * reconnected roughly 5 seconds after the first exchange of operations —
 * not a rare fault-recovery path, but a GUARANTEED, silent disruption of
 * ordinary multi-user editing, discovered because this project had never
 * before run a real multi-client exchange for longer than a few seconds.
 *
 * This class now tracks "is there any forward-moving seq activity at
 * all," not "is there a specific missing number." `observe()` advances
 * `value` to ANY newly-seen seq greater than the current one — regardless
 * of contiguity — and records that moment as forward progress. A `hasGap`
 * SIGNAL (informational only, not tied to reconnection) still exists for
 * observability, but the RECONNECT decision (see `SyncClient`, which
 * checks `hasStalled()` on the ping cadence rather than arming a one-shot
 * timer the instant any single hole appears) is based only on whether
 * forward progress has happened recently. This still satisfies the
 * spec's own text: a GENUINE drop (the server truly stops delivering
 * anything) still shows up as "no seq of any kind for 5+ seconds" and
 * still triggers reconnection — only the false-positive case (this
 * client's own, structurally-excluded operations) no longer does.
 */
export const GAP_RECONNECT_TIMEOUT_MS = 5_000;

export class SequenceGapTracker {
  private lastServerSeq: number;
  private lastAdvanceAtMsValue: number;
  private gapOpen = false;

  constructor(initialLastServerSeq = 0, now: () => number = Date.now) {
    this.lastServerSeq = initialLastServerSeq;
    this.lastAdvanceAtMsValue = now();
  }

  /** The highest seq observed so far (NOT necessarily contiguous from the start — see this class's own doc comment for why contiguity is no longer the tracked property). */
  get value(): number {
    return this.lastServerSeq;
  }

  /** Informational only (API Spec §3.7.5's own vocabulary) — true if the most recent advance skipped over at least one number. Never consulted for the reconnect decision; see `hasStalled()`. */
  get hasGap(): boolean {
    return this.gapOpen;
  }

  /**
   * True once {@link GAP_RECONNECT_TIMEOUT_MS} has passed with NO forward
   * seq progress at all. This — not "a specific seq number never
   * arrived" — is what actually indicates a stalled connection worth
   * reconnecting over; see this class's own doc comment for the false-
   * positive a per-number check produces.
   */
  hasStalled(now: () => number = Date.now): boolean {
    return now() - this.lastAdvanceAtMsValue >= GAP_RECONNECT_TIMEOUT_MS;
  }

  /**
   * Records one inbound OPS frame's `seq`, AFTER its operation(s) have
   * already been applied — this method never gates applying, only
   * bookkeeping. Advances `value` (and resets the stall clock) whenever
   * `seq` is newer than anything seen so far, REGARDLESS of whether it
   * was the immediately-next number — a duplicate or stale `seq` (<=
   * current `value`) is ignored for tracking purposes, relying on
   * `Engine.applyRemote`'s own idempotence for correctness.
   */
  observe(seq: number, now: () => number = Date.now): void {
    if (seq > this.lastServerSeq) {
      this.gapOpen = seq !== this.lastServerSeq + 1;
      this.lastServerSeq = seq;
      this.lastAdvanceAtMsValue = now();
    }
  }

  /**
   * Records "the connection is alive," WITHOUT advancing `value`/
   * `gapOpen` — a received PONG (§3.6.11) proves the socket is genuinely
   * healthy even though it carries no `seq` of its own and, unlike an OPS
   * frame, is not evidence about SEQUENCE progress specifically.
   *
   * Found necessary (not anticipated in advance) by Phase 22's own DUR-07
   * e2e test: a real two-client session that is completely idle — nobody
   * editing anything — for 5+ seconds previously had EVERY connected
   * client force-close and reconnect, repeatedly, forever, because
   * `hasStalled()`'s clock only ever advanced on `observe()`
   * (an inbound OPS frame) — and if nobody edits anything, no OPS frame
   * ever arrives, regardless of how healthy the connection actually is.
   * This is the exact same class of false-positive Phase 14's own
   * redesign of this file fixed for "this client's own excluded
   * operations" — a real, present cause of forward progress (the
   * connection being alive) was not recognized as such. `SyncClient`
   * calls this from its PONG handler (`handleControl`), which already
   * fires every `PING_INTERVAL_MS` (3s) on any genuinely live connection
   * — comfortably inside `GAP_RECONNECT_TIMEOUT_MS` (5s), so a real
   * stall (the server truly stops responding to PING too) still reaches
   * `hasStalled()` correctly; only the "nothing to say, but still
   * listening" case no longer does.
   */
  markAlive(now: () => number = Date.now): void {
    this.lastAdvanceAtMsValue = now();
  }

  /** Re-seeds tracking after a fresh SNAPSHOT (a new document state, seq-numbered from scratch as far as this client is concerned) — clears any open gap and resets the stall clock. */
  reset(newLastServerSeq: number, now: () => number = Date.now): void {
    this.lastServerSeq = newLastServerSeq;
    this.lastAdvanceAtMsValue = now();
    this.gapOpen = false;
  }
}
