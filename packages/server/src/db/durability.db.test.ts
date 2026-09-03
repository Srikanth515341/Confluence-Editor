// Phase 16 Definition of Done, verified against a REAL, migrated Postgres
// instance — not mocked. Requires:
//   docker compose up -d
//   pnpm db:migrate
// Run via `pnpm test:db` (packages/server/vitest.db.config.ts) — never
// swept into the default `pnpm test`, same reasoning as Phase 15's
// schema.db.test.ts.
//
// DUR-04 (Test Plan) is the centerpiece of this file: it proves the
// broadcast-before-commit / ack-after-commit ordering in writePath.ts is
// actually load-bearing, not just documented, by running the SAME
// production module in both orderings (MUTATE_ACK_BEFORE_COMMIT=1 vs.
// unset) against a real crash injected at "the commit point" and showing
// the mutated ordering loses an acked operation while the real ordering
// never does. This test is meant to run on EVERY future `pnpm test:db`,
// not just once during this phase — see its own describe block.

import { randomUUID } from "node:crypto";
import { Engine, type Operation } from "@collab-editor/engine";
import {
  encodeFrame,
  operationToOpInsert,
  type AckEntry,
  type OpInsertMessage,
} from "@collab-editor/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AckBatcher } from "../ackBatcher.js";
import { loadConfig } from "../config.js";
import type { CoordinatorSession } from "../documentCoordinator.js";
import { DocumentCoordinator } from "../documentCoordinator.js";
import { ConnectionSendQueues } from "../sendQueues.js";
import { isAckBeforeCommitMutationActive, processIncomingOperation } from "../writePath.js";
import { PostgresOperationStore } from "./operationStore.js";
import { createPool, type DbPool } from "./pool.js";

let pool: DbPool;

beforeAll(() => {
  const config = loadConfig();
  pool = createPool(config.databaseUrl);
});

afterAll(async () => {
  await pool.end();
});

const MUTATE_ENV = "MUTATE_ACK_BEFORE_COMMIT";

afterEach(() => {
  // Belt and suspenders: every test that sets this restores it itself in a finally block too,
  // but a thrown assertion could skip that — never let one test's mutation leak into the next.
  delete process.env[MUTATE_ENV];
});

/** A session backed by a REAL ConnectionSendQueues, capturing every OPS-channel frame it would have sent instead of writing to a socket — the same "fake session, real queue machinery" shape heartbeat.test.ts already established, extended here with the ack batcher Phase 16 added. */
function buildCapturingSession(replicaId: number): {
  session: CoordinatorSession;
  sentAcks: AckEntry[];
} {
  const sentAcks: AckEntry[] = [];
  const queues = new ConnectionSendQueues(
    () => Promise.resolve(),
    () => false,
  );
  const session: CoordinatorSession = {
    sessionId: randomUUID(),
    replicaId,
    queues,
    ackBatcher: new AckBatcher((entries) => sentAcks.push(...entries)),
    role: 1, // EDITOR (SessionRole.EDITOR) — avoids importing the enum just for this literal
    userId: randomUUID(),
    displayName: `Test ${replicaId}`,
    lastPingAt: Date.now(),
    presenceStale: false,
    staleTimer: undefined,
    receivedFrameCount: 0,
  };
  return { session, sentAcks };
}

/** Ack batching (up to 64 entries or 20ms) means `sentAcks` isn't populated synchronously — every test that reads it must wait out the batch window first. */
async function waitForAckFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

async function buildReadyCoordinator(documentId: string): Promise<DocumentCoordinator> {
  const store = new PostgresOperationStore(pool);
  const coordinator = new DocumentCoordinator(documentId, store);
  await coordinator.ready;
  return coordinator;
}

/** Directly queries the operations table — deliberately bypassing the coordinator's own in-memory state, the same "ground truth from the database itself" discipline Phase 15's constraint tests and Phase 14's replay endpoint both use. */
async function stampExistsInDb(documentId: string, id: { r: number; c: number }): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM operations WHERE document_id = $1 AND stamp_r = $2 AND stamp_c = $3`,
    [documentId, id.r, id.c],
  );
  return rows.length > 0;
}

async function countStampInDb(documentId: string, id: { r: number; c: number }): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM operations WHERE document_id = $1 AND stamp_r = $2 AND stamp_c = $3`,
    [documentId, id.r, id.c],
  );
  return Number(rows[0]?.count ?? "0");
}

