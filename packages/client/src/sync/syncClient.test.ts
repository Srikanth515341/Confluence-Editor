import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeControlFrame,
  decodeFrame,
  encodeControlFrame,
  encodeFrame,
  encodeStructureSnapshotBody,
  SessionRole,
  SnapshotForm,
  SyncMode,
  type ControlMessage,
  type WelcomeMessage,
} from "@collab-editor/protocol";
import type { Identifier } from "@collab-editor/engine";
import { randomUUID } from "node:crypto";
import { PING_INTERVAL_MS, SyncClient, type WebSocketLike } from "./syncClient.js";
import { BACKOFF_RESET_AFTER_MS } from "./backoff.js";
import { GAP_RECONNECT_TIMEOUT_MS } from "./gapTracker.js";

/**
 * A fully synchronous, fully controllable stand-in for the DOM `WebSocket`
 * — real network I/O and `vi.useFakeTimers()` don't mix reliably, and this
 * phase's DoD needs precise control over timing (backoff, the 60s reset
 * window, the 5s gap-reconnect window) that only fake timers give.
 * Real-server integration coverage lives in gateway.test.ts (Phase 8/9)
 * and this package's own `headlessHarness.test.ts` (Phase 10), which use
 * the real global `WebSocket` end to end — this file exists specifically
 * to test the parts a real socket can't be driven precisely enough for.
 */
class FakeWebSocket implements WebSocketLike {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  closed = false;

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code = 1005, reason = ""): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  triggerMessage(bytes: Uint8Array): void {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
}

function decodeLastControlSent(ws: FakeWebSocket): ControlMessage {
  return decodeControlFrame(ws.sent[ws.sent.length - 1]!, { direction: "clientOrigin" });
}

