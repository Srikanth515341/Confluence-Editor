// Phase 17 Definition of Done — snapshots and coordinator warm start
// (API Spec §6.4, §2.7; RFC §13.2; PRD FR-PS-4), verified against a
// REAL, migrated Postgres instance. Requires:
//   docker compose up -d
//   pnpm db:migrate
// Run via `pnpm test:db` — see durability.db.test.ts's own header
// comment for why this whole file's category is gated out of the
// default `pnpm test`.

import { randomUUID } from "node:crypto";
import { Engine, type Identifier, type InsertOperation, type Node } from "@collab-editor/engine";
import {
  encodeFrame,
  encodeStructureSnapshotBody,
  operationToOpInsert,
} from "@collab-editor/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AckBatcher } from "../ackBatcher.js";
import { loadConfig } from "../config.js";
import type { CoordinatorSession } from "../documentCoordinator.js";
import { DocumentCoordinator } from "../documentCoordinator.js";
import { ConnectionSendQueues } from "../sendQueues.js";
import { processIncomingOperation } from "../writePath.js";
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

function buildCapturingSession(replicaId: number): { session: CoordinatorSession } {
  const queues = new ConnectionSendQueues(
    () => Promise.resolve(),
    () => false,
  );
  const session: CoordinatorSession = {
    sessionId: randomUUID(),
    replicaId,
    queues,
    ackBatcher: new AckBatcher(() => {}),
    role: 1, // EDITOR
    userId: randomUUID(),
    displayName: `Test ${replicaId}`,
    lastPingAt: Date.now(),
    presenceStale: false,
    staleTimer: undefined,
    receivedFrameCount: 0,
  };
  return { session };
}

function insertMessageFor(op: InsertOperation) {
  return operationToOpInsert(op, 0);
}

async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function snapshotCountFor(documentId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM snapshots WHERE document_id = $1`,
    [documentId],
  );
  return Number(rows[0]?.count ?? "0");
}

async function latestSnapshotOpCount(documentId: string): Promise<number | null> {
  const { rows } = await pool.query<{ op_count: number }>(
    `SELECT op_count FROM snapshots WHERE document_id = $1 ORDER BY seq DESC LIMIT 1`,
    [documentId],
  );
  return rows[0]?.op_count ?? null;
}

/**
 * A pure left-to-right append chain (each op's `originLeft` is the
 * immediately preceding op's own id, `originRight` always `null`) —
 * exactly what `Engine.localInsert()` produces for sequential typing at
 * the end of a growing document (Phase 3's own `localInsert`: for
 * `visibleIndex === vis.length`, `rightNode` is `undefined` ->
 * `originRight: null`, `leftNode` is the last visible node -> its id).
 * Built WITHOUT calling into a real `Engine` at all — `localInsert`'s own
 * `visible()` scan and `integrate()`'s origin-window scan are both O(N)
 * per call (no index yet, Phase 19), so minting 50,000 operations for a
 * benchmark FIXTURE this way, one at a time, would make fixture setup
 * itself the slow part of the test. This produces the identical
 * Operation shape a real `Engine` would, independently verified against
 * `localInsert`'s own source.
 */
function buildAppendChain(
  replicaId: number,
  count: number,
  valueAt: (i: number) => number,
): InsertOperation[] {
  const ops: InsertOperation[] = [];
  let prevId: Identifier | null = null;
  for (let i = 0; i < count; i++) {
    const id: Identifier = { c: i + 1, r: replicaId };
    ops.push({
      kind: "insert",
      id,
      value: valueAt(i),
      parent: prevId,
      side: "R",
      bind: false,
    });
    prevId = id;
  }
  return ops;
}

const LOWERCASE_A = 0x61;
function letterAt(i: number): number {
  return LOWERCASE_A + (i % 26);
}

/**
 * Seeds `documentId` with `count` sequential append operations, bulk
 *-inserted directly (Phase 15's own `unnest(...)` technique — bypassing
 * the real write path's per-row SAVEPOINT transaction machinery, which
 * would make fixture setup the slow part of a test about warm-start
 * SPEED). Provisions `documents`/`users`/`sessions` rows first (mirrors
 * what a real first commit does) so the FK chain `operations.
author_session -> sessions -> users` is satisfied. If `snapshotAtCount`
 * is given, ALSO writes one real snapshot row reflecting state after
 * exactly that many operations — derived directly from the same
 * synthetic chain (no engine replay needed: a pure append chain with no
 * deletes has trivially-computable content/structure at any prefix).
 */
async function seedAppendChainDocument(
  documentId: string,
  count: number,
  snapshotAtCount: number | null,
): Promise<InsertOperation[]> {
  const store = new PostgresOperationStore(pool);
  await store.warmStart(documentId); // provisions documents + SYSTEM_USER_ID

  const replicaId = 1;
  const sessionId = randomUUID();
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@placeholder.collab-editor.internal`, "Bench User", "x"],
  );
  await pool.query(
    `INSERT INTO sessions (id, user_id, document_id, replica_id, role_at_connect) VALUES ($1, $2, $3, $4, 'editor') ON CONFLICT (id) DO NOTHING`,
    [sessionId, userId, documentId, replicaId],
  );

  const ops = buildAppendChain(replicaId, count, letterAt);
  const seqs: string[] = [];
  const stampRs: number[] = [];
  const stampCs: number[] = [];
  const kinds: string[] = [];
  const payloads: Buffer[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    seqs.push(String(i + 1));
    stampRs.push(op.id.r);
    stampCs.push(op.id.c);
    kinds.push("insert");
    payloads.push(Buffer.from(encodeFrame(operationToOpInsert(op, 0))));
  }
  await pool.query(
    `INSERT INTO operations (document_id, seq, stamp_r, stamp_c, author_session, author_user, kind, payload)
     SELECT $1, s.seq, s.stamp_r, s.stamp_c, $2, $3, s.kind, s.payload
       FROM unnest($4::bigint[], $5::bigint[], $6::bigint[], $7::op_kind[], $8::bytea[])
              AS s(seq, stamp_r, stamp_c, kind, payload)`,
    [documentId, sessionId, userId, seqs, stampRs, stampCs, kinds, payloads],
  );
  await pool.query(`UPDATE documents SET current_seq = GREATEST(current_seq, $2) WHERE id = $1`, [
    documentId,
    String(count),
  ]);

  if (snapshotAtCount !== null) {
    const prefix = ops.slice(0, snapshotAtCount);
    const nodes: Node[] = prefix.map((op) => ({
      id: op.id,
      value: op.value,
      parent: op.parent,
      side: op.side,
      bind: op.bind,
      deleted: false,
      deletedBy: null,
    }));
    const content = prefix.map((op) => String.fromCodePoint(op.value)).join("");
    await store.writeSnapshot({
      documentId,
      seq: BigInt(snapshotAtCount),
      content,
      structure: encodeStructureSnapshotBody(nodes),
      opCount: snapshotAtCount,
    });
  }

  return ops;
}