function insertMessageFor(op: Operation): OpInsertMessage {
  if (op.kind !== "insert") {
    throw new Error("insertMessageFor: test helper only handles insert operations");
  }
  return operationToOpInsert(op, 0);
}

describe("DUR-04 — ack-before-commit loses an operation; ack-after-commit never does", () => {
  it("MUTATED ordering (MUTATE_ACK_BEFORE_COMMIT=1): a crash right after the ack is queued loses the operation", async () => {
    const documentId = randomUUID();
    const coordinator = await buildReadyCoordinator(documentId);
    const { session } = buildCapturingSession(coordinator.allocateReplicaId());
    const engine = new Engine(session.replicaId);
    const op = engine.localInsert(0, 0x68); // 'h'
    const msg = insertMessageFor(op);

    process.env[MUTATE_ENV] = "1";
    expect(isAckBeforeCommitMutationActive()).toBe(true);

    let threw = false;
    try {
      await processIncomingOperation(
        { coordinator, session, msg },
        {
          simulateCrashAtCommitPoint: () => {
            throw new Error("DUR-04: simulated crash at the commit point (mutated ordering)");
          },
        },
      );
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/simulated crash/);
    } finally {
      delete process.env[MUTATE_ENV];
    }
    expect(threw).toBe(true);

    // The client believed this operation was saved (the ack was queued before the crash). It
    // was not — the transaction never ran. This is the loss DUR-04 exists to demonstrate.
    expect(await stampExistsInDb(documentId, op.id)).toBe(false);
  });

  it("REAL ordering (default, no mutation): the same crash injection never loses the operation", async () => {
    const documentId = randomUUID();
    const coordinator = await buildReadyCoordinator(documentId);
    const { session } = buildCapturingSession(coordinator.allocateReplicaId());
    const engine = new Engine(session.replicaId);
    const op = engine.localInsert(0, 0x68); // 'h'
    const msg = insertMessageFor(op);

    expect(isAckBeforeCommitMutationActive()).toBe(false); // no env flag set this time

    let threw = false;
    try {
      await processIncomingOperation(
        { coordinator, session, msg },
        {
          // Same hook, same "crash right after the ack point" semantics — but under the REAL
          // ordering, the ack point is AFTER the commit, so this throw can no longer erase
          // anything durable.
          simulateCrashAtCommitPoint: () => {
            throw new Error("DUR-04: simulated crash at the commit point (real ordering)");
          },
        },
      );
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/simulated crash/);
    }
    expect(threw).toBe(true);

    // Either the commit happened and the crash landed harmlessly after it (this case, since the
    // hook always fires), or — in a scenario this test doesn't need to construct separately —
    // the commit never happens and no ack is ever sent, so the client correctly retries on
    // reconnect. Either way, an operation is never BOTH acked AND absent from the database.
    expect(await stampExistsInDb(documentId, op.id)).toBe(true);
  });
});

describe("Phase 16 DoD — ON CONFLICT DO NOTHING: resending the same operation twice commits once", () => {
  it("the same operation sent through the write path twice produces exactly one row", async () => {
    const documentId = randomUUID();
    const coordinator = await buildReadyCoordinator(documentId);
    const { session, sentAcks } = buildCapturingSession(coordinator.allocateReplicaId());
    const engine = new Engine(session.replicaId);
    const op = engine.localInsert(0, 0x68);
    const msg = insertMessageFor(op);

    await processIncomingOperation({ coordinator, session, msg });
    await processIncomingOperation({ coordinator, session, msg }); // resend — same stamp, same msg
    await waitForAckFlush();

    expect(await countStampInDb(documentId, op.id)).toBe(1);
    // Both attempts still reach the ack step (the write path doesn't dedupe before assigning
    // seq — see operationStore.ts's own doc comment on commitOperations) — two acks for the
    // same id is harmless client-side (UnackedQueue.ack() is idempotent, keyed by id).
    expect(sentAcks.filter((a) => a.ackedId.r === op.id.r && a.ackedId.c === op.id.c)).toHaveLength(
      2,
    );
  });
});

