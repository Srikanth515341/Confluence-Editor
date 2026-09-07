// Phase 18 Definition of Done — the log-replay integrity audit (API
// Spec §6.6; Test Plan §3.2, DUR-01; PRD FR-PS-6), verified against a
// REAL, migrated Postgres instance. Requires:
//   docker compose up -d
//   pnpm db:migrate
// Run via `pnpm test:db` — see durability.db.test.ts's own header
// comment for why this whole file's category is gated out of the
// default `pnpm test`.

import { randomUUID } from "node:crypto";
import { Engine, type Identifier, type InsertOperation, type Node } from "@collab-editor/engine";
import {
  decodeFrame,
  encodeFrame,
  encodeStructureSnapshotBody,
  operationToOpInsert,
  type OpsMessage,
} from "@collab-editor/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AckBatcher } from "../ackBatcher.js";
import { auditDocument } from "../audit.js";
import { loadConfig } from "../config.js";
import type { CoordinatorSession } from "../documentCoordinator.js";
import { DocumentCoordinator } from "../documentCoordinator.js";
import { toOperations } from "../ingest.js";
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

function insertMessageFor(op: InsertOperation) {
  return operationToOpInsert(op, 0);
}

const LOWERCASE_A = 0x61;
function letterAt(i: number): number {
  return LOWERCASE_A + (i % 26);
}

/**
 * One simulated client for DUR-01's "3-client editing session":
 * `engine` is that client's own INDEPENDENT view — its own local edits
 * apply to it directly (the same instant a real client's own would), and
 * a captured `ConnectionSendQueues` decodes every OPS frame the server
 * relays TO this client and applies it too, exactly reproducing what a
 * real `SyncClient` receiving a real broadcast would end up with. This
 * is deliberately NOT a real WebSocket/SyncClient/Playwright setup — the
 * phase brief's own instruction: "use your judgment on the lightest-
 * weight way to get 3 independent client perspectives into this test."
 * `engine.text()` stands in for DUR-01's line 7 ("every client's DOM
 * textContent") — there is no real DOM in this test, so this is the
 * client-side state a DOM would ultimately just be rendering.
 */
interface SimulatedClient {
  readonly session: CoordinatorSession;
  readonly engine: Engine;
}

