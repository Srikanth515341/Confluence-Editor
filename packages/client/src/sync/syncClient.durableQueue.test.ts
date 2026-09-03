// Phase 22 — SyncClient integration tests for the durable queue (API Spec
// §7.9; Test Plan §3.6 DUR-07/08/09). These simulate "a browser crash and
// restart" the way Test Plan DUR-07's own text sanctions for this phase
// ("the key behaviors under test are IndexedDB persistence and
// exactly-once delivery on reconnect, not the specific disconnection
// mechanism"): a SECOND, independent `SyncClient` instance is constructed
// sharing the SAME `fake-indexeddb` factory as the first — exactly what
// survives a real browser process crash (the on-disk IndexedDB database),
// without needing to actually kill a process. A real-browser version of
// DUR-07 (a real, on-disk Chromium profile, terminated and relaunched)
// lives in the e2e suite (packages/client/e2e/durableQueue.spec.ts, which
// this phase also adds) — see that file's own header comment for why its
// termination step is a graceful `context.close()`, not a literal
// SIGKILL (a real engine-level kill was investigated and found not
// achievable through any supported Playwright API for a persistent,
// reusable on-disk profile).

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  decodeControlFrame,
  encodeControlFrame,
  encodeStructureSnapshotBody,
  SessionRole,
  SnapshotForm,
  SyncMode,
  type ControlMessage,
  type HelloMessage,
} from "@collab-editor/protocol";
import { openDurableQueue } from "./durableQueue.js";
import { SyncClient, type WebSocketLike } from "./syncClient.js";

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

function welcomeFrame(replicaId: number): Uint8Array {
  return encodeControlFrame({
    kind: "welcome",
    sessionId: randomUUID(),
    replicaId,
    role: SessionRole.EDITOR,
    serverSeq: 0,
    syncMode: SyncMode.SNAPSHOT,
    participants: [],
  });
}

function snapshotFrame(seq: number): Uint8Array {
  return encodeControlFrame({
    kind: "snapshot",
    seq,
    form: SnapshotForm.STRUCTURE,
    body: encodeStructureSnapshotBody([]),
  });
}

/**
 * Polls until `sockets` gains a new entry. A single `setTimeout(0)` is not reliably enough —
 * `beginConnect()`'s async branch (`finishAsyncDurableInit`) chains through fake-indexeddb's
 * own multi-step open/transaction machinery before calling `openSocket()`, which can take more
 * than one macrotask tick to fully settle.
 */
