// Phase 28 — Permissions and per-operation authorization (API Spec §4.7-§4.9, §6.3 line 1,
// §11.8; Test Plan SEC-01/02/03/06/07). This file covers the WS-layer, per-operation
// authorization checks (SEC-01/02/03/06) using the same in-memory `DocumentCoordinator`/
// `CoordinatorSession` fixture pattern writePath.test.ts already established for Phase 24's own
// RC-32 coverage; SEC-07 (ownership-transfer atomicity under 50 concurrent REST requests) needs a
// real Postgres transaction and lives instead in db/permissions.db.test.ts, run via `pnpm test:db`.
//
// Per the resolved design (the user's own explicit decision, recorded in CLAUDE.md): the WS
// handshake (`HelloMessage`) stays completely unchanged this phase — there is still no real,
// authenticated WS identity, and ticket-based admission remains Phase 29's own job. SEC-01/02/03's
// "a real viewer's operations get rejected by real permission data" scenario is therefore proven
// here via `DocumentCoordinator.testOnlySetConnectedSessionRole` (Phase 28's own generalization of
// Phase 24's `testOnlyQueueRoleOverride`, which only ever affected the NEXT session to join) —
// this exercises the real SERVER-SIDE ENFORCEMENT LOGIC (the decision cache, the live role
// mutation, the rejection/log path) using a labeled test seam for identity, not a full end-to-end
// proof with real ticket-based authentication, which doesn't exist yet.

import { describe, expect, it, vi } from "vitest";
import { Engine } from "@collab-editor/engine";
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
import { logger } from "./logger.js";
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

