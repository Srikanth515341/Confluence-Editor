// Phase 21 Definition of Done — tombstone garbage collection (Engine Spec
// §7.3/§7.4/§7.6/§7.7; API Spec §6.5; Test Plan M8-c, M8-d), verified
// against a REAL, migrated Postgres instance. Requires:
//   docker compose up -d
//   pnpm db:migrate
// Run via `pnpm test:db` — see durability.db.test.ts's own header comment
// for why this whole file's category is gated out of the default `pnpm test`.

import { randomUUID } from "node:crypto";
import {
  Engine,
  assertInvariants,
  serializeId,
  type Identifier,
  type InsertOperation,
} from "@collab-editor/engine";
import {
  decodeFrame,
  encodeFrame,
  operationToOpDelete,
  operationToOpInsert,
  replaySnapshotNodesInto,
  type OpsMessage,
} from "@collab-editor/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AckBatcher } from "../ackBatcher.js";
import { auditDocument } from "../audit.js";
import { loadConfig } from "../config.js";
import type { CoordinatorSession } from "../documentCoordinator.js";
import { DocumentCoordinator } from "../documentCoordinator.js";
import { toOperations } from "../ingest.js";
import { runOneDocument } from "../gcScheduler.js";
import { ConnectionSendQueues } from "../sendQueues.js";
import { processIncomingOperation } from "../writePath.js";
import { createCollabServer } from "../server.js";
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

const LOWERCASE_A = 0x61;
function letterAt(i: number): number {
  return LOWERCASE_A + (i % 26);
}

/** Same shape as audit.db.test.ts's own `SimulatedClient` — an independent client-side
 * engine plus a `ConnectionSendQueues` that decodes and applies every relay the server
 * sends it, reproducing what a real `SyncClient` would end up with, without a real
 * WebSocket. Duplicated here rather than shared, matching this project's existing
 * `*.db.test.ts` convention (audit.db.test.ts/snapshots.db.test.ts each keep their own copy). */
interface SimulatedClient {
  readonly session: CoordinatorSession;
  readonly engine: Engine;
}

/**
 * BUG FOUND BY ACTUALLY RUNNING THIS TEST (not caught by typecheck): the original version of
 * this helper built a brand-new, EMPTY client engine with no seeding step at all — fine for a
 * client joining a still-empty document, but wrong for M8-c's own base document (90,000
 * bulk-seeded characters already in the coordinator BEFORE any simulated client joins). A real
 * client joining an existing document receives a SNAPSHOT; this helper now reproduces that by
 * replaying `coordinator.engine.nodes` into the fresh client engine via
 * `replaySnapshotNodesInto` (the exact same function the real warm-start/SNAPSHOT path uses) —
 * a no-op for every OTHER test in this file, where the document is still empty when clients join.
 * Without this, `client.engine.localDelete(0, 1)` on M8-c's very first iteration returned `[]`
 * (nothing to delete on an empty client-side view), and `operationToOpDelete(undefined, 0)`
 * crashed with `Cannot read properties of undefined (reading 'id')`.
 */
function buildSimulatedClient(coordinator: DocumentCoordinator, label: string): SimulatedClient {
  const replicaId = coordinator.allocateReplicaId();
  const engine = new Engine(replicaId);
  replaySnapshotNodesInto(engine, coordinator.engine.nodes);
  const queues = new ConnectionSendQueues(
    (frame) => {
      try {
        const msg: OpsMessage = decodeFrame(frame, { direction: "serverOrigin" });
        if (msg.kind !== "opAck" && msg.kind !== "opReject") {
          for (const op of toOperations(msg)) {
            engine.applyRemote(op);
          }
        }
      } catch {
        // Not a decodable OPS frame this client cares about (e.g. its own ack batch).
      }
      return Promise.resolve();
    },
    () => false,
  );
  const session: CoordinatorSession = {
    sessionId: randomUUID(),
    replicaId,
    queues,
    ackBatcher: new AckBatcher(() => {}),
    role: 1, // EDITOR
    userId: randomUUID(),
    displayName: label,
    lastPingAt: Date.now(),
    presenceStale: false,
    staleTimer: undefined,
    receivedFrameCount: 0,
  };
  coordinator.join(session);
  return { session, engine };
}

