// Phase 24's new "step 1: authorize" check (API Spec §5.4/§5.5, Test Plan RC-32) — a real,
// if minimal, session-role check ahead of the full Phase 26-30 permission system. Everything
// else in writePath.ts already has direct coverage via gateway.test.ts (Phase 8/16's identity
// check) and packages/server/src/db/durability.db.test.ts (DUR-04's own ordering guarantee);
// this file is scoped to what's new this phase.

import { describe, expect, it } from "vitest";
import { Engine, type Operation } from "@collab-editor/engine";
import {
  decodeFrame,
  operationToOpInsert,
  RejectReason,
  SessionRole,
  type OpRejectMessage,
  type OpsMessage,
} from "@collab-editor/protocol";
import { AckBatcher } from "./ackBatcher.js";
import { ConnectionSendQueues } from "./sendQueues.js";
import { DocumentCoordinator, type CoordinatorSession } from "./documentCoordinator.js";
import { InMemoryOperationStore } from "./db/operationStore.js";
import { processIncomingOperation } from "./writePath.js";

function buildTestSession(
  replicaId: number,
  role: SessionRole,
  sent: Uint8Array[],
): CoordinatorSession {
  return {
    sessionId: `session-${replicaId}`,
    replicaId,
    queues: new ConnectionSendQueues(
      (frame) => {
        sent.push(frame);
        return Promise.resolve();
      },
      () => false,
    ),
    ackBatcher: new AckBatcher(() => {}),
    role,
    userId: `user-${replicaId}`,
    displayName: `Guest ${replicaId}`,
    lastPingAt: Date.now(),
    presenceStale: false,
    staleTimer: undefined,
    receivedFrameCount: 0,
  };
}

describe("processIncomingOperation — step 1 authorize (Phase 24, RC-32)", () => {
  it("an EDITOR session's operation is applied, committed, and never rejected for role reasons", async () => {
    const coordinator = new DocumentCoordinator("doc-wp-1", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), SessionRole.EDITOR, sent);
    coordinator.join(session);
    const engine = new Engine(session.replicaId);
    const op = engine.localInsert(0, 0x61);
    const msg: OpsMessage = operationToOpInsert(op, 0);

    await processIncomingOperation({ coordinator, session, msg });

    expect(coordinator.engine.text()).toBe("a");
    expect(sent.some((f) => decodeFrame(f, { direction: "serverOrigin" }).kind === "opReject")).toBe(
      false,
    );
  });

  it("a VIEWER session's operation is rejected with PERMISSION_DENIED, naming its own stamp, and never applied to the document", async () => {
    const coordinator = new DocumentCoordinator("doc-wp-2", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), SessionRole.VIEWER, sent);
    coordinator.join(session);
    const engine = new Engine(session.replicaId);
    const op = engine.localInsert(0, 0x61);
    const msg: OpsMessage = operationToOpInsert(op, 0);

    await processIncomingOperation({ coordinator, session, msg });

    expect(coordinator.engine.text()).toBe(""); // never reached applyRemote at all
    expect(coordinator.currentSeq).toBe(0n); // never consumed a seq either
    expect(sent).toHaveLength(1);
    const rejectMsg = decodeFrame(sent[0]!, { direction: "serverOrigin" }) as OpRejectMessage;
    expect(rejectMsg.kind).toBe("opReject");
    expect(rejectMsg.rejects).toEqual([{ rejectedId: op.id, reason: RejectReason.PERMISSION_DENIED }]);
  });

  it("a VIEWER session's whole run/batch is rejected in ONE response, naming every operation's own stamp (RC-32: '400 operations ... in one response')", async () => {
    const coordinator = new DocumentCoordinator("doc-wp-3", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), SessionRole.VIEWER, sent);
    coordinator.join(session);
    const engine = new Engine(session.replicaId);
    const ops: Operation[] = [];
    let at = 0;
    for (const ch of "hello") {
      ops.push(engine.localInsert(at, ch.codePointAt(0)!));
      at += 1;
    }
    const first = ops[0]!;
    if (first.kind !== "insert") {
      throw new Error("unreachable — every op here is an insert");
    }
    const runMsg: OpsMessage = {
      kind: "opInsertRun",
      seq: 0,
      firstId: first.id,
      originLeft: first.originLeft,
      originRight: first.originRight,
      bind: false,
      values: Array.from("hello", (c) => c.codePointAt(0)!),
    };

    await processIncomingOperation({ coordinator, session, msg: runMsg });

    expect(coordinator.engine.text()).toBe("");
    expect(sent).toHaveLength(1); // ONE OP_REJECT frame for all 5, not 5 separate frames
    const rejectMsg = decodeFrame(sent[0]!, { direction: "serverOrigin" }) as OpRejectMessage;
    expect(rejectMsg.rejects).toHaveLength(5);
    expect(rejectMsg.rejects.map((r) => r.rejectedId)).toEqual(ops.map((op) => op.id));
    expect(rejectMsg.rejects.every((r) => r.reason === RejectReason.PERMISSION_DENIED)).toBe(true);
  });
});
