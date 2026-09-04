import { describe, expect, it } from "vitest";
import {
  CLIENT_CAP_HAS_RESIDENT_ENGINE,
  operationToOpInsert,
  SessionRole,
  SnapshotForm,
  SyncMode,
  type HelloMessage,
  type OpsMessage,
} from "@collab-editor/protocol";
import { Engine, type Operation } from "@collab-editor/engine";
import { InMemoryOperationStore } from "./db/operationStore.js";
import {
  assertSnapshotFormAllowed,
  buildAlreadyHaveMessage,
  buildCatchupMessages,
  buildSnapshotMessage,
  chunkCatchupOperations,
  decideSyncMode,
} from "./handshake.js";
import { DocumentCoordinator, type CoordinatorSession } from "./documentCoordinator.js";
import { processIncomingOperation } from "./writePath.js";
import { ConnectionSendQueues } from "./sendQueues.js";
import { AckBatcher } from "./ackBatcher.js";

describe("assertSnapshotFormAllowed (API Spec §3.6.3)", () => {
  it("rejects form: PLAIN_TEXT for an EDITOR role — in code, not just by convention", () => {
    expect(() => assertSnapshotFormAllowed(SnapshotForm.PLAIN_TEXT, SessionRole.EDITOR)).toThrow();
  });

  it("rejects form: PLAIN_TEXT for an OWNER role too", () => {
    expect(() => assertSnapshotFormAllowed(SnapshotForm.PLAIN_TEXT, SessionRole.OWNER)).toThrow();
  });

  it("allows form: PLAIN_TEXT for a VIEWER role", () => {
    expect(() =>
      assertSnapshotFormAllowed(SnapshotForm.PLAIN_TEXT, SessionRole.VIEWER),
    ).not.toThrow();
  });

  it("allows form: STRUCTURE for every role", () => {
    expect(() =>
      assertSnapshotFormAllowed(SnapshotForm.STRUCTURE, SessionRole.VIEWER),
    ).not.toThrow();
    expect(() =>
      assertSnapshotFormAllowed(SnapshotForm.STRUCTURE, SessionRole.EDITOR),
    ).not.toThrow();
    expect(() =>
      assertSnapshotFormAllowed(SnapshotForm.STRUCTURE, SessionRole.OWNER),
    ).not.toThrow();
  });
});

describe("buildSnapshotMessage", () => {
  it("always builds form: STRUCTURE this phase, since every session's role is hardcoded to EDITOR", () => {
    const coordinator = new DocumentCoordinator("doc-1", new InMemoryOperationStore());
    const snapshot = buildSnapshotMessage(coordinator);
    expect(snapshot.form).toBe(SnapshotForm.STRUCTURE);
  });
});

function baseHello(overrides: Partial<HelloMessage> = {}): HelloMessage {
  return {
    kind: "hello",
    documentId: "doc-1",
    ticket: new Uint8Array(),
    lastServerSeq: 0,
    unacked: [],
    clientCapabilities: 0,
    ...overrides,
  };
}

describe("decideSyncMode (Phase 23, API Spec §3.6.2)", () => {
  it("SNAPSHOT for a fresh client (lastServerSeq: 0), regardless of the resident-engine bit", () => {
    expect(decideSyncMode(baseHello({ lastServerSeq: 0 }), 5n)).toBe(SyncMode.SNAPSHOT);
    expect(
      decideSyncMode(
        baseHello({ lastServerSeq: 0, clientCapabilities: CLIENT_CAP_HAS_RESIDENT_ENGINE }),
        5n,
      ),
    ).toBe(SyncMode.SNAPSHOT);
  });

  it("SNAPSHOT for a client with NO resident engine, even with a nonzero lastServerSeq (durable meta restored, but no content to delta onto)", () => {
    expect(decideSyncMode(baseHello({ lastServerSeq: 3, clientCapabilities: 0 }), 5n)).toBe(
      SyncMode.SNAPSHOT,
    );
  });

  it("SNAPSHOT for a client claiming a lastServerSeq AHEAD of currentSeq (defensive self-healing, not trusted or rejected)", () => {
    expect(
      decideSyncMode(
        baseHello({ lastServerSeq: 99, clientCapabilities: CLIENT_CAP_HAS_RESIDENT_ENGINE }),
        5n,
      ),
    ).toBe(SyncMode.SNAPSHOT);
  });

  it("ALREADY_CURRENT when a resident-engine client's lastServerSeq already equals currentSeq", () => {
    expect(
      decideSyncMode(
        baseHello({ lastServerSeq: 5, clientCapabilities: CLIENT_CAP_HAS_RESIDENT_ENGINE }),
        5n,
      ),
    ).toBe(SyncMode.ALREADY_CURRENT);
  });

  it("CATCHUP when a resident-engine client trails currentSeq by a real amount", () => {
    expect(
      decideSyncMode(
        baseHello({ lastServerSeq: 2, clientCapabilities: CLIENT_CAP_HAS_RESIDENT_ENGINE }),
        5n,
      ),
    ).toBe(SyncMode.CATCHUP);
  });
});