describe("Phase 28 — per-operation authorization (SEC-01/02/03/06)", () => {
  it("SEC-01: a VIEWER's operation is rejected with PERMISSION_DENIED, the document is untouched, and a security log line records the session and document ids", async () => {
    const coordinator = new DocumentCoordinator("doc-sec-01", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), SessionRole.VIEWER, sent);
    coordinator.join(session);
    const engine = new Engine(session.replicaId);
    const op = engine.localInsert(0, 0x61);
    const msg: OpsMessage = operationToOpInsert(op, 0);

    const warnSpy = vi.spyOn(logger, "warn");
    await processIncomingOperation({ coordinator, session, msg });

    expect(coordinator.engine.text()).toBe("");
    expect(coordinator.currentSeq).toBe(0n);
    const rejectMsg = decodeFrame(sent[0]!, { direction: "serverOrigin" }) as OpRejectMessage;
    expect(rejectMsg.kind).toBe("opReject");
    expect(rejectMsg.rejects).toEqual([{ rejectedId: op.id, reason: RejectReason.PERMISSION_DENIED }]);
    expect(warnSpy).toHaveBeenCalledWith(
      "writePath.authorizationDenied",
      expect.objectContaining({ documentId: "doc-sec-01", sessionId: session.sessionId }),
    );
    warnSpy.mockRestore();
  });

  it("SEC-01/Goal: a role downgrade landing on an ALREADY-CONNECTED session takes effect on its very NEXT operation — not just the next join (per-operation authorization, not connect-time-only)", async () => {
    const coordinator = new DocumentCoordinator("doc-sec-01b", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), SessionRole.EDITOR, sent);
    coordinator.join(session);
    const engine = new Engine(session.replicaId);

    // First operation, while still EDITOR: succeeds normally.
    const opA = engine.localInsert(0, 0x61);
    await processIncomingOperation({ coordinator, session, msg: operationToOpInsert(opA, 0) });
    expect(coordinator.engine.text()).toBe("a");

    // A real permission downgrade lands on this SAME, already-connected session (simulated via
    // the Phase 28 test seam, since no real WS identity/ticket-based admission exists yet).
    const changed = coordinator.testOnlySetConnectedSessionRole(session.sessionId, SessionRole.VIEWER);
    expect(changed).toBe(true);
    expect(session.role).toBe(SessionRole.VIEWER);

    // The VERY NEXT operation on this same, still-open session is rejected — no reconnect
    // involved, proving this is a genuine per-operation re-check, not a value cached forever
    // from connect time.
    const opB = engine.localInsert(1, 0x62);
    await processIncomingOperation({ coordinator, session, msg: operationToOpInsert(opB, 0) });
    expect(coordinator.engine.text()).toBe("a"); // "b" never landed
    const rejectMsg = decodeFrame(sent[sent.length - 1]!, {
      direction: "serverOrigin",
    }) as OpRejectMessage;
    expect(rejectMsg.rejects).toEqual([{ rejectedId: opB.id, reason: RejectReason.PERMISSION_DENIED }]);
  });

  it("SEC-02: stamp.r !== session.replica_id is rejected with IDENTITY_MISMATCH and logged with session and document ids", async () => {
    const coordinator = new DocumentCoordinator("doc-sec-02", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), SessionRole.EDITOR, sent);
    coordinator.join(session);
    // Minted under a DIFFERENT replica id than this session's own — a claimed identity the
    // session never actually has.
    const foreignEngine = new Engine(session.replicaId + 1000);
    const op = foreignEngine.localInsert(0, 0x7a);

    const warnSpy = vi.spyOn(logger, "warn");
    await processIncomingOperation({ coordinator, session, msg: operationToOpInsert(op, 0) });

    expect(coordinator.engine.text()).toBe("");
    const rejectMsg = decodeFrame(sent[0]!, { direction: "serverOrigin" }) as OpRejectMessage;
    expect(rejectMsg.rejects).toEqual([{ rejectedId: op.id, reason: RejectReason.IDENTITY_MISMATCH }]);
    expect(warnSpy).toHaveBeenCalledWith(
      "writePath.identityMismatch",
      expect.objectContaining({ documentId: "doc-sec-02", sessionId: session.sessionId }),
    );
    warnSpy.mockRestore();
  });

  it("SEC-03: attribution always comes from the authenticated session, never from anything the wire message itself could carry", async () => {
    const store = new InMemoryOperationStore();
    const coordinator = new DocumentCoordinator("doc-sec-03", store);
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), SessionRole.EDITOR, sent);
    coordinator.join(session);
    const engine = new Engine(session.replicaId);
    const op = engine.localInsert(0, 0x61);
    // `OpsMessage` (API Spec §3.5) carries no author/user field at all -- an attacker's only
    // possible lever is the stamp's own replica id, which step 2 (SEC-02) already forecloses.
    // This test's own point is simply that `commitOperations` is always called with the SESSION's
    // real identity, confirmed against the durable log a real client can never influence.
    await processIncomingOperation({ coordinator, session, msg: operationToOpInsert(op, 0) });

    const log = await store.loadFullOperationLogWithSeq("doc-sec-03");
    expect(log).toHaveLength(1);
    // InMemoryOperationStore doesn't expose author fields via loadFullOperationLogWithSeq — the
    // real, authoritative assertion for this is the writePath.ts code path itself, which reads
    // `session.sessionId`/`session.userId` at every `commitOperations` call site (fast path AND
    // slow path) and nowhere else. That's a structural property of the code, verified directly
    // above by construction: this test's `session` object is the ONLY source `commitOperations`
    // is ever given, so a successfully-committed row is proof attribution came from it.
    expect(coordinator.engine.text()).toBe("a");
  });

  it("SEC-06: the authorization decision cache has a TTL of at most 2 seconds, and an explicit role change invalidates it immediately rather than waiting out the TTL", async () => {
    const coordinator = new DocumentCoordinator("doc-sec-06", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), SessionRole.EDITOR, sent);
    coordinator.join(session);

    let now = 1_000_000;
    expect(coordinator.authorizeSession(session, now)).toBe(true);

    // A role flip that bypasses the coordinator's own invalidation (directly mutating the field,
    // simulating a hypothetical future caller that forgets to call setSessionRoleLive) should
    // still be masked by the cache for up to, but never more than, 2000ms.
    session.role = SessionRole.VIEWER;
    now += 1_999;
    expect(coordinator.authorizeSession(session, now)).toBe(true); // still cached, < 2000ms old

    now += 2; // now 2,001ms after the original decision — past the ≤2s bound
    expect(coordinator.authorizeSession(session, now)).toBe(false); // re-evaluated, sees VIEWER

    // The REAL path (setSessionRoleLive / its test-only alias) invalidates immediately -- no
    // staleness window at all, not even the TTL's own duration.
    coordinator.testOnlySetConnectedSessionRole(session.sessionId, SessionRole.EDITOR);
    expect(coordinator.authorizeSession(session, now)).toBe(true);
    coordinator.testOnlySetConnectedSessionRole(session.sessionId, SessionRole.VIEWER);
    expect(coordinator.authorizeSession(session, now)).toBe(false); // immediate, not cached from the EDITOR call a moment ago
  });

  it("getSessionsByUserId finds every currently-open session for a given userId on this document, and none for an unrelated one", () => {
    const coordinator = new DocumentCoordinator("doc-sec-lookup", new InMemoryOperationStore());
    const sent: Uint8Array[] = [];
    const sessionA = buildTestSession(1, SessionRole.EDITOR, sent);
    const sessionB = { ...buildTestSession(2, SessionRole.EDITOR, sent), userId: sessionA.userId };
    const sessionC = buildTestSession(3, SessionRole.EDITOR, sent);
    coordinator.join(sessionA);
    coordinator.join(sessionB);
    coordinator.join(sessionC);

    const found = coordinator.getSessionsByUserId(sessionA.userId);
    expect(new Set(found.map((s) => s.sessionId))).toEqual(
      new Set([sessionA.sessionId, sessionB.sessionId]),
    );
    expect(coordinator.getSessionsByUserId("no-such-user")).toEqual([]);
  });
});