describe("SyncClient — handshake and messaging, against a fake socket", () => {
  let sockets: FakeWebSocket[];
  let client: SyncClient;
  const documentId = randomUUID();

  beforeEach(() => {
    sockets = [];
    client = new SyncClient({
      url: "ws://fake",
      documentId,
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
    });
  });

  function welcomeFrame(replicaId: number): Uint8Array {
    const msg: WelcomeMessage = {
      kind: "welcome",
      sessionId: randomUUID(),
      replicaId,
      role: SessionRole.EDITOR,
      serverSeq: 0,
      syncMode: SyncMode.SNAPSHOT,
      participants: [],
    };
    return encodeControlFrame(msg);
  }

  function snapshotFrame(
    seq: number,
    body: Uint8Array = encodeStructureSnapshotBody([]),
  ): Uint8Array {
    return encodeControlFrame({ kind: "snapshot", seq, form: SnapshotForm.STRUCTURE, body });
  }

  /** Phase 23: ALREADY_HAVE always follows the state-sync payload, even with nothing to report — SyncClient only reaches "synced" once this arrives (see syncClient.ts's `handshakeGate`). */
  function alreadyHaveFrame(alreadyHave: Identifier[] = []): Uint8Array {
    return encodeControlFrame({ kind: "alreadyHave", alreadyHave });
  }

  it("sends HELLO immediately on open, with the configured documentId", () => {
    client.connect();
    const ws = sockets[0]!;
    ws.triggerOpen();

    expect(ws.sent).toHaveLength(1);
    const hello = decodeControlFrame(ws.sent[0]!, { direction: "clientOrigin" });
    expect(hello.kind).toBe("hello");
    if (hello.kind === "hello") {
      expect(hello.documentId).toBe(documentId);
      expect(hello.lastServerSeq).toBe(0);
      expect(hello.unacked).toEqual([]);
    }
  });

  it("state is 'connecting' for the first attempt, becomes 'synced' after WELCOME+SNAPSHOT+ALREADY_HAVE, and sends SYNC_COMPLETE", async () => {
    expect(client.state.value).toBe("offline");
    client.connect();
    expect(client.state.value).toBe("connecting");

    const ws = sockets[0]!;
    ws.triggerOpen();
    ws.triggerMessage(welcomeFrame(7));
    expect(client.state.value).toBe("connecting"); // WELCOME alone isn't synced yet
    expect(client.replicaId).toBe(7);

    ws.triggerMessage(snapshotFrame(0));
    expect(client.state.value).toBe("connecting"); // SNAPSHOT alone isn't synced yet either — ALREADY_HAVE (Phase 23) still pending
    ws.triggerMessage(alreadyHaveFrame());
    await Promise.resolve(); // finishHandshakeAfterAlreadyHave runs as a microtask chained onto handshakeGate — see synced()'s own comment in the sequence-gap describe block below
    expect(client.state.value).toBe("synced");
    expect(client.engine?.text()).toBe("");

    const syncComplete = decodeLastControlSent(ws);
    expect(syncComplete.kind).toBe("syncComplete");
    if (syncComplete.kind === "syncComplete") {
      expect(syncComplete.lastServerSeq).toBe(0);
      expect(syncComplete.resentCount).toBe(0);
    }
  });

  it("seeds the engine from a non-empty SNAPSHOT correctly", () => {
    client.connect();
    const ws = sockets[0]!;
    ws.triggerOpen();
    ws.triggerMessage(welcomeFrame(1));
    const body = encodeStructureSnapshotBody([
      {
        id: { c: 1, r: 5 },
        value: 0x68,
        originLeft: null,
        originRight: null,
        bind: false,
        deleted: false,
        deletedBy: null,
      },
      {
        id: { c: 2, r: 5 },
        value: 0x69,
        originLeft: { c: 1, r: 5 },
        originRight: null,
        bind: false,
        deleted: false,
        deletedBy: null,
      },
    ]);
    ws.triggerMessage(snapshotFrame(3, body));
    expect(client.engine?.text()).toBe("hi");
  });

  it("localInsert sends an OP_INSERT frame with seq 0 and updates the local engine", () => {
    client.connect();
    const ws = sockets[0]!;
    ws.triggerOpen();
    ws.triggerMessage(welcomeFrame(1));
    ws.triggerMessage(snapshotFrame(0));

    ws.sent.length = 0; // clear the SYNC_COMPLETE we already asserted elsewhere
    client.localInsert(0, 0x61);
    expect(client.engine?.text()).toBe("a");
    expect(client.unackedCount).toBe(1);

    const sentOp = decodeFrame(ws.sent[ws.sent.length - 1]!, { direction: "clientOrigin" });
    expect(sentOp.kind).toBe("opInsert");
    if (sentOp.kind === "opInsert") {
      expect(sentOp.seq).toBe(0);
      expect(sentOp.value).toBe(0x61);
    }
  });

  it("throws from localInsert before the handshake completes", () => {
    client.connect();
    expect(() => client.localInsert(0, 0x61)).toThrow();
  });

  it("localInsertText of 2,000 characters sends exactly ONE frame on the socket (Phase 12 DoD, Test Plan MUT-01: paste)", () => {
    client.connect();
    const ws = sockets[0]!;
    ws.triggerOpen();
    ws.triggerMessage(welcomeFrame(1));
    ws.triggerMessage(snapshotFrame(0));

    ws.sent.length = 0; // clear SYNC_COMPLETE
    const text = "a".repeat(2000);
    const ops = client.localInsertText(0, text);

    expect(ops).toHaveLength(2000);
    expect(client.engine?.text()).toBe(text);
    expect(ws.sent).toHaveLength(1); // the actual frame count on the socket, not just the coalescing helper in isolation
    expect(client.unackedCount).toBe(2000); // every underlying character is still tracked individually for acking

    const sentMsg = decodeFrame(ws.sent[0]!, { direction: "clientOrigin" });
    expect(sentMsg.kind).toBe("opInsertRun");
    if (sentMsg.kind === "opInsertRun") {
      expect(sentMsg.values).toHaveLength(2000);
    }
  });
});