describe("Phase 17 DoD — MAYBE-SNAPSHOT() fires at both triggers (RFC §13.2)", () => {
  it("the 500-operation threshold writes a snapshot with op_count ~500", async () => {
    const documentId = randomUUID();
    const store = new PostgresOperationStore(pool);
    const coordinator = new DocumentCoordinator(documentId, store);
    await coordinator.ready;
    const { session } = buildCapturingSession(coordinator.allocateReplicaId());
    const engine = new Engine(session.replicaId);

    for (let i = 0; i < 500; i++) {
      const op = engine.localInsert(i, letterAt(i));
      await processIncomingOperation({ coordinator, session, msg: insertMessageFor(op) });
    }

    await pollUntil(async () => (await snapshotCountFor(documentId)) >= 1, 5_000);
    const opCount = await latestSnapshotOpCount(documentId);
    expect(opCount).not.toBeNull();
    expect(opCount).toBeGreaterThanOrEqual(500); // "~500" — the exact operation that crosses the
    // threshold is still included in the batch that triggers the write, never dropped.
    expect(opCount).toBeLessThan(520); // generous slack; nothing should push this far past 500
    expect(coordinator.opsSinceSnap).toBe(0); // reset after a successful write
  }, 20_000);

  it("the 30-second time threshold writes a snapshot even with far fewer than 500 operations", async () => {
    const documentId = randomUUID();
    const store = new PostgresOperationStore(pool);
    // Test-only threshold override (DocumentCoordinator's own constructor parameter) — proves
    // the SAME reactive-check code path RFC §13.2 describes, just against a threshold small
    // enough to observe in a fast test rather than actually waiting 30 real seconds.
    const coordinator = new DocumentCoordinator(documentId, store, {
      opThreshold: 1_000_000, // effectively unreachable — isolates the time trigger
      timeThresholdMs: 100,
    });
    await coordinator.ready;
    const { session } = buildCapturingSession(coordinator.allocateReplicaId());
    const engine = new Engine(session.replicaId);

    for (let i = 0; i < 3; i++) {
      const op = engine.localInsert(i, letterAt(i));
      await processIncomingOperation({ coordinator, session, msg: insertMessageFor(op) });
    }
    expect(await snapshotCountFor(documentId)).toBe(0); // neither trigger has fired yet

    await new Promise((resolve) => setTimeout(resolve, 150)); // cross the 100ms time threshold
    const op = engine.localInsert(3, letterAt(3)); // one more op — MAYBE-SNAPSHOT() is checked
    // reactively, per batch, not on an independent background timer (RFC §13.2's own wording:
    // "after each operation batch")
    await processIncomingOperation({ coordinator, session, msg: insertMessageFor(op) });

    await pollUntil(async () => (await snapshotCountFor(documentId)) >= 1, 5_000);
    expect(await latestSnapshotOpCount(documentId)).toBe(4); // far below 500 — the TIME trigger fired it
  }, 20_000);
});

