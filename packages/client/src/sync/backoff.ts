/**
 * Reconnection backoff (API Spec §3.10): "exponential backoff and full
 * jitter: base 500 ms, factor 2, cap 30 s, jitter uniform over
 * [0, computed]." Full jitter (not half jitter) specifically because a
 * coordinator restart disconnects every participant at once, and
 * correlated retries would thunder against the same sticky-routed
 * instance — so the delay is `random() * computed`, not
 * `computed/2 + random() * computed/2`.
 */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_CAP_MS = 30_000;

/**
 * "The counter resets only after a socket survives 60 seconds. A socket
 * that dies immediately after WELCOME must not reset the backoff, or a
 * crash-looping coordinator is hammered at 500 ms forever." (§3.10) — the
 * caller (SyncClient) is responsible for timing the 60s survival window
 * from when a socket opens and calling {@link Backoff.reset} only if that
 * window completes before the next disconnect; this class only computes
 * delays and counts attempts.
 */
export const BACKOFF_RESET_AFTER_MS = 60_000;

/**
 * Stateful backoff delay generator. `nextDelayMs()` both computes the next
 * delay AND advances the attempt counter — call it exactly once per
 * reconnect attempt.
 */
export class Backoff {
  private attempt = 0;

  /** Number of delays generated since construction or the last {@link reset}. Exposed for tests/observability only. */
  get attemptCount(): number {
    return this.attempt;
  }

  /** `random` is injectable so a test can assert exact values instead of merely "not identical" — defaults to `Math.random`. */
  nextDelayMs(random: () => number = Math.random): number {
    const computed = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * BACKOFF_FACTOR ** this.attempt);
    this.attempt += 1;
    return random() * computed;
  }

  /** Called only once a connection has survived {@link BACKOFF_RESET_AFTER_MS} — never on every successful connect. */
  reset(): void {
    this.attempt = 0;
  }
}