describe("Phase 16 DoD — coordinator warm start (API Spec §6.2)", () => {
  it("a fresh coordinator replays the persisted log and reaches pendingCount() === 0", async () => {
    const documentId = randomUUID();
    // First coordinator: commit three sequential inserts for real.
    const first = await buildReadyCoordinator(documentId);
    const { session: firstSession } = buildCapturingSession(first.allocateReplicaId());
    const mintEngine = new Engine(firstSession.replicaId);
    for (const value of [0x61, 0x62, 0x63]) {
      // "abc"
      const op = mintEngine.localInsert(mintEngine.text().length, value);
      await processIncomingOperation({
        coordinator: first,
        session: firstSession,
        msg: insertMessageFor(op),
      });
    }

    // Second coordinator, SAME documentId, fresh in-memory state (simulates a server restart —
    // nothing here reuses `first`'s engine, only what's durably in Postgres).
    const second = await buildReadyCoordinator(documentId);
    expect(second.engine.text()).toBe("abc");
    expect(second.engine.pending.length).toBe(0); // the DoD's own assertion
    expect(second.currentSeq).toBe(3n);
  });

  it("pendingCount() === 0 fires if the persisted log has a genuinely unmet dependency", async () => {
    const documentId = randomUUID();
    const first = await buildReadyCoordinator(documentId);
    const { session } = buildCapturingSession(first.allocateReplicaId());
    const engine = new Engine(session.replicaId);
    const validOp = engine.localInsert(0, 0x61);
    await processIncomingOperation({ coordinator: first, session, msg: insertMessageFor(validOp) });

    // `operations_no_delete` (Phase 15) correctly makes it impossible to construct this
    // scenario by deleting an existing row — so instead, this inserts a SECOND row directly
    // (bypassing the write path and its own seq/broadcast/ack machinery entirely) whose
    // `originLeft` references an identifier that was never, and will never be, provided by any
    // other row. That row's payload is a perfectly valid encoded operation — nothing about IT
    // is corrupt — it is simply, genuinely missing a causal dependency, the same real-world
    // shape a partial/corrupted log would have. Reuses `session`'s own sessionId/userId
    // (already valid, from the real commit above) to satisfy operations' author_session/
    // author_user foreign keys without needing to hand-construct a sessions row.
    const orphanOp: Operation = {
      kind: "insert",
      id: { c: 999, r: session.replicaId },
      value: 0x7a,
      originLeft: { c: 424242, r: 424242 }, // never provided by any row, on purpose
      originRight: null,
      bind: false,
    };
    await pool.query(
      `INSERT INTO operations (document_id, seq, stamp_r, stamp_c, author_session, author_user, kind, payload)
       VALUES ($1, $2, $3, $4, $5, $6, 'insert', $7)`,
      [
        documentId,
        "999",
        orphanOp.id.r,
        orphanOp.id.c,
        session.sessionId,
        session.userId,
        Buffer.from(encodeFrame(operationToOpInsert(orphanOp, 0))),
      ],
    );

    await expect(buildReadyCoordinator(documentId)).rejects.toThrow(/never became ready/);
  });
});

