// Phase 25 — DUR-06 fix, client-side mirror of writePath.ts's own DUR-06 fix. Regression tests
// for the exact bug found via the real DUR-06 adverse-network test: `SyncClient.handleOps`
// (and `handleCatchupChunk`/`handleCatchupEnd`) used to advance the tracked `lastServerSeq`
// (HELLO's own field, driving CATCHUP's `fromSeq`) to a frame's claimed seq range regardless of
// whether every operation within it actually applied (`engine.applyRemote` returning
// `{buffered: true}`) — permanently skipping a merely-reordered, still-buffered operation the
// instant a reconnect discarded the engine (and its `pending`) before that operation resolved.
//
// See `highestAppliedSeq`/`pendingFrameSeqs`/`highestFrameSeqSeen`/`handshakeGeneration`'s own
// doc comments in syncClient.ts for the full mechanism and hand-trace this file verifies.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "@collab-editor/engine";
import {
  decodeControlFrame,
  encodeControlFrame,
  encodeFrame,
  encodeStructureSnapshotBody,
  operationToOpInsert,
  SessionRole,
  SyncMode,
  type ControlMessage,
} from "@collab-editor/protocol";
import { SyncClient, type WebSocketLike } from "./syncClient.js";

class FakeWebSocket implements WebSocketLike {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "simulated" });
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

const liveClients: SyncClient[] = [];
afterEach(() => {
  for (const c of liveClients) c.disconnect();
  liveClients.length = 0;
});

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function lastHello(ws: FakeWebSocket): { lastServerSeq: number } {
  const msg = decodeControlFrame(ws.sent[ws.sent.length - 1]!, { direction: "clientOrigin" }) as ControlMessage;
  if (msg.kind !== "hello") throw new Error(`expected hello, got ${msg.kind}`);
  return msg;
}