/** Every currently-joined client "acks" up to `coordinator.currentSeq` — the M8-c DoD's own
 * "all clients connected and acking" precondition, done directly through the store rather
 * than a real PING round trip (gateway.ts's own WebSocket-level PING handling isn't
 * reachable from a `.db.test.ts` file that never opens a real socket — see this file's
 * `SimulatedClient` for the same reasoning applied to OPS delivery). */
async function ackAllClients(
  store: PostgresOperationStore,
  coordinator: DocumentCoordinator,
  clients: readonly SimulatedClient[],
): Promise<void> {
  for (const client of clients) {
    await store.upsertSessionHeartbeat({
      sessionId: client.session.sessionId,
      documentId: coordinator.documentId,
      userId: client.session.userId,
      replicaId: client.session.replicaId,
      displayName: client.session.displayName,
      lastAckSeq: coordinator.currentSeq,
    });
  }
}

/** A pure left-to-right append chain, built WITHOUT calling into a real `Engine` — same
 * helper as audit.db.test.ts/snapshots.db.test.ts's own copies (independently verified
 * against `Engine.localInsert`'s own source). Used only to build a LARGE base document
 * fast; the deletes that actually matter for this file's own tests always go through the
 * real write path (see this file's own comments on why). */
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
      originLeft: prevId,
      originRight: null,
      bind: false,
    });
    prevId = id;
  }
  return ops;
}

/** Bulk-seeds `documentId` with `count` sequential append operations, bypassing the real
 * write path for SETUP speed only (same reasoning as audit.db.test.ts's own copy) — fixture
 * construction speed must not be confused with what M8-c actually measures (GC's own
 * effectiveness on the resulting structure). The deletes this file's tests apply on TOP of
 * this base always go through the real write path, since that's the only path that attaches
 * GC delete-context (`engine.applyRemote`'s optional third argument, Phase 21). */
