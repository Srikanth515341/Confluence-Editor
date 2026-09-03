import type { CoordinatorSession } from "./documentCoordinator.js";
import { logger } from "./logger.js";

/**
 * §3.6.11's three liveness thresholds — kept as three DISTINCT constants,
 * per the phase brief's explicit "do not merge them" instruction, because
 * they trigger three unrelated effects (client send cadence; presence
 * marked stale; session evicted from the future GC frontier) even though
 * the first two are numerically close.
 */
export const PING_INTERVAL_MS = 3_000;
export const PRESENCE_STALE_MS = 8_000;
// 10 minutes, NOT the 8-second presence-stale threshold. These are different
// timers and merging them is a correctness bug: evicting at 8s lets GC collect
// tombstones a client mid-tunnel still needs as anchors, stranding its operations
// forever. API Spec §11.4; the failure trace is Engine Spec §10.3.
export const SESSION_INACTIVE_MS = 10 * 60 * 1000;

// Phase 21: this constant is now LIVE, but not read from here — Rule 7.1's eviction is
// implemented as the WHERE clause of `PostgresOperationStore.getStabilityFrontier`
// (packages/server/src/db/operationStore.ts), a SQL `now() - interval '10 minutes'`
// literal kept in sync with this constant's own value by hand (SQL cannot import a JS
// module). A session simply falls out of that query's own frontier computation once
// `last_seen_at` ages past the window — no separate in-memory eviction bookkeeping exists
// or is needed, since the frontier query IS the only place "is this replica still active"
// is ever asked (Engine Spec Definition 7.2).

/** Starts (or restarts) the 8-second presence-stale timer for a session — called on join and on every PING (§3.6.11). */
export function armPresenceStaleTimer(session: CoordinatorSession): void {
  if (session.staleTimer !== undefined) {
    clearTimeout(session.staleTimer);
  }
  const timer = setTimeout(() => markPresenceStale(session), PRESENCE_STALE_MS);
  // Never let this timer alone keep the Node process alive (e.g. in tests
  // that close the server without every session naturally disconnecting).
  timer.unref?.();
  session.staleTimer = timer;
}

/** Cancels a session's presence-stale timer — called once the connection closes. */
export function disarmPresenceStaleTimer(session: CoordinatorSession): void {
  if (session.staleTimer !== undefined) {
    clearTimeout(session.staleTimer);
    session.staleTimer = undefined;
  }
}

function markPresenceStale(session: CoordinatorSession): void {
  session.presenceStale = true;
  // No presence system exists yet (Phase 31) — this phase's whole
  // obligation is exactly this: log/mark stale, nothing more.
  logger.warn("presence.stale", {
    sessionId: session.sessionId,
    replicaId: session.replicaId,
    thresholdMs: PRESENCE_STALE_MS,
  });
}

/** Updates a session's last-seen timestamp and clears staleness on a received PING (§3.6.11), then re-arms the stale timer. */
export function onPingReceived(session: CoordinatorSession): void {
  session.lastPingAt = Date.now();
  if (session.presenceStale) {
    session.presenceStale = false;
    logger.info("presence.fresh", { sessionId: session.sessionId, replicaId: session.replicaId });
  }
  armPresenceStaleTimer(session);
}