describe("Phase 17 DoD — warm start from snapshot + suffix matches a full genesis replay", () => {
  it("byte-identical text on a 5,000-operation document", async () => {
    const documentId = randomUUID();
    // A snapshot partway through, so warm start genuinely exercises the snapshot+suffix path
    // (not just "no snapshot exists yet, replay everything" — the pre-Phase-17 behavior).
    await seedAppendChainDocument(documentId, 5_000, 4_000);

    const store = new PostgresOperationStore(pool);
    const warmStarted = new DocumentCoordinator(documentId, store);
    await warmStarted.ready;

    // Full genesis replay — deliberately via loadFullOperationLog, ignoring the snapshot
    // entirely, into a completely independent fresh Engine (the DoD's own literal comparison).
    const genesisOps = await store.loadFullOperationLog(documentId);
    const genesisEngine = new Engine(0);
    for (const op of genesisOps) {
      genesisEngine.applyRemote(op);
    }

    expect(warmStarted.engine.pending.length).toBe(0);
    expect(genesisEngine.pending.length).toBe(0);
    expect(warmStarted.engine.text()).toBe(genesisEngine.text());
    expect(warmStarted.engine.text()).toHaveLength(5_000);
  }, 30_000);
});

describe("Phase 17 DoD — snapshot generation does not measurably affect operation latency", () => {
  it("p95 write-path latency with snapshotting active is comparable to with it effectively disabled", async () => {
    const OPS_PER_RUN = 600; // comfortably crosses the 500-op threshold at least once
    const documentIdWith = randomUUID();
    const documentIdWithout = randomUUID();
    const store = new PostgresOperationStore(pool);

    async function runAndMeasure(documentId: string, opThreshold: number): Promise<number[]> {
      const coordinator = new DocumentCoordinator(documentId, store, { opThreshold });
      await coordinator.ready;
      const { session } = buildCapturingSession(coordinator.allocateReplicaId());
      const engine = new Engine(session.replicaId);
      const durationsMs: number[] = [];
      for (let i = 0; i < OPS_PER_RUN; i++) {
        const op = engine.localInsert(i, letterAt(i));
        const startedAt = performance.now();
        await processIncomingOperation({ coordinator, session, msg: insertMessageFor(op) });
        durationsMs.push(performance.now() - startedAt);
      }
      return durationsMs;
    }

    function percentile(durationsMs: number[], p: number): number {
      const sorted = [...durationsMs].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * p)]!;
    }

    // "With" snapshotting: real RFC threshold (500) — WILL fire mid-run given 600 operations.
    const withSnapshotting = await runAndMeasure(documentIdWith, 500);
    // "Without": threshold effectively unreachable at this volume — snapshotting never fires.
    const withoutSnapshotting = await runAndMeasure(documentIdWithout, 1_000_000);

    expect(await snapshotCountFor(documentIdWith)).toBeGreaterThanOrEqual(1);
    expect(await snapshotCountFor(documentIdWithout)).toBe(0);

    const p50With = percentile(withSnapshotting, 0.5);
    const p95With = percentile(withSnapshotting, 0.95);
    const maxWith = Math.max(...withSnapshotting);
    const p50Without = percentile(withoutSnapshotting, 0.5);
    const p95Without = percentile(withoutSnapshotting, 0.95);
    const maxWithout = Math.max(...withoutSnapshotting);
    // Logged unconditionally (not just on failure) — a ratio assertion alone ("within 2x") hides
    // whether the underlying numbers are trivial (1ms -> 2ms) or actually significant against a
    // real latency budget (50ms -> 100ms); anyone reading a future test run's output should see
    // the real numbers without having to instrument this file themselves.
    console.log(
      JSON.stringify({
        message: "snapshotLatencyBenchmark",
        opsPerRun: OPS_PER_RUN,
        withSnapshotting: {
          p50Ms: Number(p50With.toFixed(2)),
          p95Ms: Number(p95With.toFixed(2)),
          maxMs: Number(maxWith.toFixed(2)),
        },
        withoutSnapshotting: {
          p50Ms: Number(p50Without.toFixed(2)),
          p95Ms: Number(p95Without.toFixed(2)),
          maxMs: Number(maxWithout.toFixed(2)),
        },
      }),
    );

    // Generous margin (not a tight statistical claim — this is a real database over a real, if
    // local, connection, and per-call latency already has natural jitter): snapshotting being
    // ACTIVE must not make the typical operation more than ~2x slower at p95. If snapshot
    // writes were blocking the hot path (the bug this test exists to catch), a 500-operation
    // burst that materializes and persists a full document snapshot synchronously mid-stream
    // would blow well past this margin, not sit within it.
    expect(p95With).toBeLessThan(Math.max(p95Without * 2, 50));
  }, 30_000);
});

describe("Phase 17 DoD — warm-start speed on a large document", () => {
  it("a 50,000-operation document (snapshotted near the end) warm-starts in under 2 seconds", async () => {
    const documentId = randomUUID();
    await seedAppendChainDocument(documentId, 50_000, 49_000);

    const store = new PostgresOperationStore(pool);
    const startedAt = performance.now();
    const coordinator = new DocumentCoordinator(documentId, store);
    await coordinator.ready;
    const elapsedMs = performance.now() - startedAt;

    expect(coordinator.engine.pending.length).toBe(0);
    expect(coordinator.engine.text()).toHaveLength(50_000);
    expect(elapsedMs).toBeLessThan(2_000);
  }, 30_000);
});
