// Phase 24 — the client-side integration proof for RC-30's OWN cap/warning
// half (API Spec §5.5/§10.5; PRD FR-OF-7). Uses the same "real
// createCollabServer + real SyncClient over the real global WebSocket"
// pattern Phase 23's reconnection.test.ts already established, and the
// same D-is-a-labeled-dimension methodology: nothing here waits a literal
// 8/10 real minutes — the op-count half of the cap is what a fast test
// loop can reach deterministically. RC-31's own literal "boundary tested
// from both sides" requirement is satisfied deterministically, at both the
// op-count AND wall-clock thresholds, in offlineWindow.test.ts instead
// (OfflineWindowTracker's own direct, clock-injectable unit tests) — that
// is the RIGHT place for a boundary proof, not a real-network integration
// test.
//
// A GENUINE FINDING, recorded here rather than glossed over: RC-30's OWN
// SECOND half ("operations whose anchors were collected are rejected with
// offline_window_exceeded") turns out NOT to be reachable through this
// project's OWN real SyncClient reconciliation flow at all, by design —
// found while building this very test, not assumed in advance. Traced by
// hand: `reconcileOfflineQueue.ts`'s `visibleIndexAfter`/
// `visibleIndexOfTarget` (Phase 22) always resolve a queued operation's
// anchor against the reconnecting client's OWN CURRENT structure at
// reconcile time — and CATCHUP (Phase 23) always delivers the delete that
// would have tombstoned a since-collected node's own visibility BEFORE
// reconciliation ever runs (handshakeGate's own serialization order). So
// by the time `reconcileOfflineQueue` resolves an anchor, either (a) the
// node is tombstoned-but-still-structurally-present (CATCHUP case) —
// `visibleIndexAfter` correctly computes visible position 0 there,
// producing a brand-new operation anchored to `null` (document-relative,
// not identifier-specific) rather than the vanished node's own identity —
// or (b) the node is entirely absent (a fresh SNAPSHOT, built from the
// server's CURRENT, already-GC'd structure) — `visibleIndexAfter`'s own
// documented fallback (`idx === -1` -> position 0) applies the same way.
// Either path produces a NEW operation that can always integrate
// immediately; NEITHER ever reaches the server still naming a specific,
// now-collected identifier. This is Phase 22's own graceful-degradation
// design working exactly as documented (`visibleIndexAfter`'s own doc
// comment already flagged the `idx === -1` branch as "a defensible,
// disclosed fallback" for "the remote theoretical case") — just not
// previously connected to Rule 7.2's own "collected anchor" scenario
// until this phase actually tried to construct it end to end.
//
// This does NOT make Phase 24's server-side offline-window sweep
// (offlineWindowScheduler.ts) unnecessary or untested — it is Rule 7.2's
// own explicit requirement (Engine Spec §7.6) regardless of whether THIS
// project's own client happens to avoid triggering it today, it is the
// correct backstop for any OTHER client (a different implementation, a
// genuinely slow/reordered network delivery, a future design change to
// reconciliation), and it is rigorously proven end to end, both at the
// server's own internal-mechanism level (offlineWindowScheduler.test.ts,
// directly against `engine.pending`) and via the real wire protocol
// (gateway.test.ts's own "a raw client operation naming a since-collected
// origin" test, which does not go through SyncClient's own
// already-safe reconciliation logic).

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCollabServer, InMemoryOperationStore, type CollabServer, type OperationStore } from "@collab-editor/server";
import { waitForState } from "./headlessHarness.js";
import { OFFLINE_CAP_OPS, OFFLINE_WARN_OPS, OfflineWindowExceededError } from "./offlineWindow.js";
import { SyncClient } from "./syncClient.js";

let server: CollabServer;
let operationStore: OperationStore;
let port: number;

beforeAll(async () => {
  operationStore = new InMemoryOperationStore();
  server = createCollabServer({ operationStore });
  port = await server.listen(0);
});

afterAll(async () => {
  await server.close();
});

const liveClients: SyncClient[] = [];
afterEach(() => {
  for (const client of liveClients) {
    client.disconnect();
  }
  liveClients.length = 0;
});

function wsUrl(): string {
  return `ws://127.0.0.1:${port}/v1/rt`;
}

function makeClient(documentId: string): SyncClient {
  const client = new SyncClient({ url: wsUrl(), documentId });
  liveClients.push(client);
  return client;
}

describe("RC-30a — the offline-window cap, against a real reconnected-then-disconnected SyncClient", () => {
  it("warns at 1,600 ops, caps at exactly 2,000, stops accepting further edits, and still offers a full export of everything accepted", async () => {
    const documentId = randomUUID();
    const clientA = makeClient(documentId);
    clientA.connect();
    await waitForState(clientA, "synced");

    clientA.disconnect(); // arms the offline window
    await waitForState(clientA, "offline");

    let acceptedChars = "";
    for (let i = 0; i < OFFLINE_CAP_OPS; i++) {
      clientA.localInsert(acceptedChars.length, 0x61 + (i % 26));
      acceptedChars += String.fromCharCode(0x61 + (i % 26));
      if (i === OFFLINE_WARN_OPS - 1) {
        // The 1,600th op was JUST accepted -- the first warning must be live now.
        expect(clientA.offlineWindowStatus.value.level).toBe("warn");
      }
    }

    expect(clientA.unackedCount).toBe(OFFLINE_CAP_OPS); // "stopped accepting... AT the bound" -- exactly 2,000 made it into the durable queue, no more
    expect(clientA.offlineWindowStatus.value.level).toBe("capped");
    expect(clientA.exportLocalText()).toBe(acceptedChars); // API Spec §5.5 step 4 -- export offered, and correct

    expect(() => clientA.localInsert(acceptedChars.length, 0x7a)).toThrow(
      OfflineWindowExceededError,
    );
    expect(clientA.unackedCount).toBe(OFFLINE_CAP_OPS); // the 2,001st really never made it in
    expect(clientA.engine).not.toBeNull(); // no silent reload/destroy
  });
});