describe("chunkCatchupOperations (Phase 23, API Spec §3.6.5 — mandatory chunking)", () => {
  function fakeInserts(count: number): Array<{ seq: bigint; op: Operation }> {
    const engine = new Engine(1);
    const out: Array<{ seq: bigint; op: Operation }> = [];
    for (let i = 0; i < count; i++) {
      out.push({ seq: BigInt(i + 1), op: engine.localInsert(i, 0x61) });
    }
    return out;
  }

  it("splits at the 256-operation boundary, never fewer chunks than required", () => {
    const chunks = chunkCatchupOperations(fakeInserts(300));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.ops).toHaveLength(256);
    expect(chunks[1]!.ops).toHaveLength(44);
  });

  it("each chunk's throughSeq is its own last operation's seq", () => {
    const chunks = chunkCatchupOperations(fakeInserts(300));
    expect(chunks[0]!.throughSeq).toBe(256);
    expect(chunks[1]!.throughSeq).toBe(300);
  });

  it("a range that fits in one chunk produces exactly one chunk", () => {
    const chunks = chunkCatchupOperations(fakeInserts(10));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.ops).toHaveLength(10);
  });

  it("an empty range produces zero chunks", () => {
    expect(chunkCatchupOperations([])).toEqual([]);
  });
});

function buildTestSession(replicaId: number): CoordinatorSession {
  return {
    sessionId: `session-${replicaId}`,
    replicaId,
    queues: new ConnectionSendQueues(
      () => Promise.resolve(),
      () => false,
    ),
    ackBatcher: new AckBatcher(() => {}),
    role: SessionRole.EDITOR,
    userId: `user-${replicaId}`,
    displayName: `Guest ${replicaId}`,
    lastPingAt: Date.now(),
    presenceStale: false,
    staleTimer: undefined,
    receivedFrameCount: 0,
  };
}

describe("buildCatchupMessages (Phase 23, API Spec §3.6.4-§3.6.6)", () => {
  it("returns exactly the delta range (fromSeq, currentSeq], as one or more chunks", async () => {
    const coordinator = new DocumentCoordinator("doc-catchup-1", new InMemoryOperationStore());
    await coordinator.ready;
    const session = buildTestSession(coordinator.allocateReplicaId());
    coordinator.join(session);
    const engine = new Engine(session.replicaId);
    for (let i = 0; i < 5; i++) {
      const op = engine.localInsert(i, 0x61 + i);
      const msg: OpsMessage = operationToOpInsert(op, 0);
      await processIncomingOperation({ coordinator, session, msg });
    }
    expect(coordinator.currentSeq).toBe(5n);

    const { begin, chunks, end } = await buildCatchupMessages(coordinator, 2);
    expect(begin).toEqual({ kind: "catchupBegin", fromSeq: 2, toSeq: 5, totalOps: 3 });
    expect(end).toEqual({ kind: "catchupEnd", toSeq: 5, totalOps: 3 });
    const allOps = chunks.flatMap((c) => c.ops);
    expect(allOps).toHaveLength(3);
    expect(allOps.map((op) => (op.kind === "insert" ? op.value : null))).toEqual([
      0x61 + 2,
      0x61 + 3,
      0x61 + 4,
    ]);
  });
});

describe("buildAlreadyHaveMessage (Phase 23, API Spec §3.6.7)", () => {
  it("reports empty when the client has no unacked stamps", async () => {
    const coordinator = new DocumentCoordinator("doc-ah-1", new InMemoryOperationStore());
    await coordinator.ready;
    const msg = await buildAlreadyHaveMessage(coordinator, []);
    expect(msg).toEqual({ kind: "alreadyHave", alreadyHave: [] });
  });

  it("reports exactly the stamps that are ALREADY durably committed, never ones that aren't", async () => {
    const coordinator = new DocumentCoordinator("doc-ah-2", new InMemoryOperationStore());
    await coordinator.ready;
    const session = buildTestSession(coordinator.allocateReplicaId());
    coordinator.join(session);
    const engine = new Engine(session.replicaId);
    const committedOp = engine.localInsert(0, 0x68);
    await processIncomingOperation({
      coordinator,
      session,
      msg: operationToOpInsert(committedOp, 0),
    });
    const neverSentOp = engine.localInsert(1, 0x69); // minted locally, never sent through the write path

    const msg = await buildAlreadyHaveMessage(coordinator, [committedOp.id, neverSentOp.id]);
    expect(msg.alreadyHave).toEqual([committedOp.id]);
  });
});