describe("SyncClient — tracked lastServerSeq must never overclaim (Phase 25, DUR-06 fix)", () => {
  it("a reordered live OPS frame that buffers holds the tracker back; a later frame resolving it via drain() catches the tracker up in one jump; a disconnect while still buffered reports the correct (lower) value on the next HELLO", async () => {
    let socket: FakeWebSocket;
    const client = new SyncClient({
      url: "ws://fake",
      documentId: randomUUID(),
      createSocket: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });
    liveClients.push(client);

    // Real Engine, used only to mint well-formed, chain-anchored operations (never connected
    // to the server itself) -- A is document-start, B anchors to A, C anchors to B.
    const minter = new Engine(99);
    const opA = minter.localInsert(0, "A".codePointAt(0)!);
    const opB = minter.localInsert(1, "B".codePointAt(0)!);
    const opC = minter.localInsert(2, "C".codePointAt(0)!);

    client.connect();
    socket!.triggerOpen();
    socket!.triggerMessage(
      encodeControlFrame({
        kind: "welcome",
        sessionId: randomUUID(),
        replicaId: 1,
        role: SessionRole.EDITOR,
        serverSeq: 100,
        syncMode: SyncMode.SNAPSHOT,
        participants: [],
      }),
    );
    socket!.triggerMessage(
      encodeControlFrame({
        kind: "snapshot",
        seq: 100,
        form: 1,
        body: encodeStructureSnapshotBody([]),
      }),
    );
    socket!.triggerMessage(encodeControlFrame({ kind: "alreadyHave", alreadyHave: [] }));
    await flush();
    expect(client.state.value).toBe("synced");

    // --- Deliver C FIRST, out of order (seq 103) — its own parent (B) is not yet present, so
    // it BUFFERS. The tracker must NOT advance to 103. ---
    socket!.triggerMessage(encodeFrame(operationToOpInsert(opC, 103)));
    expect(client.engine?.text()).toBe(""); // C never became visible
    expect(client.engine?.pending.length).toBe(1);

    // --- Scenario 3: disconnect NOW, while C is still legitimately buffered. The next HELLO
    // must report the OLD baseline (100), never 103 -- proving the tracker held back exactly
    // where it should. ---
    socket!.close();
    client.connect();
    socket!.triggerOpen();
    expect(lastHello(socket!).lastServerSeq).toBe(100);

    // Reconnect fully (ALREADY_CURRENT — nothing new from the server's own perspective in this
    // synthetic test) so the client is live again for the next phase of this same test.
    socket!.triggerMessage(
      encodeControlFrame({
        kind: "welcome",
        sessionId: randomUUID(),
        replicaId: 2,
        role: SessionRole.EDITOR,
        serverSeq: 100,
        syncMode: SyncMode.ALREADY_CURRENT,
        participants: [],
      }),
    );
    socket!.triggerMessage(encodeControlFrame({ kind: "alreadyHave", alreadyHave: [] }));
    await flush();
    expect(client.state.value).toBe("synced");
    // The rebuild correctly discarded the stale, now-irrelevant buffered C along with the old
    // engine generation -- nothing carries over.
    expect(client.engine?.pending.length).toBe(0);

    // --- Deliver A (seq 101, parent=null — always ready) — mixed readiness across the two
    // frames received so far (C failed, A succeeds): the tracker advances to 101, not beyond. ---
    socket!.triggerMessage(encodeFrame(operationToOpInsert(opA, 101)));
    expect(client.engine?.text()).toBe("A");
    expect(lastHelloWouldReport(client)).toBe(101);

    // --- Scenario 2: deliver B (seq 102). B's own parent (A) is now present, so B applies —
    // and because this fresh engine never re-received C, B's application does NOT resolve
    // anything on its own here (C was discarded at reconnect, per Rule 7.2-style cleanup this
    // test's own earlier rebuild already performed) — a clean, single-step advance to 102. ---
    socket!.triggerMessage(encodeFrame(operationToOpInsert(opB, 102)));
    expect(client.engine?.text()).toBe("AB");
    expect(lastHelloWouldReport(client)).toBe(102);

    client.disconnect();
  });

  it("drain() side-effect resolution: a later frame's own application resolving an EARLIER still-buffered operation (from the SAME engine generation) advances the tracker past both in one jump", async () => {
    let socket: FakeWebSocket;
    const client = new SyncClient({
      url: "ws://fake",
      documentId: randomUUID(),
      createSocket: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });
    liveClients.push(client);

    const minter = new Engine(99);
    const opA = minter.localInsert(0, "A".codePointAt(0)!);
    const opB = minter.localInsert(1, "B".codePointAt(0)!);

    client.connect();
    socket!.triggerOpen();
    socket!.triggerMessage(
      encodeControlFrame({
        kind: "welcome",
        sessionId: randomUUID(),
        replicaId: 1,
        role: SessionRole.EDITOR,
        serverSeq: 200,
        syncMode: SyncMode.SNAPSHOT,
        participants: [],
      }),
    );
    socket!.triggerMessage(
      encodeControlFrame({ kind: "snapshot", seq: 200, form: 1, body: encodeStructureSnapshotBody([]) }),
    );
    socket!.triggerMessage(encodeControlFrame({ kind: "alreadyHave", alreadyHave: [] }));
    await flush();

    // B arrives first (seq 202) — its parent A is missing — buffers. Tracker stays at 200.
    socket!.triggerMessage(encodeFrame(operationToOpInsert(opB, 202)));
    expect(client.engine?.pending.length).toBe(1);
    expect(lastHelloWouldReport(client)).toBe(200);

    // A arrives (seq 201) — applies, and its application triggers drain(), which resolves B as
    // a SIDE EFFECT (B's own frame -- seq 202 -- was received a while ago, in a completely
    // different `handleOps` call). The tracker must jump straight to 202, not get stuck at 201.
    socket!.triggerMessage(encodeFrame(operationToOpInsert(opA, 201)));
    expect(client.engine?.text()).toBe("AB");
    expect(client.engine?.pending.length).toBe(0);
    expect(lastHelloWouldReport(client)).toBe(202);

    client.disconnect();
  });

  it("a STALE handshakeGate continuation from a superseded connection generation does not corrupt the NEW generation's tracked seq", async () => {
    let socket: FakeWebSocket;
    const client = new SyncClient({
      url: "ws://fake",
      documentId: randomUUID(),
      createSocket: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });
    liveClients.push(client);

    // --- Generation 1: CATCHUP begins, one chunk arrives (queued on handshakeGate, NOT yet
    // flushed) whose own operation has an unsatisfiable parent (never delivered in this test at
    // all) -- if this stale work were allowed to run against a LATER generation's engine, it
    // would permanently cap that generation's own tracked seq at a phantom, never-resolving gap. ---
    client.connect();
    socket!.triggerOpen();
    socket!.triggerMessage(
      encodeControlFrame({
        kind: "welcome",
        sessionId: randomUUID(),
        replicaId: 1,
        role: SessionRole.EDITOR,
        serverSeq: 50,
        syncMode: SyncMode.CATCHUP,
        participants: [],
      }),
    );
    socket!.triggerMessage(encodeControlFrame({ kind: "catchupBegin", fromSeq: 0, toSeq: 50, totalOps: 1 }));
    socket!.triggerMessage(
      encodeControlFrame({
        kind: "catchupChunk",
        throughSeq: 50,
        ops: [
          {
            kind: "insert",
            id: { c: 1, r: 999 },
            value: "X".codePointAt(0)!,
            parent: { c: 1, r: 998 }, // a dependency this test NEVER delivers -- would buffer forever
            side: "R",
            bind: false,
          },
        ],
      }),
    );
    // Deliberately NOT flushed -- this chunk's own application is still queued on generation 1's
    // handshakeGate.

    // --- Reconnect to generation 2 BEFORE generation 1's queued chunk work ever runs. ---
    socket!.close();
    client.connect();
    socket!.triggerOpen();
    socket!.triggerMessage(
      encodeControlFrame({
        kind: "welcome",
        sessionId: randomUUID(),
        replicaId: 2,
        role: SessionRole.EDITOR,
        serverSeq: 60,
        syncMode: SyncMode.CATCHUP,
        participants: [],
      }),
    );
    socket!.triggerMessage(encodeControlFrame({ kind: "catchupBegin", fromSeq: 0, toSeq: 60, totalOps: 1 }));
    const minter = new Engine(99);
    const opY = minter.localInsert(0, "Y".codePointAt(0)!);
    socket!.triggerMessage(
      encodeControlFrame({ kind: "catchupChunk", throughSeq: 60, ops: [opY] }),
    );
    socket!.triggerMessage(encodeControlFrame({ kind: "catchupEnd", toSeq: 60, totalOps: 1 }));
    socket!.triggerMessage(encodeControlFrame({ kind: "alreadyHave", alreadyHave: [] }));

    // Now let EVERYTHING queued run — generation 1's stale chunk callback (if not guarded)
    // AND generation 2's own real work.
    await flush(20);

    // Generation 2's own content must be present and its own tracked seq must correctly reach
    // 60 -- NOT capped by generation 1's stale, unsatisfiable dependency.
    expect(client.engine?.nodes.some((n) => n.id.c === opY.id.c && n.id.r === opY.id.r)).toBe(true);
    expect(client.state.value).toBe("synced");
    expect(lastHelloWouldReport(client)).toBe(60);
    // The stale generation-1 operation must NOT have been applied into generation 2's engine at
    // all (the whole stale callback is a no-op, not just its own seq bookkeeping).
    expect(client.engine?.nodes.some((n) => n.id.c === 1 && n.id.r === 999)).toBe(false);
    expect(client.engine?.pending.length).toBe(0);

    client.disconnect();
  });
});

/** Reads the client's own currently-tracked `highestAppliedSeq` (private) directly — exactly the value the NEXT HELLO would report as `lastServerSeq` — via the same bracket-notation private-field access this project's own RC-33e test already established, rather than forcing and immediately aborting a real reconnect just to observe it. */
function lastHelloWouldReport(client: SyncClient): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client as any)["highestAppliedSeq"] as number;
}
