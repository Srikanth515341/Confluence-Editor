import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armPresenceStaleTimer,
  disarmPresenceStaleTimer,
  onPingReceived,
  PING_INTERVAL_MS,
  PRESENCE_STALE_MS,
} from "./heartbeat.js";
import type { CoordinatorSession } from "./documentCoordinator.js";
import { ConnectionSendQueues } from "./sendQueues.js";
import { logger } from "./logger.js";
import { SessionRole } from "@collab-editor/protocol";

function fakeSession(replicaId = 1): CoordinatorSession {
  return {
    sessionId: `session-${replicaId}`,
    replicaId,
    queues: new ConnectionSendQueues(
      () => Promise.resolve(),
      () => false,
    ),
    role: SessionRole.EDITOR,
    userId: `user-${replicaId}`,
    displayName: `Guest ${replicaId}`,
    lastPingAt: Date.now(),
    presenceStale: false,
    staleTimer: undefined,
    // Phase 14's diagnostic-only counter (documentCoordinator.ts's
    // CoordinatorSession.receivedFrameCount) — this fixture never
    // exercises frame receipt, so 0 is a correct fixed value, not a
    // placeholder standing in for real behavior.
    receivedFrameCount: 0,
  };
}

describe("heartbeat — the three §3.6.11 liveness thresholds are distinct", () => {
  it("ping interval (3s), presence-stale (8s), and session-inactive (10min) are three different constants", () => {
    expect(PING_INTERVAL_MS).toBe(3_000);
    expect(PRESENCE_STALE_MS).toBe(8_000);
    expect(PING_INTERVAL_MS).not.toBe(PRESENCE_STALE_MS);
  });
});

describe("heartbeat — presence staleness (API Spec §3.6.11)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("missing pings for 9 seconds marks the session stale (logged)", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const session = fakeSession();

    armPresenceStaleTimer(session);
    expect(session.presenceStale).toBe(false);

    vi.advanceTimersByTime(9_000);

    expect(session.presenceStale).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      "presence.stale",
      expect.objectContaining({ sessionId: session.sessionId, replicaId: session.replicaId }),
    );
  });

  it("does NOT mark stale before the 8-second threshold", () => {
    const session = fakeSession();
    armPresenceStaleTimer(session);

    vi.advanceTimersByTime(7_999);
    expect(session.presenceStale).toBe(false);

    vi.advanceTimersByTime(2); // crosses 8,000ms
    expect(session.presenceStale).toBe(true);
  });

  it("a PING before the threshold resets the timer — no staleness, and stale->fresh logs a transition", () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const session = fakeSession();
    armPresenceStaleTimer(session);

    vi.advanceTimersByTime(7_000);
    onPingReceived(session); // resets the 8s window
    expect(session.presenceStale).toBe(false);

    vi.advanceTimersByTime(7_000); // 14s of wall time total, but only 7s since the last ping
    expect(session.presenceStale).toBe(false);

    vi.advanceTimersByTime(1_500); // now 8.5s since the last ping
    expect(session.presenceStale).toBe(true);

    onPingReceived(session); // recovers
    expect(session.presenceStale).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith(
      "presence.fresh",
      expect.objectContaining({ sessionId: session.sessionId }),
    );
  });

  it("disarmPresenceStaleTimer prevents a pending timer from ever firing", () => {
    const session = fakeSession();
    armPresenceStaleTimer(session);
    disarmPresenceStaleTimer(session);

    vi.advanceTimersByTime(60_000);
    expect(session.presenceStale).toBe(false);
    expect(session.staleTimer).toBeUndefined();
  });

  it("heartbeat keeps a connection's presence fresh across 5 minutes of pings at the 3-second client interval", () => {
    const session = fakeSession();
    armPresenceStaleTimer(session);

    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    let elapsed = 0;
    while (elapsed < FIVE_MINUTES_MS) {
      vi.advanceTimersByTime(PING_INTERVAL_MS);
      elapsed += PING_INTERVAL_MS;
      onPingReceived(session);
      expect(session.presenceStale).toBe(false);
    }

    expect(elapsed).toBeGreaterThanOrEqual(FIVE_MINUTES_MS);
    expect(session.presenceStale).toBe(false);
  });
});