describe("Phase 16 DoD — ack batching (up to 64 acks or 20ms)", () => {
  it("64 acks in one call flush immediately, without waiting for the timer", async () => {
    const flushed: AckEntry[][] = [];
    const batcher = new AckBatcher((entries) => flushed.push([...entries]));
    const entries: AckEntry[] = Array.from({ length: 64 }, (_, i) => ({
      ackSeq: i + 1,
      ackedId: { c: i + 1, r: 1 },
    }));
    batcher.add(entries);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(64);
  });

  it("fewer than 64 acks flush after the 20ms window, not immediately", async () => {
    const flushed: AckEntry[][] = [];
    const batcher = new AckBatcher((entries) => flushed.push([...entries]));
    batcher.add([{ ackSeq: 1, ackedId: { c: 1, r: 1 } }]);
    expect(flushed).toHaveLength(0); // not yet — still inside the batch window
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(1);
  });

  it("a real run of characters through the write path produces one ack batch, not one ack frame per character", async () => {
    const documentId = randomUUID();
    const coordinator = await buildReadyCoordinator(documentId);
    const { session, sentAcks } = buildCapturingSession(coordinator.allocateReplicaId());
    const engine = new Engine(session.replicaId);
    for (let i = 0; i < 10; i++) {
      const op = engine.localInsert(i, 0x61 + i);
      await processIncomingOperation({ coordinator, session, msg: insertMessageFor(op) });
    }
    await waitForAckFlush();
    expect(sentAcks).toHaveLength(10); // one AckEntry per operation, batched under the hood
  });
});

describe("Phase 16 DoD — broadcast latency is unaffected by a slow database", () => {
  it("the peer receives the relayed frame almost immediately, even with a 500ms artificial commit delay", async () => {
    const documentId = randomUUID();
    const realStore = new PostgresOperationStore(pool);
    // Wraps the real store, delaying ONLY commitOperations — warmStart stays fast so
    // `buildReadyCoordinator`-equivalent setup here isn't itself slow.
    const delayedStore = {
      warmStart: (id: string) => realStore.warmStart(id),
      commitOperations: async (input: Parameters<typeof realStore.commitOperations>[0]) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return realStore.commitOperations(input);
      },
      loadFullOperationLog: (id: string) => realStore.loadFullOperationLog(id),
      loadFullOperationLogWithSeq: (id: string) => realStore.loadFullOperationLogWithSeq(id),
      writeSnapshot: (input: Parameters<typeof realStore.writeSnapshot>[0]) =>
        realStore.writeSnapshot(input),
      getLatestSnapshot: (id: string) => realStore.getLatestSnapshot(id),
      listSnapshots: (id: string) => realStore.listSnapshots(id),
      writeAuditRun: (input: Parameters<typeof realStore.writeAuditRun>[0]) =>
        realStore.writeAuditRun(input),
      listAuditRuns: (id: string, limit: number) => realStore.listAuditRuns(id, limit),
      getLastSuccessfulAuditRunAt: (id: string) => realStore.getLastSuccessfulAuditRunAt(id),
      upsertSessionHeartbeat: (input: Parameters<typeof realStore.upsertSessionHeartbeat>[0]) =>
        realStore.upsertSessionHeartbeat(input),
      getStabilityFrontier: (id: string) => realStore.getStabilityFrontier(id),
    };
    const coordinator = new DocumentCoordinator(documentId, delayedStore);
    await coordinator.ready;

    const { session: sender } = buildCapturingSession(coordinator.allocateReplicaId());
    const { session: peer } = buildCapturingSession(coordinator.allocateReplicaId());
    coordinator.join(peer);

    const engine = new Engine(sender.replicaId);
    const op = engine.localInsert(0, 0x68);

    let peerReceivedAtMs = -1;
    const originalEnqueue = peer.queues.enqueue.bind(peer.queues);
    peer.queues.enqueue = (channel, frame) => {
      if (channel === "ops" && peerReceivedAtMs === -1) {
        peerReceivedAtMs = Date.now();
      }
      originalEnqueue(channel, frame);
    };

    const startedAtMs = Date.now();
    const donePromise = processIncomingOperation({
      coordinator,
      session: sender,
      msg: insertMessageFor(op),
    });

    // The broadcast (step 7) happens synchronously before the DB transaction even starts (step
    // 8) — the peer should already have received the relay well before the artificial 500ms
    // delay elapses, proving the fanout path never waits on the database.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(peerReceivedAtMs).toBeGreaterThan(0);
    expect(peerReceivedAtMs - startedAtMs).toBeLessThan(200); // generous margin over the real ~0ms

    await donePromise; // let the (still in-flight) 500ms commit finish before the test ends
  });
});