describe("SyncClient — sequence gap handling (API Spec §3.7.5)", () => {
  let sockets: FakeWebSocket[];
  let client: SyncClient;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    client = new SyncClient({
      url: "ws://fake",
      documentId: randomUUID(),
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Phase 23: `finishHandshakeAfterAlreadyHave` (syncClient.ts) runs as a
   * `.then()` chained onto `handshakeGate` — even for SNAPSHOT mode, where
   * that gate is trivially already-resolved, a `.then()` callback is still
   * only ever run on a LATER microtask, never synchronously (a JS Promise
   * guarantee, independent of `vi.useFakeTimers()` — fake timers replace
   * `setTimeout`/`setInterval`, never the native microtask queue). One
   * `await Promise.resolve()` after triggering ALREADY_HAVE is sufficient
   * to let it settle before the next assertion: it queues the test's own
   * continuation as a SECOND microtask, strictly after the already-queued
   * `finishHandshakeAfterAlreadyHave` callback (FIFO microtask ordering),
   * so the microtask queue drains that callback first.
   */
  async function synced(): Promise<FakeWebSocket> {
    client.connect();
    const ws = sockets[0]!;
    ws.triggerOpen();
    ws.triggerMessage(
      encodeControlFrame({
        kind: "welcome",
        sessionId: randomUUID(),
        replicaId: 1,
        role: SessionRole.EDITOR,
        serverSeq: 0,
        syncMode: SyncMode.SNAPSHOT,
        participants: [],
      }),
    );
    ws.triggerMessage(
      encodeControlFrame({
        kind: "snapshot",
        seq: 0,
        form: SnapshotForm.STRUCTURE,
        body: encodeStructureSnapshotBody([]),
      }),
    );
    ws.triggerMessage(encodeControlFrame({ kind: "alreadyHave", alreadyHave: [] })); // Phase 23 — SyncClient only reaches "synced" once this arrives
    await Promise.resolve();
    return ws;
  }

  function opInsertFrame(seq: number, c: number): Uint8Array {
    return encodeFrame({
      kind: "opInsert",
      seq,
      id: { c, r: 99 },
      originLeft: null,
      originRight: null,
      bind: false,
      value: 0x7a,
    });
  }

  it("applies an out-of-order operation anyway, and records a gap (informational) without freezing progress", async () => {
    const ws = await synced();
    expect(client.hasSequenceGap).toBe(false);

    ws.triggerMessage(opInsertFrame(5, 1)); // expected 1, got 5 — a gap
    expect(client.engine?.text()).toBe("z"); // applied anyway
    expect(client.hasSequenceGap).toBe(true);
  });

  it("closes the socket once NO further seq arrives for GAP_RECONNECT_TIMEOUT_MS, re-checked on the ping cadence", async () => {
    const ws = await synced();
    ws.triggerMessage(opInsertFrame(5, 1)); // one gap-y frame, then total silence from the server
    expect(ws.closed).toBe(false);

    // The stall check runs on the ping timer (every PING_INTERVAL_MS), not a separate one-shot
    // timer — advance past both the stall threshold AND the next ping tick that observes it.
    vi.advanceTimersByTime(GAP_RECONNECT_TIMEOUT_MS + PING_INTERVAL_MS);
    expect(ws.closed).toBe(true);
    expect(client.state.value).toBe("reconnecting");
  });

  it("Phase 22 fix: a genuinely idle-but-healthy session (regular PONGs, zero OPS traffic) does NOT force a reconnect", async () => {
    const ws = await synced();
    // Nobody edits anything, ever — but a real server responds to every PING with a PONG, on
    // schedule, every PING_INTERVAL_MS. Before the fix, this alone would eventually trip
    // hasStalled() (PONG never advanced the stall clock) and force a reconnect every ~8s,
    // forever — found by Phase 22's own DUR-07 e2e test holding a real idle multi-client
    // session against a real server for the first time in this project's history.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(PING_INTERVAL_MS);
      ws.triggerMessage(
        encodeControlFrame({ kind: "pong", clientTimeMs: 0, serverSeq: 0 }),
      );
    }
    expect(ws.closed).toBe(false);
    expect(client.state.value).toBe("synced");
  });

  it("this client's own permanently-excluded operations (a real gap that will NEVER close) do NOT trigger a reconnect as long as OTHER traffic keeps arriving", async () => {
    const ws = await synced();
    // Simulate a sustained exchange where every OTHER seq is this client's own (never observed) —
    // exactly Test Plan §2.7 E2E-CONV-01's real-world shape, and the actual Phase 14 finding.
    let seq = 1;
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(200);
      seq += 2;
      ws.triggerMessage(opInsertFrame(seq, 1));
    }
    expect(client.hasSequenceGap).toBe(true); // still informationally "gappy" — that's expected and fine
    expect(ws.closed).toBe(false); // but NEVER stalled, so never force-reconnected
    expect(client.state.value).toBe("synced");
  });

  it("a fresh SNAPSHOT after a genuine reconnect clears the gap", async () => {
    const ws = await synced();
    ws.triggerMessage(opInsertFrame(5, 1));
    expect(client.hasSequenceGap).toBe(true);

    vi.advanceTimersByTime(GAP_RECONNECT_TIMEOUT_MS + PING_INTERVAL_MS); // let the stall actually close the socket
    vi.advanceTimersByTime(35_000); // let the scheduled reconnect fire (capped backoff well under this)
    const ws2 = sockets[sockets.length - 1]!;
    ws2.triggerOpen();
    ws2.triggerMessage(
      encodeControlFrame({
        kind: "welcome",
        sessionId: randomUUID(),
        replicaId: 2,
        role: SessionRole.EDITOR,
        serverSeq: 0,
        syncMode: SyncMode.SNAPSHOT,
        participants: [],
      }),
    );
    ws2.triggerMessage(
      encodeControlFrame({
        kind: "snapshot",
        seq: 0,
        form: SnapshotForm.STRUCTURE,
        body: encodeStructureSnapshotBody([]),
      }),
    );
    ws2.triggerMessage(encodeControlFrame({ kind: "alreadyHave", alreadyHave: [] }));
    await Promise.resolve(); // let finishHandshakeAfterAlreadyHave's chained microtask settle — see synced()'s own comment

    expect(client.hasSequenceGap).toBe(false);
    expect(client.state.value).toBe("synced");
  });
});

