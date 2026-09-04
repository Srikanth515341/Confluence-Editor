// Phase 24 — the client-side half of offline window enforcement (API Spec
// §5.5, §10.5; PRD FR-OF-7; Test Plan RC-30/RC-31). Tracks how long this
// client has been away from `synced` and how many local operations it has
// minted during that window, so `SyncClient` can warn the user (8 min /
// 1,600 ops) and then refuse further edits outright once the hard bound
// (10 min / 2,000 ops, whichever comes first) is reached.
//
// Deliberately a small, standalone, clock-injectable class rather than
// logic buried inline in SyncClient — the same "pure, directly testable
// unit underneath a stateful class" split this project has used since
// Phase 21's GC safety cap (`clock`/`nowMs` parameters, never a bare
// `Date.now()` call inside the class itself) specifically so the RC-31
// boundary ("tested from both sides") can be asserted with exact,
// deterministic millisecond/op-count values — no real or fake timers,
// no SyncClient, no network.

/** Scope-IN's exact two thresholds. */
export const OFFLINE_WARN_MS = 8 * 60 * 1000;
export const OFFLINE_WARN_OPS = 1_600;
export const OFFLINE_CAP_MS = 10 * 60 * 1000;
export const OFFLINE_CAP_OPS = 2_000;

export type OfflineWindowLevel = "none" | "warn" | "capped";

export interface OfflineWindowStatus {
  readonly level: OfflineWindowLevel;
  /** Milliseconds since this client last left `synced` — 0 while fully synced (no window open). */
  readonly elapsedMs: number;
  /** Local operations minted since this client last left `synced`. */
  readonly opsCount: number;
}

/** Thrown by `SyncClient.localInsert`/`localInsertText`/`localDelete` once the hard cap (10 min OR 2,000 ops) has been reached — see `SyncClient.assertOfflineWindowNotExceeded`'s own doc comment for why this refuses the edit BEFORE it ever reaches `engine`, rather than minting it and only failing to queue/send it. */
export class OfflineWindowExceededError extends Error {
  constructor() {
    super(
      "SyncClient: the offline window has been exceeded (10 minutes or 2,000 operations since last synced) — no further local edits are accepted until reconnected. API Spec §5.5/§10.5.",
    );
    this.name = "OfflineWindowExceededError";
  }
}

export class OfflineWindowTracker {
  private offlineStartMs: number | null = null;
  private opsCount = 0;

  /**
   * Called whenever the connection transitions AWAY from `synced` — arms the window if it
   * isn't already armed. Idempotent: a client that stays `reconnecting`/`offline` across
   * several internal state transitions (e.g. one failed reconnect attempt followed by
   * another) does NOT get its clock/count reset each time — only a genuine return to `synced`
   * (`noteSynced`, below) ever resets it.
   */
  noteNotSynced(nowMs: number): void {
    if (this.offlineStartMs === null) {
      this.offlineStartMs = nowMs;
      this.opsCount = 0;
    }
  }

  /** Called on a successful transition INTO `synced` — the offline window (if any was open) is over; both the clock and the op count reset, ready for the NEXT disconnect. */
  noteSynced(): void {
    this.offlineStartMs = null;
    this.opsCount = 0;
  }

  /**
   * Whether a new local edit may be minted right now. Always `true` while fully synced
   * (`offlineStartMs === null`) — this tracker only ever constrains editing done WHILE not
   * synced; it has no opinion on ordinary, fully-connected editing. Once armed, `false` from
   * the exact instant EITHER the 10-minute OR 2,000-op bound is reached (Scope-IN: "stops
   * accepting new edits ... at the bound") — RC-31 is the boundary-from-both-sides proof of
   * this exact condition.
   */
  canAccept(nowMs: number): boolean {
    if (this.offlineStartMs === null) {
      return true;
    }
    return nowMs - this.offlineStartMs < OFFLINE_CAP_MS && this.opsCount < OFFLINE_CAP_OPS;
  }

  /** Records one locally-minted, ACCEPTED operation. Caller must have already confirmed `canAccept(nowMs)` — this method does not itself check the cap. */
  noteOperationAccepted(): void {
    this.opsCount += 1;
  }

  /** The current warning level plus the raw numbers it was computed from, for UI/observability (`SyncClient.offlineWindowStatus`). */
  status(nowMs: number): OfflineWindowStatus {
    if (this.offlineStartMs === null) {
      return { level: "none", elapsedMs: 0, opsCount: 0 };
    }
    const elapsedMs = nowMs - this.offlineStartMs;
    let level: OfflineWindowLevel = "none";
    if (elapsedMs >= OFFLINE_CAP_MS || this.opsCount >= OFFLINE_CAP_OPS) {
      level = "capped";
    } else if (elapsedMs >= OFFLINE_WARN_MS || this.opsCount >= OFFLINE_WARN_OPS) {
      level = "warn";
    }
    return { level, elapsedMs, opsCount: this.opsCount };
  }
}