async function seedAppendChainDocument(
  store: PostgresOperationStore,
  documentId: string,
  count: number,
): Promise<{ readonly ops: readonly InsertOperation[]; readonly sessionId: string; readonly userId: string; readonly replicaId: number }> {
  await store.warmStart(documentId);
  // BUG FOUND BY ACTUALLY RUNNING THIS TEST: replica id 1 collided with
  // `coordinator.allocateReplicaId()`'s own first allocation to the FIRST real
  // `buildSimulatedClient` joined afterward (audit.db.test.ts/snapshots.db.test.ts's
  // identical-looking helper never hits this because neither of THEIR tests also joins a real
  // client on the same document) — two different `sessions` rows (this bulk-seed's directly-
  // inserted row, and the real client's own via `upsertSessionHeartbeat`) both claiming
  // `(document_id, replica_id=1)` violates `sessions_replica_uq`. Fixed by reserving a replica
  // id far outside the coordinator's own low sequential range for this fixture-only "session."
  const replicaId = 999_999;
  const sessionId = randomUUID();
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@placeholder.collab-editor.internal`, "Bulk Seed User", "x"],
  );
  await pool.query(
    `INSERT INTO sessions (id, user_id, document_id, replica_id, role_at_connect) VALUES ($1, $2, $3, $4, 'editor') ON CONFLICT (id) DO NOTHING`,
    [sessionId, userId, documentId, replicaId],
  );
  // BUG FOUND BY ACTUALLY RUNNING A GC TEST BUILT ON TOP OF THIS HELPER (this exact class of
  // bug, a third time in this file): the row just inserted above defaults to `last_ack_seq =
  // 0` and `last_seen_at = now()` — a real, FRESH session that nothing ever acks again,
  // which permanently holds `MIN(last_ack_seq)` at 0 for the rest of any test built on this
  // fixture, no matter how thoroughly OTHER (real) sessions ack afterward. This fixture
  // represents bulk-loaded HISTORICAL content, not a currently-connected user — aging it out
  // immediately is both the fix and the more accurate representation of what it actually is.
  await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '1 day' WHERE id = $1`, [
    sessionId,
  ]);

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
  return { ops, sessionId, userId, replicaId };
}

/** Exhaustive per-Test-Plan-M8-c check: for EVERY remaining node, its originLeft/originRight
 * (if non-null) must resolve to some OTHER remaining node — i.e. no live node names a
 * collected node as an origin (Engine Spec I5). This duplicates what `assertInvariants`'s I4
 * check already does internally, independently re-implemented here (not calling into the
 * same code path) specifically because Phase 20's investigation showed "the same mechanism
 * checks itself" is not enough confidence for exactly this class of anchor-tracking bug. */
function assertNoDanglingOrigins(engine: Engine): void {
  const ids = new Set(engine.nodes.map((n) => serializeId(n.id)));
  for (const node of engine.nodes) {
    if (node.originLeft !== null) {
      expect(ids.has(serializeId(node.originLeft))).toBe(true);
    }
    if (node.originRight !== null) {
      expect(ids.has(serializeId(node.originRight))).toBe(true);
    }
  }
}

describe("Phase 21 M8-c — GC effectiveness on a 100,000-operation document", () => {
  it("tombstone count drops materially, the document still converges, the audit still passes, and no live node anchors a collected node", async () => {
    const documentId = randomUUID();
    const store = new PostgresOperationStore(pool);

    // 90,000 characters, bulk-seeded (fixture SETUP speed only — see this file's own comment).
    const BASE_COUNT = 90_000;
    await seedAppendChainDocument(store, documentId, BASE_COUNT);

    const coordinator = new DocumentCoordinator(documentId, store);
    await coordinator.ready;
    expect(coordinator.engine.text()).toHaveLength(BASE_COUNT);

    const clientA = buildSimulatedClient(coordinator, "Client A");
    const clientB = buildSimulatedClient(coordinator, "Client B");
    const clients = [clientA, clientB];

    // 10,000 real deletes THROUGH THE WRITE PATH (the only path that attaches GC
    // delete-context) — alternating clients, each deleting the CURRENT LAST character.
    //
    // BUG FOUND BY ACTUALLY RUNNING THIS TEST (a real, structural finding, not a test-fixture
    // triviality): the original version deleted position 0 repeatedly, tombstoning a PREFIX
    // of `seedAppendChainDocument`'s single unbroken append chain (every character's
    // originLeft is its immediate predecessor). The first still-LIVE character right after
    // that prefix permanently anchors the last tombstoned character via its own originLeft —
    // which anchors the one before it, cascading all the way back — so NONE of those 10,000
    // tombstones could EVER be collected while ANY of the original suffix remains live. This
    // is Engine Spec I4/I5 working exactly as designed (a live node's origin must never be
    // collected out from under it), not a bug in `collect()` — but it meant this fixture could
    // never demonstrate GC effectiveness at all, no matter the frontier or horizon. It also
    // caused a real, separate performance finding: with 0 nodes ever leaving `collectible`,
    // the fixpoint still had to cascade one step per pass for a 10,000-deep anchor chain
    // before concluding nothing was collectible — each pass rescanning all 90,000 nodes,
    // ~900M operations total, measured at 853 SECONDS wall time (worth flagging honestly:
    // `collect()`'s fixpoint cost scales with anchor-CHAIN DEPTH, not just document size, for
    // this specific "long unresolved chain" shape — a real characteristic to keep in mind for
    // documents with a long-undeleted prefix, separate from this test's own fix).
    //
    // Deleting from the END instead avoids the pathology entirely: nothing is ever inserted
    // AFTER the last character, so nothing anchors to it — each deleted suffix character is
    // immediately eligible once stable/aged, with no cascade at all. 90,000 + 10,000 = 100,000
    // operations total, matching M8-c's own "100,000 operations" framing.
    const DELETE_COUNT = 10_000;
    for (let i = 0; i < DELETE_COUNT; i++) {
      const client = clients[i % clients.length]!;
      const lastVisibleIndex = client.engine.stats().visibleLength - 1;
      const [delOp] = client.engine.localDelete(lastVisibleIndex, 1);
      await processIncomingOperation({
        coordinator,
        session: client.session,
        msg: operationToOpDelete(delOp!, 0),
      });
    }

    const statsBefore = coordinator.engine.stats();
    expect(statsBefore.tombstones).toBe(DELETE_COUNT);
    const textBefore = coordinator.engine.text();
    expect(textBefore).toHaveLength(BASE_COUNT - DELETE_COUNT);

    // "All clients connected and acking" — both simulated clients ack up to current_seq.
    await ackAllClients(store, coordinator, clients);

    // One GC cycle, via the real scheduler entry point (not calling engine.collect()
    // directly) — exercises the real frontier query + config plumbing end to end.
    await runOneDocument(coordinator, {
      undoHorizonMaxAgeMs: 0, // no real wait — this test cares about GC's own mechanics, not the horizon's clock
      undoHorizonMaxOpsPerReplica: 0,
      gcIntervalMs: 60_000,
      gcFixpointBudgetMs: 150,
    });

    const statsAfter = coordinator.engine.stats();
    // ASSERT tombstone_count drops materially.
    expect(statsAfter.tombstones).toBeLessThan(statsBefore.tombstones);
    expect(statsAfter.tombstones).toBeLessThanOrEqual(Math.floor(statsBefore.tombstones * 0.1));
    expect(coordinator.lastGcCollectedCount).toBeGreaterThan(0);

    // ASSERT the document still converges (M1) — GC must never change visible text.
    expect(coordinator.engine.text()).toBe(textBefore);

    // ASSERT the integrity audit still passes (DUR-01) — independent genesis replay (which
    // never calls collect() at all) still agrees with the live, now-GC'd coordinator engine.
    const auditResult = await auditDocument(documentId, store, {
      liveText: coordinator.engine.text(),
    });
    expect(auditResult.result).toBe("ok");

    // ASSERT no live node names a collected node as an origin (Engine Spec I5) — checked
    // BOTH via the engine's own invariant suite AND an independent re-implementation (see
    // assertNoDanglingOrigins's own doc comment for why this isn't considered redundant).
    expect(() => assertInvariants(coordinator.engine, { afterCollect: true })).not.toThrow();
    assertNoDanglingOrigins(coordinator.engine);
    // BUG FOUND BY ACTUALLY RUNNING THIS TEST: 180s was not enough headroom once GC actually
    // succeeded (10,000 real write-path deletes + a real GC cycle + a real audit + two full
    // exhaustive invariant/dangling-origin scans over 80,000 remaining nodes) — the run that
    // proved everything else correct (frontier=100000, collected=10000, audit "ok") still hit
    // the timeout at 181s. Bumped with real margin, not just enough to squeak past what was
    // observed once.
  }, 400_000);
});

describe("Phase 21 M8-d — GC blocked by a slow replica (Rule 7.1 eviction)", () => {
  it("a client stale for 9 minutes still holds the frontier back; past 10 minutes it is evicted and collection proceeds", async () => {
    const documentId = randomUUID();
    const store = new PostgresOperationStore(pool);
    const coordinator = new DocumentCoordinator(documentId, store);
    await coordinator.ready;

    const fast = buildSimulatedClient(coordinator, "Fast Client");
    const slow = buildSimulatedClient(coordinator, "Slow Client");

    // One insert, one delete, both through the real write path (real GC context attached).
    const insOp = fast.engine.localInsert(0, letterAt(0));
    await processIncomingOperation({ coordinator, session: fast.session, msg: operationToOpInsert(insOp, 0) });
    const [delOp] = fast.engine.localDelete(0, 1);
    await processIncomingOperation({ coordinator, session: fast.session, msg: operationToOpDelete(delOp!, 0) });

    expect(coordinator.engine.stats().tombstones).toBe(1);

    // BUG FOUND BY ACTUALLY RUNNING THIS TEST: the original version acked BOTH clients to
    // `coordinator.currentSeq` (2) BEFORE aging the slow one — meaning the slow client had
    // already confirmed receiving the delete, so its later staleness never actually held
    // anything back at all (the very first GC cycle collected immediately, defeating the
    // test's own point). Test Plan M8-d's own wording is "held at a STALE WATERMARK for 9
    // minutes" — the watermark itself (last_ack_seq) must stay BEHIND, not merely the
    // timestamp. Fixed: the fast client acks everything; the slow client acks only up to
    // seq 0 (before the insert/delete even happened) and NEVER catches up — its own low
    // watermark is what should hold the frontier back, for as long as it's still inside the
    // 10-minute window.
    await store.upsertSessionHeartbeat({
      sessionId: fast.session.sessionId,
      documentId,
      userId: fast.session.userId,
      replicaId: fast.session.replicaId,
      displayName: fast.session.displayName,
      lastAckSeq: coordinator.currentSeq,
    });
    await store.upsertSessionHeartbeat({
      sessionId: slow.session.sessionId,
      documentId,
      userId: slow.session.userId,
      replicaId: slow.session.replicaId,
      displayName: slow.session.displayName,
      lastAckSeq: 0n, // never advanced past its own join
    });
    await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '9 minutes' WHERE id = $1`, [
      slow.session.sessionId,
    ]);

    // Still within the 10-minute offline window -- the slow client's own low watermark (0)
    // still counts toward MIN(last_ack_seq), holding the frontier at exactly 0, well below
    // the delete's own seq (2) -- so it must not be collected.
    const frontierAt9Min = await store.getStabilityFrontier(documentId);
    expect(frontierAt9Min).toBe(0n);
    await runOneDocument(coordinator, {
      undoHorizonMaxAgeMs: 0,
      undoHorizonMaxOpsPerReplica: 0,
      gcIntervalMs: 60_000,
      gcFixpointBudgetMs: 150,
    });
    expect(coordinator.engine.stats().tombstones).toBe(1); // NOT collected yet
    expect(coordinator.lastGcCollectedCount).toBe(0);

    // Now push the slow client's last_seen_at past the 10-minute window -- it is evicted
    // from the frontier query (Rule 7.1), and the frontier is free to advance based on the
    // fast client alone.
    await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '11 minutes' WHERE id = $1`, [
      slow.session.sessionId,
    ]);
    const frontierAfterEviction = await store.getStabilityFrontier(documentId);
    expect(frontierAfterEviction).toBeGreaterThanOrEqual(coordinator.currentSeq);

    await runOneDocument(coordinator, {
      undoHorizonMaxAgeMs: 0,
      undoHorizonMaxOpsPerReplica: 0,
      gcIntervalMs: 60_000,
      gcFixpointBudgetMs: 150,
    });
    expect(coordinator.engine.stats().tombstones).toBe(0); // collected now
    expect(coordinator.lastGcCollectedCount).toBe(1);
  }, 60_000);
});

describe("Phase 21 DoD — cold-load compaction", () => {
  it("with zero active sessions, GC collects everything collectible (frontier COALESCEs to current_seq)", async () => {
    const documentId = randomUUID();
    const store = new PostgresOperationStore(pool);
    const coordinator = new DocumentCoordinator(documentId, store);
    await coordinator.ready;
    const client = buildSimulatedClient(coordinator, "Solo Client");

    const insOp = client.engine.localInsert(0, letterAt(0));
    await processIncomingOperation({ coordinator, session: client.session, msg: operationToOpInsert(insOp, 0) });
    const [delOp] = client.engine.localDelete(0, 1);
    await processIncomingOperation({ coordinator, session: client.session, msg: operationToOpDelete(delOp!, 0) });
    expect(coordinator.engine.stats().tombstones).toBe(1);

    // BUG FOUND BY ACTUALLY RUNNING THIS TEST, TWICE: first, no call to ackAllClients/
    // upsertSessionHeartbeat is NOT enough to reproduce "zero active sessions" —
    // `PostgresOperationStore.commitOperations` (Phase 16) auto-provisions a `sessions` row as
    // a side effect of ANY commit (`ON CONFLICT (id) DO NOTHING`, needed for `operations.
    // author_session`'s own FK), with schema DEFAULTs `last_ack_seq = 0` and `last_seen_at =
    // now()` — real, FRESH, and genuinely constraining `MIN(last_ack_seq)` to 0. Second: an
    // outright DELETE of that row (the first fix attempted here) fails too, for a DIFFERENT
    // reason — `operations.author_session REFERENCES sessions(id)` with no ON DELETE CASCADE,
    // so deleting a session row real operations already reference violates
    // `operations_author_session_fkey`. The only sound way to reproduce "nobody is currently
    // active" for a document that has real history (the only case GC ever needs to do
    // anything for) is to age the existing row out past the SAME 10-minute window Rule 7.1
    // uses everywhere else — not delete it. This is also more representative of what a real
    // cold-load scenario actually is: a document everyone left a while ago, not one that
    // never had a session at all.
    await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '1 day' WHERE document_id = $1`, [
      documentId,
    ]);

    const frontier = await store.getStabilityFrontier(documentId);
    expect(frontier).toBe(coordinator.currentSeq); // COALESCE fallback

    await runOneDocument(coordinator, {
      undoHorizonMaxAgeMs: 0,
      undoHorizonMaxOpsPerReplica: 0,
      gcIntervalMs: 60_000,
      gcFixpointBudgetMs: 150,
    });
    expect(coordinator.engine.stats().tombstones).toBe(0);
    expect(coordinator.lastGcCollectedCount).toBe(1);
  }, 30_000);
});

describe("Phase 21 DoD — gc.minutes_since_last_success is a real, queryable metric", () => {
  it("stays null before any cycle, then reflects a real successful run", async () => {
    const documentId = randomUUID();
    const store = new PostgresOperationStore(pool);
    const coordinator = new DocumentCoordinator(documentId, store);
    await coordinator.ready;

    expect(coordinator.lastGcSuccessAt).toBeNull();

    const beforeMs = Date.now();
    await runOneDocument(coordinator, {
      undoHorizonMaxAgeMs: 0,
      undoHorizonMaxOpsPerReplica: 0,
      gcIntervalMs: 60_000,
      gcFixpointBudgetMs: 150,
    });

    expect(coordinator.lastGcAttemptAt).not.toBeNull();
    expect(coordinator.lastGcSuccessAt).not.toBeNull();
    expect(coordinator.lastGcSuccessAt!.getTime()).toBeGreaterThanOrEqual(beforeMs - 1000);
    // "minutes since last success" is computed at read time (httpApp.ts's /gc-status), not
    // stored — a fresh success is ~0 minutes ago.
    const minutesSince = (Date.now() - coordinator.lastGcSuccessAt!.getTime()) / 60_000;
    expect(minutesSince).toBeLessThan(1);
  }, 30_000);
});

describe("Phase 21 safety cap — a pathological GC cycle does not freeze the event loop for OTHER documents", () => {
  it("a real HTTP request to an unrelated document completes within a small bound while a capped, pathological GC cycle runs on a different one", async () => {
    // Build the pathological structure DIRECTLY on a real DocumentCoordinator's own engine
    // (bypassing the real write path for SETUP speed only — same "fixture speed is not what's
    // measured" principle as seedAppendChainDocument; going through 10,000 real per-operation
    // commits here would cost minutes this test doesn't need, since what's under test is
    // purely "does a blocking collect() call stall OTHER concurrent server work," which only
    // needs the right ENGINE STATE, not real persisted history for THIS specific document).
    const pathologicalDocId = randomUUID();
    const store = new PostgresOperationStore(pool);
    const pathologicalCoordinator = new DocumentCoordinator(pathologicalDocId, store);
    await pathologicalCoordinator.ready;

    let prevId: { c: number; r: number } | null = null;
    const ids: Array<{ c: number; r: number }> = [];
    for (let i = 0; i < 90_000; i++) {
      const id = { c: i + 1, r: 1 };
      pathologicalCoordinator.engine.applyRemote({
        kind: "insert",
        id,
        value: 97 + (i % 26),
        originLeft: prevId,
        originRight: null,
        bind: false,
      });
      ids.push(id);
      prevId = id;
    }
    for (let i = 0; i < 10_000; i++) {
      pathologicalCoordinator.engine.applyRemote(
        { kind: "delete", id: { c: 90_000 + i + 1, r: 2 }, target: ids[i]! },
        { seq: BigInt(90_000 + i + 1), atMs: 0 },
      );
    }
    expect(pathologicalCoordinator.engine.stats().tombstones).toBe(10_000);

    // A REAL, separate, ordinary document on the SAME real server — through the real write
    // path, quick.
    const normalDocId = randomUUID();
    const server = createCollabServer({ operationStore: store });
    const port = await server.listen(0);
    const normalCoordinator = new DocumentCoordinator(normalDocId, store);
    await normalCoordinator.ready;
    // `Gateway.coordinators` is typed `ReadonlyMap` (an external-consumer view restriction);
    // the underlying object is a real, mutable `Map` at runtime — the same one `gateway.ts`'s
    // own `getOrCreateCoordinator` populates for a real incoming connection. Cast, not
    // reimplemented, so this test registers coordinators the identical way production does.
    const mutableCoordinators = server.gateway.coordinators as Map<string, DocumentCoordinator>;
    mutableCoordinators.set(normalDocId, normalCoordinator);
    mutableCoordinators.set(pathologicalDocId, pathologicalCoordinator);

    try {
      // Fire the HTTP request to the UNRELATED document and the capped, pathological GC cycle
      // essentially simultaneously — the fetch's own network round trip can only actually be
      // serviced once the synchronous `collect()` call below releases the event loop, so its
      // measured latency directly reflects how long that call blocked everything else.
      const fetchStart = performance.now();
      const [httpResult] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/v1/documents/${normalDocId}/gc-status`),
        (async () => {
          // Direct engine.collect() call (not runOneDocument) -- this synthetic document was
          // never committed through the real write path, so it has no real session/frontier
          // history in Postgres; a hardcoded frontier exercises the exact same capped fixpoint
          // mechanism without needing that plumbing for a document that only exists for this
          // one test.
          return pathologicalCoordinator.engine.collect(BigInt(200_000), {
            nowMs: 10_000_000,
            maxAgeMs: 0,
            maxOpsPerReplica: 0,
            budgetMs: 150,
            clock: () => performance.now(),
          });
        })(),
      ]);
      const totalElapsedMs = performance.now() - fetchStart;

      expect(httpResult.status).toBe(200);
      const body = (await httpResult.json()) as { totalElements: number };
      expect(body.totalElements).toBe(0); // the UNRELATED document, untouched, empty as expected

      // eslint-disable-next-line no-console -- worth always reporting, this is the whole point of the test.
      console.log(
        `[GC safety cap] concurrent HTTP request to an unrelated document completed in ${totalElapsedMs.toFixed(1)}ms while a capped pathological GC cycle ran (uncapped, that GC cycle alone measured 853,000ms)`,
      );
      // Bounded by a small multiple of the 150ms cap, nowhere near 853,000ms -- proves the
      // server was NOT frozen for the pathological document's own uncapped cost.
      expect(totalElapsedMs).toBeLessThan(5_000);
    } finally {
      await server.close();
    }
  }, 30_000);
});