async function waitForSocket(sockets: readonly unknown[], countBefore: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (sockets.length <= countBefore) {
    if (Date.now() >= deadline) {
      throw new Error("waitForSocket: timed out waiting for a new socket to be created");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function lastHello(ws: FakeWebSocket): HelloMessage {
  for (let i = ws.sent.length - 1; i >= 0; i--) {
    const msg: ControlMessage = decodeControlFrame(ws.sent[i]!, { direction: "clientOrigin" });
    if (msg.kind === "hello") {
      return msg;
    }
  }
  throw new Error("no HELLO frame found");
}

describe("SyncClient — durable queue integration (Phase 22, DUR-07)", () => {
  let factory: IDBFactory;
  let documentId: string;
  let sockets: FakeWebSocket[];
  let clients: SyncClient[];

  beforeEach(() => {
    factory = new IDBFactory();
    documentId = randomUUID();
    sockets = [];
    clients = [];
  });

  // A `wsX.close(...)` call anywhere in these tests simulates an ABNORMAL drop, which
  // (correctly, per SyncClient's own §3.10 behavior) arms a REAL automatic-reconnect
  // `setTimeout`. Found necessary the hard way (not anticipated in advance): a test that
  // severs a client and then simply moves on — never calling `disconnect()` — leaves that
  // timer armed past the end of the `it()` block. `makeClient`'s `createSocket` closure
  // captures the `sockets` VARIABLE, not a frozen array reference, and `beforeEach` REASSIGNS
  // that variable for the next test — so a stray reconnect firing late enough pushes an
  // unrelated socket into what the NEXT test believes is its own freshly-empty array,
  // corrupting `sockets[0]`/`sockets[socketsBefore]` there. Confirmed directly: an intermittent
  // failure under full-suite parallel load (never in isolation, where there's no "next test" to
  // pollute) showed `sockets.length === 2` immediately after the FIRST `waitForSocket` call in a
  // test that had only ever created one client — the second entry was a leftover from the
  // PRIOR test's own unclosed client. `afterEach` below disconnects every client this file's
  // own `makeClient()` ever created, which clears each one's pending reconnect timer
  // (`disconnect()`'s own `clearAllTimers()`), before the next test's `beforeEach` runs.
  afterEach(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  function makeClient(): SyncClient {
    const client = new SyncClient({
      url: "ws://fake",
      documentId,
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
      openDurableQueue: () => openDurableQueue(factory),
    });
    clients.push(client);
    return client;
  }

  it("200 offline-typed characters survive a simulated crash and restart, and all 200 are reported in the NEXT client's HELLO.unacked", async () => {
    const clientA = makeClient();
    clientA.connect();
    await waitForSocket(sockets, 0);
    const wsA = sockets[0]!;
    wsA.triggerOpen();
    wsA.triggerMessage(welcomeFrame(1));
    wsA.triggerMessage(snapshotFrame(0));
    expect(clientA.state.value).toBe("synced");

    // Sever the connection — the client keeps its engine (Phase 14's "last known state") and,
    // per Phase 22's relaxed requireEngine(), can keep minting local edits.
    wsA.close(1006, "severed at the proxy");
    expect(clientA.state.value).toBe("reconnecting");

    for (let i = 0; i < 200; i++) {
      clientA.localInsert(i, 0x61 + (i % 26));
    }
    expect(clientA.engine?.text()).toHaveLength(200);
    expect(clientA.unackedCount).toBe(200);

    // Force the durable queue's batched writes to commit (a real crash would lose whatever
    // hadn't flushed — DUR-08's own territory, tested separately below; this test is about
    // what a clean flush DOES preserve). Bracket-notation access to a private field is the
    // simplest way for a test to force a flush without adding a public SyncClient API no
    // production caller needs — TypeScript permits this (unlike dot-notation `clientA.durableQueue`).
    await clientA["durableQueue"]?.flush();

    // "Restart the browser": a brand-new SyncClient, sharing the SAME IndexedDB factory (what
    // actually survives a real process crash), never having seen clientA's in-memory state at
    // all.
    const socketsBefore = sockets.length;
    const clientB = makeClient();
    clientB.connect();
    await waitForSocket(sockets, socketsBefore);
    const wsB = sockets[sockets.length - 1]!;
    wsB.triggerOpen(); // HELLO is sent from onOpen() — must fire before inspecting what was sent

    const hello = lastHello(wsB);
    expect(hello.unacked).toHaveLength(200);

    wsB.triggerMessage(welcomeFrame(2)); // a brand-new replica id — no session resumption (Phase 8/9)
    wsB.triggerMessage(snapshotFrame(0)); // an empty snapshot — the old (dead) server's state, if any, is gone

    // ASSERT all 200 land in the final document, exactly once.
    expect(clientB.engine?.text()).toHaveLength(200);
    const expected = Array.from({ length: 200 }, (_, i) => String.fromCharCode(0x61 + (i % 26))).join("");
    expect(clientB.engine?.text()).toBe(expected);

    const syncComplete = decodeControlFrame(wsB.sent[wsB.sent.length - 1]!, {
      direction: "clientOrigin",
    });
    expect(syncComplete.kind).toBe("syncComplete");
    if (syncComplete.kind === "syncComplete") {
      expect(syncComplete.resentCount).toBe(200);
    }
  });

  it("DUR-08: operations never flushed before a simulated crash are genuinely absent — and the reported count matches what actually survived, never overstating it", async () => {
    const clientA = makeClient();
    clientA.connect();
    await waitForSocket(sockets, 0);
    const wsA = sockets[0]!;
    wsA.triggerOpen();
    wsA.triggerMessage(welcomeFrame(1));
    wsA.triggerMessage(snapshotFrame(0));
    wsA.close(1006, "severed");

    clientA.localInsert(0, 0x61); // typed, but the 200ms batching window is NEVER given a chance to flush
    expect(clientA.unackedCount).toBe(1); // the LIVE in-memory count still reports it — correct, nothing crashed YET

    // No flush() call here — this is the crash-inside-the-window scenario. Simulate the crash by
    // simply constructing a fresh client against the SAME factory without ever having flushed.
    const socketsBefore = sockets.length;
    const clientB = makeClient();
    clientB.connect();
    await waitForSocket(sockets, socketsBefore);
    const wsB = sockets[sockets.length - 1]!;
    wsB.triggerOpen(); // HELLO is sent from onOpen() — must fire before inspecting what was sent

    // The failure condition DUR-08 actually cares about: the restored count must not OVERSTATE
    // what survived. Since nothing was ever durably flushed, the correct, accurate count is 0 —
    // not 1. Losing the keystroke is accepted; claiming it was saved when it wasn't is not.
    const hello = lastHello(wsB);
    expect(hello.unacked).toHaveLength(0);

    wsB.triggerMessage(welcomeFrame(2));
    wsB.triggerMessage(snapshotFrame(0));
    expect(clientB.engine?.text()).toBe(""); // the un-flushed keystroke is genuinely gone, not silently duplicated or fabricated
    expect(clientB.unackedCount).toBe(0); // and the UI-facing count agrees — never overstating
  });
});

describe("SyncClient — IndexedDB unavailable (Phase 22, DUR-09)", () => {
  it("degrades to in-memory queueing and exposes durableQueueUnavailable, rather than failing silently", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new SyncClient({
      url: "ws://fake",
      documentId: randomUUID(),
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
      // Test Plan §3.6 DUR-09's own suggested approach: a stub that makes indexedDB.open()
      // throw/reject, simulating unavailability (private browsing, quota exceeded, disabled)
      // directly, rather than a real private-browsing browser context.
      openDurableQueue: () => Promise.reject(new Error("simulated: IndexedDB disabled")),
    });

    expect(client.durableQueueUnavailable).toBe(false); // not yet known until connect() is attempted
    client.connect();
    await waitForSocket(sockets, 0);

    expect(client.durableQueueUnavailable).toBe(true); // PRD A-11: explicitly surfaced, not silent
    const ws = sockets[0]!;
    ws.triggerOpen();
    ws.triggerMessage(welcomeFrame(1));
    ws.triggerMessage(snapshotFrame(0));

    // Editing still works — degraded to in-memory-only, exactly PRD A-11's "degrades... AND
    // displays the warning" (not "refuses to function").
    client.localInsert(0, 0x61);
    expect(client.engine?.text()).toBe("a");
    expect(client.unackedCount).toBe(1);
  });

  it("openDurableQueue()'s REAL default implementation never throws synchronously, even from a factory.open() that does (durableQueue.ts's own openDatabase wraps it)", () => {
    const brokenFactory = {
      open: () => {
        throw new Error("simulated: some browsers throw synchronously for a blocked IndexedDB");
      },
    } as unknown as IDBFactory;
    // openDurableQueue(factory) is the production default (SyncClient's own fallback when no
    // `openDurableQueue` option is given) — this confirms it, not just a test-injected stub, is
    // exception-safe against exactly the real-world failure mode DUR-09 is concerned with.
    expect(() => openDurableQueue(brokenFactory)).not.toThrow();
  });
});
