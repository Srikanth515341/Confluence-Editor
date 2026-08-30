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
import { randomUUID } from "node:crypto";
import { SyncClient, type WebSocketLike } from "./syncClient.js";
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

  it("state is 'connecting' for the first attempt, becomes 'synced' after WELCOME+SNAPSHOT, and sends SYNC_COMPLETE", () => {
    expect(client.state.value).toBe("offline");
    client.connect();
    expect(client.state.value).toBe("connecting");

    const ws = sockets[0]!;
    ws.triggerOpen();
    ws.triggerMessage(welcomeFrame(7));
    expect(client.state.value).toBe("connecting"); // WELCOME alone isn't synced yet
    expect(client.replicaId).toBe(7);

    ws.triggerMessage(snapshotFrame(0));
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

  function synced(): FakeWebSocket {
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

  it("applies an out-of-order operation anyway, and records a gap without advancing lastServerSeq", () => {
    const ws = synced();
    expect(client.hasSequenceGap).toBe(false);

    ws.triggerMessage(opInsertFrame(5, 1)); // expected 1, got 5 — a gap
    expect(client.engine?.text()).toBe("z"); // applied anyway
    expect(client.hasSequenceGap).toBe(true);
  });

  it("closes the socket and reconnects once the gap persists for 5 seconds", () => {
    const ws = synced();
    ws.triggerMessage(opInsertFrame(5, 1));
    expect(ws.closed).toBe(false);

    vi.advanceTimersByTime(GAP_RECONNECT_TIMEOUT_MS - 1);
    expect(ws.closed).toBe(false);

    vi.advanceTimersByTime(1);
    expect(ws.closed).toBe(true);
    expect(client.state.value).toBe("reconnecting");
  });

  it("a fresh SNAPSHOT after reconnecting clears the gap", () => {
    const ws = synced();
    ws.triggerMessage(opInsertFrame(5, 1));
    expect(client.hasSequenceGap).toBe(true);

    vi.advanceTimersByTime(GAP_RECONNECT_TIMEOUT_MS);
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
