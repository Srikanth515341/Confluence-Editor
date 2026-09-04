import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, RejectReason, SessionRole, type OpRejectMessage } from "@collab-editor/protocol";
import { AckBatcher } from "./ackBatcher.js";
import { ConnectionSendQueues } from "./sendQueues.js";
import { DocumentCoordinator, type CoordinatorSession } from "./documentCoordinator.js";
import { InMemoryOperationStore } from "./db/operationStore.js";
import { runOneDocument } from "./offlineWindowScheduler.js";

const CONFIG = { pendingRejectTimeoutMs: 30_000, sweepIntervalMs: 5_000 };

function buildTestSession(replicaId: number, sent: Uint8Array[]): CoordinatorSession {
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
    role: SessionRole.EDITOR,
    userId: `user-${replicaId}`,
    displayName: `Guest ${replicaId}`,
    lastPingAt: Date.now(),
    presenceStale: false,
    staleTimer: undefined,
    receivedFrameCount: 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("offlineWindowScheduler.runOneDocument (Phase 24, Engine Spec §7.6 Rule 7.2, RC-30)", () => {
  it("does NOT reject a pending operation still within the grace window", async () => {
    const coordinator = new DocumentCoordinator("doc-owc-1", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), sent);
    coordinator.join(session);

    coordinator.engine.applyRemote({
      kind: "insert",
      id: { c: 1, r: session.replicaId },
      value: 0x61,
      originLeft: { c: 99, r: 999 }, // never applied -- permanently unresolvable
      originRight: null,
      bind: false,
    });
    expect(coordinator.engine.pending).toHaveLength(1);

    runOneDocument(coordinator, CONFIG); // first sighting -- just records firstSeenAt
    expect(coordinator.engine.pending).toHaveLength(1);
    expect(sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(CONFIG.pendingRejectTimeoutMs - 1);
    runOneDocument(coordinator, CONFIG);
    expect(coordinator.engine.pending).toHaveLength(1); // still not old enough
    expect(sent).toHaveLength(0);
  });

  it("rejects a pending operation once it has been buffered longer than pendingRejectTimeoutMs, with OFFLINE_WINDOW_EXCEEDED", async () => {
    const coordinator = new DocumentCoordinator("doc-owc-2", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), sent);
    coordinator.join(session);

    const stuckId = { c: 1, r: session.replicaId };
    coordinator.engine.applyRemote({
      kind: "insert",
      id: stuckId,
      value: 0x61,
      originLeft: { c: 99, r: 999 },
      originRight: null,
      bind: false,
    });

    runOneDocument(coordinator, CONFIG); // first sighting
    await vi.advanceTimersByTimeAsync(CONFIG.pendingRejectTimeoutMs + 1);
    runOneDocument(coordinator, CONFIG); // now overdue

    expect(coordinator.engine.pending).toHaveLength(0); // Rule 7.2: explicitly evicted, not left forever
    expect(sent).toHaveLength(1);
    const msg = decodeFrame(sent[0]!, { direction: "serverOrigin" }) as OpRejectMessage;
    expect(msg.kind).toBe("opReject");
    expect(msg.rejects).toEqual([{ rejectedId: stuckId, reason: RejectReason.OFFLINE_WINDOW_EXCEEDED }]);
  });

  it("batches every overdue pending operation for one session into a SINGLE OP_REJECT frame", async () => {
    const coordinator = new DocumentCoordinator("doc-owc-3", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), sent);
    coordinator.join(session);

    const ids = [1, 2, 3].map((c) => ({ c, r: session.replicaId }));
    for (const id of ids) {
      coordinator.engine.applyRemote({
        kind: "insert",
        id,
        value: 0x61,
        originLeft: { c: 999 + id.c, r: 999 }, // each anchored to a DIFFERENT, equally-unresolvable id
        originRight: null,
        bind: false,
      });
    }
    expect(coordinator.engine.pending).toHaveLength(3);

    runOneDocument(coordinator, CONFIG);
    await vi.advanceTimersByTimeAsync(CONFIG.pendingRejectTimeoutMs + 1);
    runOneDocument(coordinator, CONFIG);

    expect(coordinator.engine.pending).toHaveLength(0);
    expect(sent).toHaveLength(1); // ONE frame, not three
    const msg = decodeFrame(sent[0]!, { direction: "serverOrigin" }) as OpRejectMessage;
    expect(msg.rejects).toHaveLength(3);
    expect(msg.rejects.map((r) => r.rejectedId)).toEqual(ids);
  });

  it("a pending operation that resolves normally (its dependency arrives) is never touched, and its tracking entry is pruned", async () => {
    const coordinator = new DocumentCoordinator("doc-owc-4", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), sent);
    coordinator.join(session);

    const anchorId = { c: 1, r: session.replicaId };
    const dependentId = { c: 2, r: session.replicaId };
    coordinator.engine.applyRemote({
      kind: "insert",
      id: dependentId,
      value: 0x62,
      originLeft: anchorId, // not applied YET -- this buffers into pending
      originRight: null,
      bind: false,
    });
    expect(coordinator.engine.pending).toHaveLength(1);
    runOneDocument(coordinator, CONFIG); // records firstSeenAt for `dependentId`

    // The dependency arrives (an entirely ordinary, momentary reorder) -- drains normally.
    coordinator.engine.applyRemote({
      kind: "insert",
      id: anchorId,
      value: 0x61,
      originLeft: null,
      originRight: null,
      bind: false,
    });
    expect(coordinator.engine.pending).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(CONFIG.pendingRejectTimeoutMs + 1);
    runOneDocument(coordinator, CONFIG); // must find nothing to reject -- it already resolved
    expect(sent).toHaveLength(0);
  });

  it("evicts (but cannot notify) an overdue pending operation whose originating session has since disconnected", async () => {
    const coordinator = new DocumentCoordinator("doc-owc-5", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), sent);
    coordinator.join(session);
    coordinator.engine.applyRemote({
      kind: "insert",
      id: { c: 1, r: session.replicaId },
      value: 0x61,
      originLeft: { c: 99, r: 999 },
      originRight: null,
      bind: false,
    });
    coordinator.leave(session.sessionId); // the session is gone before the sweep ever fires

    runOneDocument(coordinator, CONFIG);
    await vi.advanceTimersByTimeAsync(CONFIG.pendingRejectTimeoutMs + 1);
    runOneDocument(coordinator, CONFIG);

    expect(coordinator.engine.pending).toHaveLength(0); // still evicted -- Rule 7.2 forbids leaving it forever
    expect(sent).toHaveLength(0); // but nobody was there to receive the OP_REJECT
  });
});
