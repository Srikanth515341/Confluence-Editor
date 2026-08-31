import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Engine } from "@collab-editor/engine";
import {
  decodeControlFrame,
  decodeFrame,
  decodeStructureSnapshotBody,
  encodeControlFrame,
  encodeFrame,
  SnapshotForm,
  SyncMode,
  type ControlMessage,
  type OpsMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@collab-editor/protocol";
import { createCollabServer, type CollabServer } from "./server.js";
import { WS_PATH, WS_SUBPROTOCOL } from "./gateway.js";

let server: CollabServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

async function startServer(): Promise<{ port: number; server: CollabServer }> {
  const s = createCollabServer();
  server = s;
  const port = await s.listen(0); // ephemeral port
  return { port, server: s };
}

function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}${WS_PATH}`;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reasonBuf) => resolve({ code, reason: reasonBuf.toString() }));
  });
}

/**
 * Buffers every binary frame a socket receives, in arrival order, so a test
 * can `await next()` for however many frames it expects without racing the
 * server: the WELCOME+SNAPSHOT pair (and PONGs, and OPS relays) can arrive
 * back-to-back before the test gets a chance to register a fresh one-shot
 * listener for each — a plain `ws.once("message", ...)` per await would
 * silently drop whichever frame arrives in that gap. Registered once, right
 * after the socket opens, so nothing is ever missed.
 */
class IncomingFrames {
  private readonly buffered: Uint8Array[] = [];
  private readonly waiters: Array<(bytes: Uint8Array) => void> = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        return; // text-frame tests close the socket instead of reading frames
      }
      const bytes = new Uint8Array(data as Buffer);
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(bytes);
      } else {
        this.buffered.push(bytes);
      }
    });
  }

  next(): Promise<Uint8Array> {
    const already = this.buffered.shift();
    if (already) {
      return Promise.resolve(already);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async nextControl(): Promise<ControlMessage> {
    return decodeControlFrame(await this.next(), { direction: "serverOrigin" });
  }

  async nextOps(): Promise<OpsMessage> {
    return decodeFrame(await this.next(), { direction: "serverOrigin" });
  }
}

function helloBytes(
  documentId: string,
  opts: { lastServerSeq?: number; clientCapabilities?: number } = {},
): Uint8Array {
  return encodeControlFrame({
    kind: "hello",
    documentId,
    ticket: new Uint8Array(),
    lastServerSeq: opts.lastServerSeq ?? 0,
    unacked: [],
    clientCapabilities: opts.clientCapabilities ?? 0,
  });
}

/** Full HELLO -> WELCOME -> SNAPSHOT exchange against a real server, over a real `ws` connection. */
async function connectAndHandshake(
  port: number,
  documentId: string,
): Promise<{
  ws: WebSocket;
  frames: IncomingFrames;
  welcome: WelcomeMessage;
  snapshot: SnapshotMessage;
}> {
  const ws = new WebSocket(wsUrl(port), WS_SUBPROTOCOL);
  await waitForOpen(ws);
  const frames = new IncomingFrames(ws); // registered before HELLO is sent — nothing can be missed

  ws.send(helloBytes(documentId), { binary: true });

  const welcomeMsg = await frames.nextControl();
  if (welcomeMsg.kind !== "welcome") {
    throw new Error(`expected WELCOME, got ${welcomeMsg.kind}`);
  }
  const snapshotMsg = await frames.nextControl();
  if (snapshotMsg.kind !== "snapshot") {
    throw new Error(`expected SNAPSHOT, got ${snapshotMsg.kind}`);
  }

  return { ws, frames, welcome: welcomeMsg, snapshot: snapshotMsg };
}

function sendSyncComplete(ws: WebSocket, lastServerSeq: number): void {
  ws.send(encodeControlFrame({ kind: "syncComplete", lastServerSeq, resentCount: 0 }), {
    binary: true,
  });
}

function sendInsert(ws: WebSocket, op: ReturnType<Engine["localInsert"]>): void {
  const msg: OpsMessage = {
    kind: "opInsert",
    seq: 0,
    id: op.id,
    originLeft: op.originLeft,
    originRight: op.originRight,
    bind: op.bind,
    value: op.value,
  };
  ws.send(encodeFrame(msg), { binary: true });
}

describe("Health endpoint", () => {
  it("responds on GET /healthz", async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("Sync handshake — fresh connection (API Spec §3.6.1-§3.6.3, §3.6.8, §3.7.1)", () => {
  it("a fresh client completes HELLO -> WELCOME -> SNAPSHOT -> SYNC_COMPLETE", async () => {
    const { port } = await startServer();
    const documentId = randomUUID();

    const { ws, welcome, snapshot } = await connectAndHandshake(port, documentId);

    expect(welcome.replicaId).toBeGreaterThanOrEqual(1); // 0 is reserved for the server
    expect(welcome.role).toBe(1); // EDITOR, hardcoded this phase
    expect(welcome.syncMode).toBe(SyncMode.SNAPSHOT);
    expect(welcome.serverSeq).toBe(0); // fresh document, nothing applied yet
    expect(welcome.participants.map((p) => p.replicaId)).toContain(welcome.replicaId);

    expect(snapshot.form).toBe(SnapshotForm.STRUCTURE); // form:0 must never go to an editor — see handshake.test.ts
    expect(decodeStructureSnapshotBody(snapshot.body)).toEqual([]); // fresh document

    sendSyncComplete(ws, snapshot.seq);
    // No reply is specified for SYNC_COMPLETE — just prove the connection survives sending it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    await waitForClose(ws);
  });

  it("two clients joining a document with existing content both receive it correctly", async () => {
    const { port } = await startServer();
    const documentId = randomUUID();

    // Client A joins first and inserts some content. Its local Engine MUST use the replica id
    // the server actually assigned (welcome.replicaId), not an arbitrary fixed one — Phase 16's
    // write path verifies stamp.r === session.replica_id (API Spec §6.3 step 2) and rejects
    // anything else.
    const { ws: wsA, welcome: welcomeA } = await connectAndHandshake(port, documentId);
    const engineA = new Engine(welcomeA.replicaId);
    for (const value of [0x68, 0x69]) {
      // "hi"
      const op = engineA.localInsert(engineA.text().length, value);
      sendInsert(wsA, op);
    }
    // Give the server a moment to apply both inserts before client B joins.
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Client B joins second — its SNAPSHOT must already reflect A's content.
    const { snapshot: snapshotB } = await connectAndHandshake(port, documentId);
    const nodesB = decodeStructureSnapshotBody(snapshotB.body);
    const textB = nodesB
      .filter((n) => !n.deleted)
      .map((n) => String.fromCodePoint(n.value))
      .join("");
    expect(textB).toBe("hi");

    // A third client, to prove it's not a fluke of exactly-2 join order.
    const opC = engineA.localInsert(engineA.text().length, 0x21); // "!"
    sendInsert(wsA, opC);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const { snapshot: snapshotC } = await connectAndHandshake(port, documentId);
    const nodesC = decodeStructureSnapshotBody(snapshotC.body);
    const textC = nodesC
      .filter((n) => !n.deleted)
      .map((n) => String.fromCodePoint(n.value))
      .join("");
    expect(textC).toBe("hi!");

    wsA.close();
    await waitForClose(wsA);
  });

  it("each connection receives a distinct replica id; reconnecting yields a new one — 50 connect/disconnect cycles", async () => {
    const { port } = await startServer();
    const documentId = randomUUID();
    const seenReplicaIds = new Set<number>();

    for (let i = 0; i < 50; i++) {
      const { ws, welcome } = await connectAndHandshake(port, documentId);
      expect(welcome.replicaId).not.toBe(0); // reserved for the server
      expect(seenReplicaIds.has(welcome.replicaId)).toBe(false);
      seenReplicaIds.add(welcome.replicaId);
      ws.close();
      await waitForClose(ws);
    }

    expect(seenReplicaIds.size).toBe(50);
  }, 30_000);

  it("rejects a connection whose first frame is not HELLO on CONTROL", async () => {
    const { port } = await startServer();
    const ws = new WebSocket(wsUrl(port), WS_SUBPROTOCOL);
    await waitForOpen(ws);

    const closed = waitForClose(ws);
    const notHello: OpsMessage = {
      kind: "opDelete",
      seq: 0,
      id: { c: 1, r: 1 },
      target: { c: 1, r: 1 },
    };
    ws.send(encodeFrame(notHello), { binary: true });

    const { code } = await closed;
    expect(code).toBe(1008);
  });

  it("a text frame closes the socket with code 1003, even mid-handshake", async () => {
    const { port } = await startServer();
    const ws = new WebSocket(wsUrl(port), WS_SUBPROTOCOL);
    await waitForOpen(ws);

    const closed = waitForClose(ws);
    ws.send("this is a text frame, not binary");

    const { code } = await closed;
    expect(code).toBe(1003);
  });
});

describe("Two clients, one document — operations reach the other peer and both engines converge", () => {
  it("an insert from client A reaches client B, and their local engines converge", async () => {
    const { port } = await startServer();
    const documentId = randomUUID();

    const { ws: wsA, welcome: welcomeA } = await connectAndHandshake(port, documentId);
    const {
      ws: wsB,
      frames: framesB,
      welcome: welcomeB,
    } = await connectAndHandshake(port, documentId);

    // Must match the server-assigned replica ids — see the identity-mismatch comment on the
    // previous test above.
    const engineA = new Engine(welcomeA.replicaId);
    const engineB = new Engine(welcomeB.replicaId);

    const opA = engineA.localInsert(0, 0x68); // 'h'
    sendInsert(wsA, opA);

    const relayedMsg = await framesB.nextOps();
    expect(relayedMsg.kind).toBe("opInsert");
    if (relayedMsg.kind === "opInsert") {
      engineB.applyRemote({
        kind: "insert",
        id: relayedMsg.id,
        value: relayedMsg.value,
        originLeft: relayedMsg.originLeft,
        originRight: relayedMsg.originRight,
        bind: relayedMsg.bind,
      });
      expect(relayedMsg.seq).toBeGreaterThan(0);
    }

    expect(engineA.text()).toBe("h");
    expect(engineB.text()).toBe("h");

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });
});

describe("Heartbeat over a real connection (API Spec §3.6.11)", () => {
  it("server replies PONG to PING, echoing clientTimeMs and reporting serverSeq", async () => {
    const { port } = await startServer();
    const documentId = randomUUID();
    const { ws, frames } = await connectAndHandshake(port, documentId);

    ws.send(encodeControlFrame({ kind: "ping", clientTimeMs: 123456, lastAppliedSeq: 0 }), {
      binary: true,
    });
    const pong = await frames.nextControl();

    expect(pong.kind).toBe("pong");
    if (pong.kind === "pong") {
      expect(pong.clientTimeMs).toBe(123456);
      expect(pong.serverSeq).toBe(0);
    }

    ws.close();
    await waitForClose(ws);
  });

  it("PONG is sent on the CONTROL channel (verified by decoding it as CONTROL, not OPS)", async () => {
    const { port } = await startServer();
    const documentId = randomUUID();
    const { ws, frames } = await connectAndHandshake(port, documentId);

    ws.send(encodeControlFrame({ kind: "ping", clientTimeMs: 1, lastAppliedSeq: 0 }), {
      binary: true,
    });
    const bytes = await frames.next();
    expect(bytes[1]).toBe(0x03); // Channel.CONTROL

    ws.close();
    await waitForClose(ws);
  });
});