function buildSimulatedClient(coordinator: DocumentCoordinator, label: string): SimulatedClient {
  const replicaId = coordinator.allocateReplicaId();
  const engine = new Engine(replicaId);
  const queues = new ConnectionSendQueues(
    (frame) => {
      // A relay TO this client — decode and apply, exactly as a real client's onMessage would.
      // Server-origin because this is what the server just sent, not what a client would send.
      try {
        const msg: OpsMessage = decodeFrame(frame, { direction: "serverOrigin" });
        if (msg.kind !== "opAck" && msg.kind !== "opReject") {
          for (const op of toOperations(msg)) {
            engine.applyRemote(op);
          }
        }
      } catch {
        // Not a decodable OPS frame relevant to this client engine (e.g. this session's own ack
        // batch, which this test doesn't need) — nothing to apply.
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

/**
 * A pure left-to-right append chain, built WITHOUT calling into a real
 * `Engine` — see snapshots.db.test.ts's own copy of this same helper for
 * the full reasoning (independently verified against `Engine.
localInsert`'s own source; duplicated here rather than imported since
 * these two test files don't otherwise share infrastructure and this is
 * a small, self-contained utility).
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

/** Bulk-seeds `documentId` with `count` sequential append operations, bypassing the real write path for speed (see snapshots.db.test.ts's own copy for the full reasoning) — used only by the "100,000-operation document" performance test, where fixture SETUP speed must not be confused with what's actually being measured (AUDIT() itself). */
async function seedAppendChainDocument(
  documentId: string,
  count: number,
  snapshotAtCount: number | null,
): Promise<InsertOperation[]> {
  const store = new PostgresOperationStore(pool);
  await store.warmStart(documentId);

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

describe("Phase 18 DUR-01 — log-replay integrity audit on a real 3-client session", () => {
  it("passes on a 5,000-operation, 3-client session, including a comparison against every client's own engine text", async () => {
    const documentId = randomUUID();
    const store = new PostgresOperationStore(pool);
    // A low op-threshold so at least one real snapshot is written along the way (DUR-01 step 2:
    // "wait for ... at least one snapshot") without needing 500 real operations from EACH client
    // just to cross the RFC default.
    const coordinator = new DocumentCoordinator(documentId, store, { opThreshold: 300 });
    await coordinator.ready;

    const clients = [
      buildSimulatedClient(coordinator, "Client A"),
      buildSimulatedClient(coordinator, "Client B"),
      buildSimulatedClient(coordinator, "Client C"),
    ];

    const TOTAL_OPS = 5_000;
    for (let i = 0; i < TOTAL_OPS; i++) {
      const client = clients[i % clients.length]!;
      const op = client.engine.localInsert(client.engine.text().length, letterAt(i));
      await processIncomingOperation({
        coordinator,
        session: client.session,
        msg: insertMessageFor(op),
      });
    }

    // Step 2: wait for quiescence (nothing async is still in flight from the loop above — every
    // `processIncomingOperation` call was awaited) and for at least one snapshot to exist.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM snapshots WHERE document_id = $1`,
      [documentId],
    );
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(1);

    // Steps 3-6, via the real AUDIT() implementation — liveText from the coordinator's own
    // engine gives this a full 6-step audit (the in-process-scheduler shape, not the CLI's
    // DB-only shape).
    const result = await auditDocument(documentId, store, { liveText: coordinator.engine.text() });
    expect(result.result).toBe("ok");
    expect(result.replayedToSeq).toBe(BigInt(TOTAL_OPS));

    // Step 7 (DUR-01's own wording: "every client's DOM textContent" — no real DOM exists in
    // this test, so each client's own independently-converged engine stands in for it, per the
    // phase brief's explicit permission).
    const genesisOps = await store.loadFullOperationLog(documentId);
    const genesisReplay = new Engine(0);
    for (const op of genesisOps) {
      genesisReplay.applyRemote(op);
    }
    const referenceText = genesisReplay.text();
    expect(referenceText).toHaveLength(TOTAL_OPS);
    for (const client of clients) {
      expect(client.engine.text()).toBe(referenceText);
    }
  }, 180_000);
});

describe("Phase 18 DoD — a corrupted snapshot is detected, bisected, and recorded", () => {
  it("detects corrupted snapshot content, BISECT identifies the exact seq, an audit_runs row is written, then restores cleanly", async () => {
    const documentId = randomUUID();
    const store = new PostgresOperationStore(pool);
    const coordinator = new DocumentCoordinator(documentId, store);
    await coordinator.ready;
    const client = buildSimulatedClient(coordinator, "Solo Client");

    for (let i = 0; i < 10; i++) {
      const op = client.engine.localInsert(i, letterAt(i));
      await processIncomingOperation({
        coordinator,
        session: client.session,
        msg: insertMessageFor(op),
      });
    }
    const correctContent = client.engine.text();
    await store.writeSnapshot({
      documentId,
      seq: coordinator.currentSeq,
      content: correctContent,
      structure: encodeStructureSnapshotBody(coordinator.engine.nodes),
      opCount: 10,
    });

    // Sanity: audit passes BEFORE corruption.
    const before = await auditDocument(documentId, store);
    expect(before.result).toBe("ok");

    // Deliberately corrupt the snapshot's content — a direct row UPDATE (`snapshots` carries no
    // append-only rule the way `operations` does, so this is a legal, ordinary UPDATE).
    await pool.query(`UPDATE snapshots SET content = 'CORRUPTED' WHERE document_id = $1`, [
      documentId,
    ]);

    const corrupted = await auditDocument(documentId, store);
    expect(corrupted.result).toBe("mismatch");
    expect(corrupted.divergenceSeq).toBe(coordinator.currentSeq); // the only snapshot — BISECT localizes to it
    expect(corrupted.detail).toContain(String(coordinator.currentSeq));

    // The audit_runs row itself — queryable, per the DoD's own wording.
    const runs = await store.listAuditRuns(documentId, 10);
    expect(
      runs.some((r) => r.result === "mismatch" && r.divergenceSeq === coordinator.currentSeq),
    ).toBe(true);

    // Restore.
    await pool.query(`UPDATE snapshots SET content = $2 WHERE document_id = $1`, [
      documentId,
      correctContent,
    ]);
    const restored = await auditDocument(documentId, store);
    expect(restored.result).toBe("ok");
  }, 30_000);
});

describe("Phase 18 DoD — pendingCount() catches what a text comparison would not", () => {
  it("an orphaned operation (missing causal dependency) fires the pendingCount() assertion, not a text mismatch", async () => {
    const documentId = randomUUID();
    const store = new PostgresOperationStore(pool);
    const coordinator = new DocumentCoordinator(documentId, store);
    await coordinator.ready;
    const client = buildSimulatedClient(coordinator, "Solo Client");

    const op = client.engine.localInsert(0, letterAt(0));
    await processIncomingOperation({
      coordinator,
      session: client.session,
      msg: insertMessageFor(op),
    });

    // `operations_no_delete` (Phase 15) makes it impossible to construct "a middle row was
    // deleted" via an actual DELETE — the same substitution Phase 16's durability.db.test.ts
    // already established for the identical reason: insert a SECOND row directly whose
    // `parent` references an identifier that was never, and will never be, provided by any
    // other row. This produces the exact same OBSERVABLE effect a deleted middle row would
    // (a permanently-unready operation), without needing to bypass a rule that correctly cannot
    // be bypassed.
    const orphan: InsertOperation = {
      kind: "insert",
      id: { c: 999, r: client.session.replicaId },
      value: letterAt(1),
      parent: { c: 424242, r: 424242 }, // never provided by any row, on purpose
      side: "R",
      bind: false,
    };
    await pool.query(
      `INSERT INTO operations (document_id, seq, stamp_r, stamp_c, author_session, author_user, kind, payload)
       VALUES ($1, $2, $3, $4, $5, $6, 'insert', $7)`,
      [
        documentId,
        "999",
        orphan.id.r,
        orphan.id.c,
        client.session.sessionId,
        client.session.userId,
        Buffer.from(encodeFrame(operationToOpInsert(orphan, 0))),
      ],
    );

    const result = await auditDocument(documentId, store);
    expect(result.result).toBe("error");
    expect(result.detail).toMatch(/never became ready/);
    expect(result.detail).toMatch(/Engine Spec I9/);

    const runs = await store.listAuditRuns(documentId, 10);
    expect(runs.some((r) => r.result === "error")).toBe(true);
  }, 30_000);
});

describe("Phase 18 DoD — audit performance on a large document", () => {
  it("audits a 100,000-operation document in under 30 seconds", async () => {
    const documentId = randomUUID();
    await seedAppendChainDocument(documentId, 100_000, 99_000);

    const store = new PostgresOperationStore(pool);
    const startedAt = performance.now();
    const result = await auditDocument(documentId, store);
    const elapsedMs = performance.now() - startedAt;

    expect(result.result).toBe("ok");
    expect(result.replayedToSeq).toBe(100_000n);
    expect(elapsedMs).toBeLessThan(30_000);
  }, 60_000);
});

describe("Phase 18 DoD — audit_runs is queryable, with a last-successful-run metric", () => {
  it("listAuditRuns and getLastSuccessfulAuditRunAt both reflect real recorded runs", async () => {
    const documentId = randomUUID();
    const store = new PostgresOperationStore(pool);
    const coordinator = new DocumentCoordinator(documentId, store);
    await coordinator.ready;
    const client = buildSimulatedClient(coordinator, "Solo Client");
    const op = client.engine.localInsert(0, letterAt(0));
    await processIncomingOperation({
      coordinator,
      session: client.session,
      msg: insertMessageFor(op),
    });

    expect(await store.getLastSuccessfulAuditRunAt(documentId)).toBeNull(); // nothing has run yet

    const beforeMs = Date.now();
    const result = await auditDocument(documentId, store);
    expect(result.result).toBe("ok");

    const lastSuccess = await store.getLastSuccessfulAuditRunAt(documentId);
    expect(lastSuccess).not.toBeNull();
    expect(lastSuccess!.getTime()).toBeGreaterThanOrEqual(beforeMs - 1000); // small clock-skew margin

    const runs = await store.listAuditRuns(documentId, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.result).toBe("ok");
    expect(runs[0]!.documentId).toBe(documentId);
  }, 30_000);
});
