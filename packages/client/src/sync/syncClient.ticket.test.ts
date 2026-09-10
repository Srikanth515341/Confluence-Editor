// Phase 29 — WebSocket admission tickets and live revocation (API Spec §1.5, §4.10, §3.6.9).
// Fully synchronous FakeWebSocket-driven tests, the same pattern syncClient.test.ts already
// established — real ticket-issuance/real-server coverage lives in db/tickets.db.test.ts
// (`pnpm test:db`); this file is scoped to what's provable with a fake ticket source and no
// real HTTP/Postgres involved: `fetchTicket` is actually called and its result actually reaches
// HELLO's own `ticket` field, a failed fetch degrades gracefully, and the client-side
// write-blocking behavior (`NoWriteAccessError`, Scope-IN's "stop sending") reacts correctly to
// both a plain downgrade (role: VIEWER) and a full revocation (role: null).

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeControlFrame,
  encodeControlFrame,
  encodeStructureSnapshotBody,
  SessionRole,
  SnapshotForm,
  SyncMode,
  type ControlMessage,
  type HelloMessage,
  type WelcomeMessage,
} from "@collab-editor/protocol";
import { NoWriteAccessError, SyncClient, type SyncClientOptions, type WebSocketLike } from "./syncClient.js";

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
    if (this.closed) return;
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

/** `openSocket()`'s ticket-fetch path is a `.then().catch().finally()` chain — several real microtask hops even for an already-resolved promise. Awaits enough ticks for that whole chain to settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

function welcomeFrame(replicaId: number, role: SessionRole = SessionRole.EDITOR): Uint8Array {
  const msg: WelcomeMessage = {
    kind: "welcome",
    sessionId: randomUUID(),
    replicaId,
    role,
    serverSeq: 0,
    syncMode: SyncMode.SNAPSHOT,
    participants: [],
  };
  return encodeControlFrame(msg);
}

function snapshotFrame(): Uint8Array {
  return encodeControlFrame({
    kind: "snapshot",
    seq: 0,
    form: SnapshotForm.STRUCTURE,
    body: encodeStructureSnapshotBody([]),
  });
}

function alreadyHaveFrame(): Uint8Array {
  return encodeControlFrame({ kind: "alreadyHave", alreadyHave: [] });
}

/** Drives one client through a full fresh handshake to `"synced"`, on the given (already `onopen`-triggered) socket. */
async function completeHandshake(ws: FakeWebSocket, replicaId = 1, role = SessionRole.EDITOR): Promise<void> {
  ws.triggerMessage(welcomeFrame(replicaId, role));
  ws.triggerMessage(snapshotFrame());
  ws.triggerMessage(alreadyHaveFrame());
  await Promise.resolve();
  await Promise.resolve();
}

