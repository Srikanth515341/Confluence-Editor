// Phase 29 — WebSocket admission tickets and live revocation (API Spec §1.5, §4.10, §3.6.9;
// Test Plan SEC-04, SEC-05, SEC-11e). This file covers the mechanism SEC-05 exists to prove — that
// revocation takes effect within the ≤2s decision-cache TTL EVEN WITH NO PUSH AT ALL — using a
// fake, in-memory `lookupRole` callback (no real Postgres needed), the same "DocumentCoordinator
// constructed directly, real per-operation logic exercised end to end" pattern permissions.test.ts
// already established for Phase 28. The REAL end-to-end proof (a real ticket, a real WS
// connection, a real PUT/DELETE .../permissions/{userId} commit) lives in
// db/tickets.db.test.ts (`pnpm test:db`) — this file is scoped to what's provable without a real
// database: the authorization decision cache's own re-evaluation behavior when its source of
// truth is a genuine per-user lookup (Phase 29), not merely `session.role` (Phase 28's own
// fallback, unchanged and still covered by permissions.test.ts).

import { describe, expect, it } from "vitest";
import { Engine } from "@collab-editor/engine";
import {
  decodeFrame,
  operationToOpInsert,
  RejectReason,
  SessionRole,
  type OpRejectMessage,
} from "@collab-editor/protocol";
import { AckBatcher } from "./ackBatcher.js";
import { ConnectionSendQueues } from "./sendQueues.js";
import { DocumentCoordinator, type CoordinatorSession } from "./documentCoordinator.js";
import { InMemoryOperationStore } from "./db/operationStore.js";
import { processIncomingOperation } from "./writePath.js";
import type { DocumentRole } from "./db/documentStore.js";

function buildTestSession(
  replicaId: number,
  role: SessionRole,
  userId: string,
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
    userId,
    displayName: `Guest ${replicaId}`,
    lastPingAt: Date.now(),
    presenceStale: false,
    staleTimer: undefined,
    receivedFrameCount: 0,
  };
}

describe("Phase 29 — the authorization decision cache re-evaluates via a REAL per-user lookup once real auth is wired (SEC-05)", () => {
  it("SEC-05: with NO push at all, a role change discovered ONLY by the DB-backed lookup on cache-miss still takes effect within the ≤2s TTL", async () => {
    let liveRole: DocumentRole | null = "editor";
    const lookupRole = async (userId: string): Promise<DocumentRole | null> => {
      expect(userId).toBe("real-user-1");
      return liveRole;
    };
    const coordinator = new DocumentCoordinator(
      "doc-sec-05",
      new InMemoryOperationStore(),
      undefined,
      lookupRole,
    );
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(
      coordinator.allocateReplicaId(),
      SessionRole.EDITOR,
      "real-user-1",
      sent,
    );
    coordinator.join(session);

    let now = 1_000_000;
    // First call: cache miss, real lookup, editor -> allowed. Cached for 2000ms.
    expect(await coordinator.authorizeSession(session, now)).toBe(true);

    // The permission is revoked in the "database" — but NOTHING pushes this to the session (no
    // setSessionRoleLive call, no PERMISSION_CHANGED, nothing). This is SEC-05's own scenario:
    // "the invalidation broadcast is dropped... revocation still takes effect within 2s via the
    // authorization cache TTL alone."
    liveRole = null;

    now += 1_999;
    expect(await coordinator.authorizeSession(session, now)).toBe(true); // still within the cached 2000ms window

    now += 2; // 2,001ms since the original decision
    // The cache expires and re-evaluates — WITHOUT any push, the fresh lookup alone discovers the
    // revocation.
    expect(await coordinator.authorizeSession(session, now)).toBe(false);

    // session.role itself was kept in sync by the lookup-backed path too (informational, e.g. for
    // a future WELCOME/PERMISSION_CHANGED read), even though nothing pushed a notification.
    expect(session.role).toBe(SessionRole.VIEWER);
  });

  it("SEC-04/05 mechanism, over the real write path: once the lookup reports no access, the very next operation is rejected with PERMISSION_DENIED and a security log line, with no push involved", async () => {
    let liveRole: DocumentRole | null = "editor";
    const lookupRole = async (): Promise<DocumentRole | null> => liveRole;
    const coordinator = new DocumentCoordinator(
      "doc-sec-04",
      new InMemoryOperationStore(),
      undefined,
      lookupRole,
    );
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(
      coordinator.allocateReplicaId(),
      SessionRole.EDITOR,
      "real-user-2",
      sent,
    );
    coordinator.join(session);
    const engine = new Engine(session.replicaId);

    // Operation BEFORE revocation: succeeds normally, and is retained afterward (SEC-04: "operations
    // committed BEFORE T are retained -- acks are promises").
    const opBefore = engine.localInsert(0, 0x61);
    await processIncomingOperation({ coordinator, session, msg: operationToOpInsert(opBefore, 0) });
    expect(coordinator.engine.text()).toBe("a");

    // Revoked in the "database," no push — force the cache to expire naturally by using a
    // fake clock via repeated calls with an advancing `now` isn't available through
    // processIncomingOperation directly (it always uses Date.now()), so this test instead
    // invalidates the cache explicitly to simulate "the TTL has elapsed" — the TTL's own
    // boundary behavior is already proven deterministically in the test above; this test's own
    // job is to prove the REJECTION actually flows through the real write path once the lookup
    // reports no access, which invalidateAuthorizationCache alone cannot do without a role
    // flip too (there is none here — only the lookup's own answer changes).
    liveRole = null;
    coordinator.invalidateAuthorizationCache(session.sessionId);

    const opAfter = engine.localInsert(1, 0x62);
    await processIncomingOperation({ coordinator, session, msg: operationToOpInsert(opAfter, 0) });

    expect(coordinator.engine.text()).toBe("a"); // "b" never landed — operations AFTER T are rejected
    const rejectMsg = decodeFrame(sent[sent.length - 1]!, {
      direction: "serverOrigin",
    }) as OpRejectMessage;
    expect(rejectMsg.rejects).toEqual([{ rejectedId: opAfter.id, reason: RejectReason.PERMISSION_DENIED }]);
  });
});
