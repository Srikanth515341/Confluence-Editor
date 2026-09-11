import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Engine } from "@collab-editor/engine";
import {
  Channel,
  decodeControlFrame,
  decodeFrame,
  decodeStructureSnapshotBody,
  encodeControlFrame,
  encodeFrame,
  ErrorCode,
  GoodbyeReason,
  operationToOpDelete,
  operationToOpInsert,
  peekChannel,
  RejectReason,
  SessionRole,
  SnapshotForm,
  SyncMode,
  type AlreadyHaveMessage,
  type ControlMessage,
  type ErrorMessage,
  type OpsMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@collab-editor/protocol";
import { createCollabServer, type CollabServer } from "./server.js";
import { WS_PATH, WS_SUBPROTOCOL } from "./gateway.js";
import { runOneDocument as runOneOfflineWindowSweep } from "./offlineWindowScheduler.js";

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

/**
 * Full HELLO -> WELCOME -> SNAPSHOT -> ALREADY_HAVE exchange against a
 * real server, over a real `ws` connection. Every caller in this file
 * connects fresh (default `helloBytes` — `lastServerSeq: 0`,
 * `clientCapabilities: 0`, i.e. no resident-engine bit), so `decideSyncMode`
 * (Phase 23) always resolves to SNAPSHOT here — this helper stays
 * SNAPSHOT-specific; a reconnection-focused test exercising CATCHUP lives
 * in `packages/client/src/sync/reconnection.test.ts` instead, against a
 * real `SyncClient` rather than hand-built frames. ALREADY_HAVE is always
 * the third CONTROL frame regardless of syncMode (gateway.ts sends it
 * unconditionally after whichever state-sync payload applies) and MUST be
 * consumed here, not left buffered — otherwise a later `frames.next()`/
 * `frames.nextControl()` call elsewhere in this file (e.g. the PONG checks
 * in the heartbeat tests below) would silently receive this leftover
 * frame instead of the one it actually expects.
 */
async function connectAndHandshake(
  port: number,
  documentId: string,
): Promise<{
  ws: WebSocket;
  frames: IncomingFrames;
  welcome: WelcomeMessage;
  snapshot: SnapshotMessage;
  alreadyHave: AlreadyHaveMessage;
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
  const alreadyHaveMsg = await frames.nextControl();
  if (alreadyHaveMsg.kind !== "alreadyHave") {
    throw new Error(`expected ALREADY_HAVE, got ${alreadyHaveMsg.kind}`);
  }

  return { ws, frames, welcome: welcomeMsg, snapshot: snapshotMsg, alreadyHave: alreadyHaveMsg };
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
    parent: op.parent,
    side: op.side,
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
        parent: relayedMsg.parent,
        side: relayedMsg.side,
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

describe("Permission downgrade while offline (Phase 24, Test Plan RC-32, API Spec §5.4)", () => {
  it("a queued role override is reflected in WELCOME's own role AND followed by a PERMISSION_CHANGED notification, on the NEXT join only", async () => {
    const { port, server: s } = await startServer();
    const documentId = randomUUID();

    // First connection: ordinary EDITOR default, no override queued yet -- this is what
    // actually creates the coordinator (gateway.ts's lazy getOrCreateCoordinator).
    const first = await connectAndHandshake(port, documentId);
    expect(first.welcome.role).toBe(SessionRole.EDITOR);
    first.ws.close();
    await waitForClose(first.ws);

    const coordinator = s.gateway.coordinators.get(documentId);
    if (!coordinator) {
      throw new Error("coordinator should exist after the first join");
    }
    coordinator.testOnlyQueueRoleOverride(SessionRole.VIEWER); // "the owner downgrades C while away"

    const second = await connectAndHandshake(port, documentId);
    expect(second.welcome.role).toBe(SessionRole.VIEWER); // "viewers may read" -- HELLO still succeeds, CATCHUP/SNAPSHOT still delivered

    const permissionChanged = await second.frames.nextControl();
    expect(permissionChanged).toEqual({
      kind: "permissionChanged",
      role: SessionRole.VIEWER,
      effectiveAtSeq: expect.any(Number),
    });

    second.ws.close();
    await waitForClose(second.ws);

    // The override was consumed by the second join alone -- a THIRD, unrelated join gets the
    // ordinary default again, proving this never leaks past the one join it was queued for.
    const third = await connectAndHandshake(port, documentId);
    expect(third.welcome.role).toBe(SessionRole.EDITOR);
    third.ws.close();
    await waitForClose(third.ws);
  });

  it("a VIEWER session's queued offline operations are all rejected with PERMISSION_DENIED, naming their own stamps, once reconciled and resent", async () => {
    const { port, server: s } = await startServer();
    const documentId = randomUUID();

    const first = await connectAndHandshake(port, documentId);
    first.ws.close();
    await waitForClose(first.ws);

    const coordinator = s.gateway.coordinators.get(documentId);
    if (!coordinator) {
      throw new Error("coordinator should exist after the first join");
    }
    coordinator.testOnlyQueueRoleOverride(SessionRole.VIEWER);

    const second = await connectAndHandshake(port, documentId);
    const permissionChanged = await second.frames.nextControl();
    expect(permissionChanged.kind).toBe("permissionChanged");

    // Simulates C's own reconnection reconciliation (reconcileOfflineQueue.ts, Phase 22/23) --
    // this WELCOME's own resident-engine replica id is what a real re-mint would use.
    const engine = new Engine(second.welcome.replicaId);
    const op = engine.localInsert(0, 0x71); // 'q'
    second.ws.send(encodeFrame(operationToOpInsert(op, 0)), { binary: true });

    const reject = await second.frames.nextOps();
    expect(reject.kind).toBe("opReject");
    if (reject.kind === "opReject") {
      expect(reject.rejects).toEqual([{ rejectedId: op.id, reason: RejectReason.PERMISSION_DENIED }]);
    }
    expect(coordinator.engine.text()).not.toContain("q"); // never actually applied to the document

    second.ws.close();
    await waitForClose(second.ws);
  });
});

describe("Offline-window sweep, end to end over the real wire protocol (Phase 24, Engine Spec §7.6 Rule 7.2, RC-30)", () => {
  it("an operation naming a since-collected origin lands in engine.pending and is explicitly rejected with OFFLINE_WINDOW_EXCEEDED once genuinely overdue", async () => {
    // Deliberately NOT routed through a real SyncClient's own reconciliation
    // (packages/client/src/sync/reconcileOfflineQueue.ts): that logic (Phase 22) always
    // resolves an anchor against the reconnecting client's OWN current structure at reconcile
    // time, which gracefully degrades to a safe, always-resolvable position rather than ever
    // re-sending a specific, now-collected identifier -- found and documented while building
    // this phase's own client-level test
    // (packages/client/src/sync/offlineWindowPreservation.test.ts's own header comment has the
    // full trace). This test instead sends a raw, hand-built OP_INSERT naming a specific
    // collected identifier directly -- proving the SERVER's own mechanism reachable via the
    // real wire protocol regardless of what any particular client implementation happens to do.
    const { port, server: s } = await startServer();
    const documentId = randomUUID();
    const { ws, frames, welcome } = await connectAndHandshake(port, documentId);

    // TWO local engine instances, deliberately: `engineLive` mints and sends both "X" and its
    // own later delete (ordinary traffic); `engineStale` only ever LEARNS about "X" (never the
    // delete) -- standing in for "a client whose own knowledge is stale enough to still
    // reference a since-removed node," since minting the later insert from the SAME engine
    // that already applied the delete would (correctly, per reconcileOfflineQueue.ts's own
    // graceful-degradation design) re-anchor to a safe, always-resolvable position instead --
    // this is the exact confusion this test's own header comment documents having found.
    const engineLive = new Engine(welcome.replicaId);
    const xOp = engineLive.localInsert(0, "X".codePointAt(0)!);
    ws.send(encodeFrame(operationToOpInsert(xOp, 0)), { binary: true });
    await frames.nextOps(); // ACK

    const engineStale = new Engine(welcome.replicaId);
    engineStale.applyRemote(xOp); // learns about "X" -- but never the delete below
    // Jumps the clock well past anything `engineLive` will ever mint in this test, so the
    // stale op's own id can never accidentally collide with (and be silently deduped against)
    // one of engineLive's real, already-committed operations (Invariant I1).
    engineStale.observe(1_000);

    const [deleteOp] = engineLive.localDelete(0, 1);
    ws.send(encodeFrame(operationToOpDelete(deleteOp!, 0)), { binary: true });
    await frames.nextOps(); // ACK

    const coordinator = s.gateway.coordinators.get(documentId);
    if (!coordinator) {
      throw new Error("coordinator should exist");
    }
    const collectResult = coordinator.engine.collect(coordinator.currentSeq, {
      nowMs: Date.now(),
      maxAgeMs: 0,
      maxOpsPerReplica: 0,
    });
    expect(collectResult.collectedCount).toBeGreaterThan(0);
    expect(coordinator.engine.hasIdentifier(xOp.id)).toBe(false); // truly, physically gone

    // A raw OP_INSERT naming "X"'s own (now-collected) identifier as its origin -- exactly the
    // shape a client whose own knowledge is stale enough to still reference it would send.
    const staleOp = engineStale.localInsert(1, "!".codePointAt(0)!);
    ws.send(encodeFrame(operationToOpInsert(staleOp, 0)), { binary: true });

    // Confirm it actually reached `engine.pending` (a real network round trip, even on
    // loopback, is not instantaneous) before sweeping.
    const deadline = Date.now() + 5_000;
    while (coordinator.engine.pending.length === 0) {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the stale operation to reach engine.pending");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Phase 25's DUR-06 fix: `staleOp` is buffered (not ready), so writePath.ts does NOT ack it
    // here -- acking-implies-durability (API Spec §6.3, PRD FR-PS-2) means an operation the
    // server's own engine just reported as not-yet-integrated must never be acked as if it had
    // succeeded. No OP_ACK arrives for it at all; the next OPS-channel frame this socket
    // receives is the OFFLINE_WINDOW_EXCEEDED rejection itself, below.
    const config = { pendingRejectTimeoutMs: 30, sweepIntervalMs: 1_000 };
    runOneOfflineWindowSweep(coordinator, config); // first sighting -- not yet overdue
    await new Promise((resolve) => setTimeout(resolve, 60));
    runOneOfflineWindowSweep(coordinator, config); // now overdue -- rejects

    const reject = await frames.nextOps();
    expect(reject.kind).toBe("opReject");
    if (reject.kind === "opReject") {
      expect(reject.rejects).toEqual([
        { rejectedId: staleOp.id, reason: RejectReason.OFFLINE_WINDOW_EXCEEDED },
      ]);
    }
    expect(coordinator.engine.pending).toHaveLength(0); // Rule 7.2: explicitly evicted, not left forever

    ws.close();
    await waitForClose(ws);
  }, 15_000); // above vitest's 5000ms default -- several real round trips plus a deliberate real wait
});

describe("Phase 30 — connection-rate limiting over a real WebSocket connection (RFC §8.8)", () => {
  it("rejects a connection attempt with ERROR{RATE_LIMITED} and closes 1008, once the per-IP cap for this fixed testing window has been exceeded", async () => {
    // Every connection in this test comes from the same loopback address, so a real per-IP
    // limiter genuinely applies to all of them without needing to fake or spoof any client
    // address -- see `X-Forwarded-For`'s own absence from this project's design (gateway.ts's
    // own comment: no reverse-proxy deployment story yet).
    const s = createCollabServer({ connectionRateLimit: { perIp: { max: 2, windowMs: 60_000 }, perAccount: { max: 1000, windowMs: 60_000 } } });
    server = s;
    const port = await s.listen(0);

    // The first TWO connections are admitted normally -- each completes a real handshake. Not
    // explicitly closed afterward: `afterEach` (below) already tears down every socket this
    // test's own server still has open via `Gateway.close()`'s own `ws.terminate()` sweep.
    await connectAndHandshake(port, randomUUID());
    await connectAndHandshake(port, randomUUID());

    // The THIRD raw connection attempt, from the SAME address, is rejected before HELLO is even
    // parsed -- a real ERROR{RATE_LIMITED} CONTROL frame, then a real 1008 close. Unlike
    // `connectAndHandshake` above (where the CLIENT always speaks first, so the server can never
    // possibly reply before a listener is attached), the server reacts here the INSTANT the raw
    // connection opens, unprompted -- so every listener is registered synchronously, right after
    // construction, before anything can possibly arrive.
    const third = new WebSocket(wsUrl(port), WS_SUBPROTOCOL);
    const messagePromise = new Promise<Uint8Array>((resolve) => {
      third.once("message", (data, isBinary) => {
        if (isBinary) resolve(new Uint8Array(data as Buffer));
      });
    });
    const closePromise = waitForClose(third);

    const errorMsg = decodeControlFrame(await messagePromise, { direction: "serverOrigin" }) as ErrorMessage;
    expect(errorMsg.kind).toBe("error");
    expect(errorMsg.code).toBe(ErrorCode.RATE_LIMITED);
    expect(errorMsg.fatal).toBe(true);
    const { code } = await closePromise;
    expect(code).toBe(1008);

    // No explicit cleanup of `first`/`second` here -- `afterEach` (below) already calls
    // `server.close()`, which `Gateway.close()` (gateway.ts) implements by `ws.terminate()`-ing
    // every still-open connection itself, precisely so a test never needs to remember to close
    // every socket it opened.
  });

  it("with no `connectionRateLimit` configured (every pre-Phase-30 test), connection attempts are never throttled at all", async () => {
    const { port } = await startServer(); // startServer()'s own default: no connectionRateLimit
    for (let i = 0; i < 5; i++) {
      const { ws } = await connectAndHandshake(port, randomUUID());
      ws.close();
      await waitForClose(ws);
    }
  });
});

describe("Phase 30 — DOCUMENT_LOCKED over the real wire protocol, once the circuit breaker trips (RFC §8.2 (T2))", () => {
  it("an OWNER's own operation is rejected DOCUMENT_LOCKED, never applied, once the document's structure-size ceiling is reached", async () => {
    const s = createCollabServer({ circuitBreaker: { structureSizeCeiling: 2, structureSizeAlertThreshold: 1, tombstoneCountAlertThreshold: 100 } });
    server = s;
    const port = await s.listen(0);
    const documentId = randomUUID();
    const { ws, frames, welcome } = await connectAndHandshake(port, documentId);

    const engine = new Engine(welcome.replicaId);
    // Two inserts reach the ceiling of 2 -- both still accepted (the breaker trips reactively,
    // right after the SECOND one actually commits, not before).
    const op1 = engine.localInsert(0, 0x61);
    ws.send(encodeFrame(operationToOpInsert(op1, 0)), { binary: true });
    await frames.nextOps(); // ack
    const op2 = engine.localInsert(1, 0x62);
    ws.send(encodeFrame(operationToOpInsert(op2, 0)), { binary: true });
    await frames.nextOps(); // ack

    // A THIRD operation, from this document's own OWNER (the hardcoded default role every real
    // connection gets, per API Spec §3.6.2, absent real auth wiring) is rejected outright.
    const op3 = engine.localInsert(2, 0x63);
    ws.send(encodeFrame(operationToOpInsert(op3, 0)), { binary: true });
    const rejectMsg = await frames.nextOps();
    if (rejectMsg.kind !== "opReject") {
      throw new Error(`expected opReject, got ${rejectMsg.kind}`);
    }
    expect(rejectMsg.rejects).toEqual([{ rejectedId: op3.id, reason: RejectReason.DOCUMENT_LOCKED }]);

    ws.close();
    await waitForClose(ws);
  });
});

describe("Phase 30 — SEC-08 real attack scenario: sustained scattered insert-then-delete DOES get the attacker disconnected (RFC §8.2 (T2))", () => {
  // This test exists because an earlier version of the disconnect mechanism NEVER actually
  // fired against a real sustained attacker -- confirmed by an empirical measurement (a real
  // scripted client, in a SEPARATE OS process from the server, sending ~530-600 real
  // insert-then-delete ops/s at scattered positions for 15+ real seconds) that found the
  // original "disconnect after CONTINUOUS, zero-acceptance violation for N ms" design was
  // structurally unreachable: a limiter that successfully THROTTLES an attacker, by definition,
  // keeps admitting messages at its own cap forever, and every acceptance reset the streak to
  // zero. See RateLimitConfig.perSessionDisconnectRule's own doc comment (config.ts) for the
  // fix. This test proves the FIX, not merely "was throttled" -- it asserts the socket actually
  // closes, with the real GOODBYE{EVICTED} frame and the real 4002 close code, within a bounded
  // real time. Numbers are scaled down from the real 200/1000ms production default purely for
  // test speed -- the MECHANISM under test (rolling violation-volume tracking via the same
  // InMemoryRateLimiter class) is identical.
  it("a real client sending real, validly-anchored scattered insert-then-delete operations well above the per-session cap is disconnected within a bounded real time", async () => {
    const s = createCollabServer({
      rateLimit: {
        perSessionRule: { max: 10, windowMs: 200 },
        perSessionDisconnectRule: { max: 10, windowMs: 200 },
        perDocumentRule: { max: 10_000, windowMs: 200 },
      },
    });
    server = s;
    const port = await s.listen(0);
    const documentId = randomUUID();
    const { ws, frames, welcome } = await connectAndHandshake(port, documentId);

    const engine = new Engine(welcome.replicaId);
    let rngState = 42;
    const rng = () => {
      rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
      return rngState / 0x7fffffff;
    };

    const closePromise = waitForClose(ws);
    let goodbyeReason: GoodbyeReason | undefined;
    // A SINGLE unified drain loop, not two competing consumers -- `IncomingFrames.next()` hands
    // out frames strictly FIFO to whichever caller is next in line, regardless of channel, so two
    // separate loops each blindly calling `nextControl()`/`nextOps()` could each receive the
    // OTHER channel's frame and throw on the wrong decode, silently ending early (a real bug
    // caught by hand-tracing this exact test before trusting it). Peek the channel byte first,
    // decode with the matching function, and route to the right handling.
    void (async () => {
      try {
        for (;;) {
          const bytes = await frames.next();
          if (peekChannel(bytes) === Channel.CONTROL) {
            const ctrl = decodeControlFrame(bytes, { direction: "serverOrigin" });
            if (ctrl.kind === "goodbye") {
              goodbyeReason = ctrl.reason;
            }
          }
          // OPS-channel frames (acks/rejects) are drained too, just never inspected -- this
          // test cares about the eventual close, not each individual response.
        }
      } catch {
        /* socket closed -- frames.next() rejects nothing on close, but a decode of a frame that
           arrives in the same tick as the close is not guaranteed complete; irrelevant once
           we're racing against closePromise below */
      }
    })();

    // Real, validly-anchored operations minted by a real Engine, sent as fast as this loop can
    // go -- scattered insert-then-delete, SEC-08's own literal shape. Each iteration sends TWO
    // separate frames (never coalescible -- scattered positions, per SEC-09's own point), well
    // above the 10-per-200ms cap.
    let stopped = false;
    closePromise.then(() => {
      stopped = true;
    });
    const sendLoop = setInterval(() => {
      if (stopped || ws.readyState !== WebSocket.OPEN) {
        clearInterval(sendLoop);
        return;
      }
      for (let i = 0; i < 5; i++) {
        if (stopped || ws.readyState !== WebSocket.OPEN) break;
        const text = engine.text();
        const insertAt = text.length === 0 ? 0 : Math.floor(rng() * (text.length + 1));
        const insertOp = engine.localInsert(insertAt, 97 + Math.floor(rng() * 26));
        ws.send(encodeFrame(operationToOpInsert(insertOp, 0)), { binary: true });

        const afterText = engine.text();
        if (afterText.length > 1 && rng() < 0.7) {
          const deleteAt = Math.floor(rng() * afterText.length);
          for (const dop of engine.localDelete(deleteAt, 1)) {
            ws.send(encodeFrame(operationToOpDelete(dop, 0)), { binary: true });
          }
        }
      }
    }, 5);

    const { code } = await closePromise;
    clearInterval(sendLoop);

    expect(code).toBe(4002);
    expect(goodbyeReason).toBe(GoodbyeReason.EVICTED);
  }, 10_000);

  // The two hand-traced non-regression cases from the fix's own design, confirmed here under
  // REAL execution (a real WebSocket, a real server, real operations) -- not just the direct
  // `processIncomingOperation`/`recordRateLimitViolation` unit-level proofs in
  // securityLimits.test.ts.

  it("a large legitimate paste is NEVER penalized, even under an extremely tight per-session cap -- it counts as ONE message, not 500", async () => {
    const s = createCollabServer({
      rateLimit: {
        perSessionRule: { max: 1, windowMs: 60_000 },
        perSessionDisconnectRule: { max: 1, windowMs: 60_000 },
        perDocumentRule: { max: 1, windowMs: 60_000 },
      },
    });
    server = s;
    const port = await s.listen(0);
    const documentId = randomUUID();
    const { ws, frames, welcome } = await connectAndHandshake(port, documentId);

    const engine = new Engine(welcome.replicaId);
    const ops = Array.from({ length: 500 }, (_, i) => engine.localInsert(i, 0x61));
    const first = ops[0]!;
    const runMsg: OpsMessage = {
      kind: "opInsertRun",
      seq: 0,
      firstId: first.id,
      firstParent: first.parent,
      firstSide: first.side,
      bind: false,
      values: ops.map(() => 0x61),
    };
    ws.send(encodeFrame(runMsg), { binary: true });

    // A real ack, not a reject -- the whole 500-character paste landed in ONE message, so it
    // never even approached the per-session cap of 1.
    const response = await frames.nextOps();
    expect(response.kind).toBe("opAck");

    ws.close();
    await waitForClose(ws);
  });

  it("a legitimate, non-batchable burst MODERATELY over the cap is throttled but NEVER disconnected -- distinct from the SEC-08 attack shape above", async () => {
    const s = createCollabServer({
      rateLimit: {
        perSessionRule: { max: 50, windowMs: 1000 },
        perSessionDisconnectRule: { max: 50, windowMs: 1000 }, // this project's own real default ratio
        perDocumentRule: { max: 100_000, windowMs: 1000 },
      },
    });
    server = s;
    const port = await s.listen(0);
    const documentId = randomUUID();
    const { ws, frames, welcome } = await connectAndHandshake(port, documentId);

    const engine = new Engine(welcome.replicaId);
    let goodbyeSeen = false;
    void (async () => {
      try {
        for (;;) {
          const bytes = await frames.next();
          if (peekChannel(bytes) === Channel.CONTROL) {
            const ctrl = decodeControlFrame(bytes, { direction: "serverOrigin" });
            if (ctrl.kind === "goodbye") goodbyeSeen = true;
          }
        }
      } catch {
        /* socket closed */
      }
    })();

    // ~70 individual (non-coalescible -- distinct, separately-sent) messages/second for 2 real
    // seconds -- modestly over the 50/1000ms cap, unlike SEC-08's own 500+/s shape above.
    // Violations accumulate at only ~(70-50)=20/s, well under the 50/1000ms disconnect
    // threshold, so this must NEVER disconnect.
    const start = Date.now();
    let i = 0;
    while (Date.now() - start < 2000) {
      ws.send(encodeFrame(operationToOpInsert(engine.localInsert(0, 97 + (i % 26)), 0)), { binary: true });
      i++;
      await new Promise((r) => setTimeout(r, 1000 / 70));
    }

    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(goodbyeSeen).toBe(false);

    ws.close();
    await waitForClose(ws);
  }, 10_000);
});