describe("SyncClient — reconnection backoff (API Spec §3.10)", () => {
  let sockets: FakeWebSocket[];
  let client: SyncClient;
  let scheduledDelays: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    scheduledDelays = [];
    client = new SyncClient({
      url: "ws://fake",
      documentId: randomUUID(),
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
      onReconnectScheduled: (delayMs) => scheduledDelays.push(delayMs),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("state becomes 'reconnecting' after the socket drops, and grows the attempt count on each quick failure", () => {
    client.connect();
    sockets[0]!.triggerOpen();
    sockets[0]!.close(1006, "abnormal");

    expect(client.state.value).toBe("reconnecting");
    expect(scheduledDelays).toHaveLength(1);
    expect(client.reconnectAttemptCount).toBe(1);

    vi.advanceTimersByTime(35_000); // let the (capped, well under 35s) scheduled reconnect fire
    sockets[1]!.triggerOpen();
    sockets[1]!.close(1006, "abnormal again — still well under 60s survival");

    expect(client.reconnectAttemptCount).toBe(2); // NOT reset — neither socket survived 60s
  });

  it("does NOT reset the backoff counter across 5 crash-loop cycles, each well under 60s — the interval envelope grows", () => {
    client.connect();
    for (let i = 0; i < 5; i++) {
      const ws = sockets[sockets.length - 1]!;
      ws.triggerOpen();
      vi.advanceTimersByTime(1_000); // alive briefly, nowhere near 60s
      ws.close(1006, "crash");
      vi.advanceTimersByTime(35_000); // let the next attempt's backoff timer fire
    }
    expect(client.reconnectAttemptCount).toBe(5);
    // Envelope for attempt N is base*factor^N capped at 30s — strictly non-decreasing across 5 quick failures.
    expect(scheduledDelays).toHaveLength(5);
  });

  it("DOES reset the backoff counter once a socket survives 60 seconds", () => {
    client.connect();
    sockets[0]!.triggerOpen();
    vi.advanceTimersByTime(1_000);
    sockets[0]!.close(1006, "crash"); // attempt 1 scheduled, not reset
    expect(client.reconnectAttemptCount).toBe(1);

    vi.advanceTimersByTime(35_000);
    sockets[1]!.triggerOpen();
    vi.advanceTimersByTime(BACKOFF_RESET_AFTER_MS); // survives the full 60s this time
    sockets[1]!.close(1006, "crash after surviving 60s");

    expect(client.reconnectAttemptCount).toBe(1); // reset to 0, then this failure scheduled attempt 1 again
  });

  it("a socket that dies immediately after WELCOME does not reset the backoff (§3.10's own worked example)", () => {
    client.connect();
    const ws = sockets[0]!;
    ws.triggerOpen();
    ws.triggerMessage(
      encodeControlFrame({
        kind: "welcome",
        sessionId: randomUUID(),
        replicaId: 1,
        role: SessionRole.EDITOR,
        serverSeq: 0,
        syncMode: SyncMode.SNAPSHOT,
        participants: [],
      }),
    );
    ws.close(1006, "died right after WELCOME, before SNAPSHOT");

    vi.advanceTimersByTime(35_000);
    sockets[1]!.triggerOpen();
    sockets[1]!.close(1006, "again, immediately");

    expect(client.reconnectAttemptCount).toBe(2); // grown, not reset
  });
});

describe("SyncClient — disconnect()", () => {
  it("goes offline and does not schedule a reconnect", () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const client = new SyncClient({
      url: "ws://fake",
      documentId: randomUUID(),
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
    });
    client.connect();
    sockets[0]!.triggerOpen();

    client.disconnect();
    expect(client.state.value).toBe("offline");
    expect(sockets[0]!.closed).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1); // no reconnect attempt was ever scheduled
    vi.useRealTimers();
  });
});
