// Phase 24 — direct, deterministic unit tests of OfflineWindowTracker (API
// Spec §5.5/§10.5, Test Plan RC-30/RC-31). No real or fake timers, no
// SyncClient, no network: every threshold check here is driven by an
// explicit `nowMs` value, exactly the same "clock-injectable pure class"
// split Phase 21's GC safety cap established (engine.ts's `collect()`
// tests) — this is what makes RC-31's own literal requirement ("the
// boundary must be tested from both sides") checkable with exact,
// reproducible values instead of a real or fake 9-minute-50-second wait.

import { describe, expect, it } from "vitest";
import {
  OFFLINE_CAP_MS,
  OFFLINE_CAP_OPS,
  OFFLINE_WARN_MS,
  OFFLINE_WARN_OPS,
  OfflineWindowTracker,
} from "./offlineWindow.js";

describe("OfflineWindowTracker — basic arming/disarming", () => {
  it("canAccept() is always true while never armed (fully synced, noteNotSynced never called)", () => {
    const tracker = new OfflineWindowTracker();
    expect(tracker.canAccept(0)).toBe(true);
    expect(tracker.status(0)).toEqual({ level: "none", elapsedMs: 0, opsCount: 0 });
  });

  it("noteSynced() disarms the window — a client that resyncs gets a fresh window on its NEXT disconnect", () => {
    const tracker = new OfflineWindowTracker();
    tracker.noteNotSynced(0);
    for (let i = 0; i < 100; i++) {
      tracker.noteOperationAccepted();
    }
    tracker.noteSynced();
    expect(tracker.status(1_000_000)).toEqual({ level: "none", elapsedMs: 0, opsCount: 0 });
    // Re-arming after noteSynced() starts a brand-new window, not a continuation of the old one.
    tracker.noteNotSynced(1_000_000);
    expect(tracker.status(1_000_010)).toEqual({ level: "none", elapsedMs: 10, opsCount: 0 });
  });

  it("noteNotSynced() is idempotent — calling it again while already armed does not reset the clock or the count", () => {
    const tracker = new OfflineWindowTracker();
    tracker.noteNotSynced(1_000);
    tracker.noteOperationAccepted();
    tracker.noteOperationAccepted();
    tracker.noteNotSynced(5_000); // e.g. a second dropped-connection event while still offline
    expect(tracker.status(6_000)).toEqual({ level: "none", elapsedMs: 5_000, opsCount: 2 }); // elapsed from 1_000, not 5_000
  });
});

describe("OfflineWindowTracker — the two warning thresholds (RC-30)", () => {
  it("reaches 'warn' at exactly 1,600 accepted ops, before the 8-minute mark", () => {
    const tracker = new OfflineWindowTracker();
    tracker.noteNotSynced(0);
    for (let i = 0; i < OFFLINE_WARN_OPS - 1; i++) {
      tracker.noteOperationAccepted();
    }
    expect(tracker.status(1_000).level).toBe("none"); // 1,599 — not yet
    tracker.noteOperationAccepted();
    expect(tracker.status(1_000).level).toBe("warn"); // 1,600 — the first warning
  });

  it("reaches 'warn' at exactly the 8-minute mark, with zero ops", () => {
    const tracker = new OfflineWindowTracker();
    tracker.noteNotSynced(0);
    expect(tracker.status(OFFLINE_WARN_MS - 1).level).toBe("none");
    expect(tracker.status(OFFLINE_WARN_MS).level).toBe("warn");
  });

  it("reaches 'capped' at exactly 2,000 accepted ops, before the 10-minute mark", () => {
    const tracker = new OfflineWindowTracker();
    tracker.noteNotSynced(0);
    for (let i = 0; i < OFFLINE_CAP_OPS - 1; i++) {
      tracker.noteOperationAccepted();
    }
    expect(tracker.status(1_000).level).toBe("warn"); // 1,999 — already past warn, not yet capped
    tracker.noteOperationAccepted();
    expect(tracker.status(1_000).level).toBe("capped"); // 2,000 — the second warning / hard bound
  });

  it("reaches 'capped' at exactly the 10-minute mark, with zero ops", () => {
    const tracker = new OfflineWindowTracker();
    tracker.noteNotSynced(0);
    expect(tracker.status(OFFLINE_CAP_MS - 1).level).toBe("warn"); // past the 8-minute warn, not yet capped
    expect(tracker.status(OFFLINE_CAP_MS).level).toBe("capped");
  });
});

describe("OfflineWindowTracker — canAccept() cap boundary, from BOTH sides (RC-31)", () => {
  it("op-count boundary: op #2,000 is accepted, op #2,001 is refused — tested at 1,999/2,000/2,001", () => {
    const tracker = new OfflineWindowTracker();
    tracker.noteNotSynced(0);
    const nowMs = 1_000; // well under the time-based cap — isolates the op-count boundary alone
    for (let i = 0; i < OFFLINE_CAP_OPS - 1; i++) {
      expect(tracker.canAccept(nowMs)).toBe(true); // ops 1..1,999 all accepted
      tracker.noteOperationAccepted();
    }
    // 1,999 accepted so far — the 2,000th (the LAST one still inside the cap) must still be accepted.
    expect(tracker.canAccept(nowMs)).toBe(true);
    tracker.noteOperationAccepted(); // now 2,000 accepted
    // The 2,001st must be refused — the cap is "at the bound," not "one past it."
    expect(tracker.canAccept(nowMs)).toBe(false);
  });

  it("time boundary: RC-31's literal D=9min50s/L=1,950 is accepted; D=10min/L=1,950 is refused", () => {
    const tracker = new OfflineWindowTracker();
    tracker.noteNotSynced(0);
    for (let i = 0; i < 1_950; i++) {
      tracker.noteOperationAccepted();
    }
    const nineMin50s = 9 * 60 * 1000 + 50 * 1000;
    expect(nineMin50s).toBe(590_000);
    expect(tracker.canAccept(nineMin50s)).toBe(true); // RC-31's own scenario: NOT rejected
    expect(tracker.canAccept(OFFLINE_CAP_MS - 1)).toBe(true); // one ms before the bound
    expect(tracker.canAccept(OFFLINE_CAP_MS)).toBe(false); // exactly at the bound
    expect(tracker.canAccept(OFFLINE_CAP_MS + 1)).toBe(false); // one ms past it
  });

  it("either bound alone is sufficient to cap — reaching the op-count cap refuses even at time 0", () => {
    const tracker = new OfflineWindowTracker();
    tracker.noteNotSynced(0);
    for (let i = 0; i < OFFLINE_CAP_OPS; i++) {
      tracker.noteOperationAccepted();
    }
    expect(tracker.canAccept(0)).toBe(false);
  });

  it("either bound alone is sufficient to cap — reaching the time cap refuses even with 0 ops", () => {
    const tracker = new OfflineWindowTracker();
    tracker.noteNotSynced(0);
    expect(tracker.canAccept(OFFLINE_CAP_MS)).toBe(false);
  });
});