describe("SyncClient — Phase 29 ticket fetching (API Spec §4.10)", () => {
  let sockets: FakeWebSocket[];

  beforeEach(() => {
    sockets = [];
  });

  function makeClient(fetchTicket: NonNullable<SyncClientOptions["fetchTicket"]>): SyncClient {
    return new SyncClient({
      url: "ws://fake",
      documentId: randomUUID(),
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
      fetchTicket,
    });
  }

  it("fetches a ticket before opening the socket, and HELLO carries its UTF-8 bytes", async () => {
    const client = makeClient(() => Promise.resolve({ ticket: "rt_abc123" }));
    client.connect();
    // fetchTicket is async (a real implementation is a real HTTP call) — even a resolved
    // promise defers by a microtask, so the socket isn't created synchronously here.
    expect(sockets).toHaveLength(0);
    await flushMicrotasks();
    expect(sockets).toHaveLength(1);

    sockets[0]!.triggerOpen();
    const hello = decodeLastControlSent(sockets[0]!) as HelloMessage;
    expect(hello.kind).toBe("hello");
    expect(new TextDecoder().decode(hello.ticket)).toBe("rt_abc123");
  });

  it("a failed/rejected ticket fetch still opens the socket, with an EMPTY ticket — no separate retry path, the server's own ERROR+close and this client's existing reconnect machinery handle it", async () => {
    const client = makeClient(() => Promise.reject(new Error("network error")));
    client.connect();
    await flushMicrotasks();
    expect(sockets).toHaveLength(1);

    sockets[0]!.triggerOpen();
    const hello = decodeLastControlSent(sockets[0]!) as HelloMessage;
    expect(hello.ticket).toHaveLength(0);
  });

  it("a reconnect fetches a FRESH ticket (single-use — never reuses the previous attempt's)", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const client = makeClient(() => Promise.resolve({ ticket: `rt_ticket-${++call}` }));
      client.connect();
      await flushMicrotasks();
      sockets[0]!.triggerOpen();
      expect(
        new TextDecoder().decode((decodeLastControlSent(sockets[0]!) as HelloMessage).ticket),
      ).toBe("rt_ticket-1");

      // A real reconnect (abnormal close) — the SAME `openSocket()` entry point, so it must
      // fetch again, not reuse `currentTicket` from the first attempt. The reconnect itself is
      // scheduled behind a real backoff timer (Backoff/scheduleReconnect), hence fake timers.
      sockets[0]!.close(1006, "");
      await vi.advanceTimersByTimeAsync(35_000); // well past the (capped) backoff delay
      await flushMicrotasks();
      expect(sockets).toHaveLength(2);
      sockets[1]!.triggerOpen();
      expect(
        new TextDecoder().decode((decodeLastControlSent(sockets[1]!) as HelloMessage).ticket),
      ).toBe("rt_ticket-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("with no fetchTicket configured, HELLO carries an empty ticket and the socket opens perfectly synchronously (byte-for-byte the original Phase 8-28 behavior)", () => {
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
    expect(sockets).toHaveLength(1); // synchronous, no microtask needed
    sockets[0]!.triggerOpen();
    const hello = decodeLastControlSent(sockets[0]!) as HelloMessage;
    expect(hello.ticket).toHaveLength(0);
  });
});

describe("SyncClient — Phase 29 client-side write-blocking on downgrade/revocation (Scope-IN: 'stop sending')", () => {
  let sockets: FakeWebSocket[];
  let client: SyncClient;

  beforeEach(() => {
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

  it("a VIEWER role (from WELCOME) refuses localInsert with NoWriteAccessError, without ever touching the engine", async () => {
    client.connect();
    sockets[0]!.triggerOpen();
    await completeHandshake(sockets[0]!, 1, SessionRole.VIEWER);
    expect(client.role.value).toBe(SessionRole.VIEWER);

    expect(() => client.localInsert(0, 0x61)).toThrow(NoWriteAccessError);
    expect(client.engine?.text()).toBe("");
  });

  it("PERMISSION_CHANGED{role: null} (full revocation) also refuses new writes, even though role itself reads as null rather than VIEWER", async () => {
    client.connect();
    sockets[0]!.triggerOpen();
    await completeHandshake(sockets[0]!, 1, SessionRole.EDITOR);
    client.localInsert(0, 0x61); // succeeds while still an editor
    expect(client.engine?.text()).toBe("a");

    sockets[0]!.triggerMessage(
      encodeControlFrame({ kind: "permissionChanged", role: null, effectiveAtSeq: 1 }),
    );
    expect(client.role.value).toBeNull();
    expect(() => client.localInsert(1, 0x62)).toThrow(NoWriteAccessError);
    expect(client.engine?.text()).toBe("a"); // "b" never minted
  });

  it("a later grant (PERMISSION_CHANGED carrying a real role) re-enables writes after a revocation", async () => {
    client.connect();
    sockets[0]!.triggerOpen();
    await completeHandshake(sockets[0]!, 1, SessionRole.EDITOR);

    sockets[0]!.triggerMessage(
      encodeControlFrame({ kind: "permissionChanged", role: null, effectiveAtSeq: 1 }),
    );
    expect(() => client.localInsert(0, 0x61)).toThrow(NoWriteAccessError);

    sockets[0]!.triggerMessage(
      encodeControlFrame({ kind: "permissionChanged", role: SessionRole.EDITOR, effectiveAtSeq: 2 }),
    );
    expect(() => client.localInsert(0, 0x61)).not.toThrow();
    expect(client.engine?.text()).toBe("a");
  });
});
