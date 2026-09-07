// Phase 25 — Milestone M2, Test Plan DUR-02 (client-originated ledger reconciliation),
// verified against a REAL, migrated Postgres instance. Requires:
//   docker compose up -d
//   pnpm db:migrate
// Run via `pnpm test:db` — see durability.db.test.ts's own header comment for why this
// whole file's category is gated out of the default `pnpm test`.
//
// "4 clients, 10 minutes, ~12,000 operations" is scaled the same way every prior phase's own
// DB tests have scaled a literal wall-clock duration into a deterministic op count (Phase
// 17/18/21's own "fixture SETUP speed must not be confused with what's actually measured"
// precedent, applied here to the SCENARIO's own duration, not a fixture): this test drives
// exactly 12,000 operations through the real write path (matching the reference text's own
// number), never literally waiting 10 minutes — nothing in DUR-02's own three assertions
// depends on wall-clock pacing, only on operation COUNT and content.
//
// Each simulated client maintains its OWN local ledger, keyed by that operation's own origin
// stamp — exactly the reference text's own wording — recording every operation THAT CLIENT
// itself originated (never one it merely received via relay). After the full session:
//   1. every ledger entry's stamp appears EXACTLY ONCE in `operations` (document_id, stamp_r,
//      stamp_c) — real duplicate-suppression, not merely trusted from writePath.ts's own logic.
//   2. every INSERT ledger entry's effect is present in the final document OR is accounted for
//      by a specific later deletion (the coordinator's own `engine.nodes`, ground truth,
//      determines which).
//   3. no operation exists in the log that is in NO client's ledger — the direction usually
//      omitted, and the one that would catch a server/protocol layer FABRICATING or
//      duplicating an operation nobody ever actually originated.

import { randomUUID } from "node:crypto";
import { Engine, serializeId } from "@collab-editor/engine";
import {
  decodeFrame,
  operationToOpDelete,
  operationToOpInsert,
  type OpsMessage,
} from "@collab-editor/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AckBatcher } from "../ackBatcher.js";
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

const LOWERCASE_A = 0x61;
function letterAt(i: number): number {
  return LOWERCASE_A + (i % 26);
}

/** One ledger entry per operation THIS client originated — DUR-02's own "keyed by origin stamp". */
interface LedgerEntry {
  readonly stampKey: string;
  readonly kind: "insert" | "delete";
}

interface SimulatedClient {
  readonly session: CoordinatorSession;
  readonly engine: Engine;
  readonly ledger: LedgerEntry[];
}

function buildSimulatedClient(coordinator: DocumentCoordinator, label: string): SimulatedClient {
  const replicaId = coordinator.allocateReplicaId();
  const engine = new Engine(replicaId);
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
        // Not a decodable OPS frame this client cares about.
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
  return { session, engine, ledger: [] };
}

describe("Phase 25 DUR-02 — client-originated ledger reconciliation", () => {
  it(
    "4 clients / 12,000 operations: every ledger entry appears exactly once, its effect is present or accounted for, and no operation exists in the log that is in no client's ledger",
    async () => {
      const documentId = randomUUID();
      const store = new PostgresOperationStore(pool);
      const coordinator = new DocumentCoordinator(documentId, store);
      await coordinator.ready;

      const clients: SimulatedClient[] = [
        buildSimulatedClient(coordinator, "Client A"),
        buildSimulatedClient(coordinator, "Client B"),
        buildSimulatedClient(coordinator, "Client C"),
        buildSimulatedClient(coordinator, "Client D"),
      ];

      // A small, fixed PRNG (mulberry32-shaped, matching this project's own Phase 2 fuzz-harness
      // convention) so a failing run is reproducible from its own printed seed, rather than
      // relying on Math.random()'s own non-reproducible sequence for a 12,000-operation session.
      let seed = 0x5eed_2502;
      function nextRandom(): number {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      }

      const TOTAL_OPS = 12_000;
      let valueCounter = 0;
      for (let i = 0; i < TOTAL_OPS; i++) {
        const client = clients[Math.floor(nextRandom() * clients.length)]!;
        const text = client.engine.text();
        // ~70% inserts, ~30% deletes (once there's something to delete) — "clients typing
        // continuously" with ordinary backspacing mixed in, not a pure append-only stream.
        const wantDelete = text.length > 0 && nextRandom() < 0.3;
        if (wantDelete) {
          const pos = Math.floor(nextRandom() * text.length);
          // A single visible unit always exists at `pos` here (0 <= pos < text.length, checked
          // above against this SAME client's own current view) -- localDelete(pos, 1) is
          // structurally guaranteed to return exactly one op.
          const deleteOp = client.engine.localDelete(pos, 1)[0]!;
          client.ledger.push({ stampKey: serializeId(deleteOp.id), kind: "delete" });
          await processIncomingOperation({
            coordinator,
            session: client.session,
            msg: operationToOpDelete(deleteOp, 0),
          });
        } else {
          const pos = Math.floor(nextRandom() * (text.length + 1));
          const insertOp = client.engine.localInsert(pos, letterAt(valueCounter));
          valueCounter += 1;
          client.ledger.push({ stampKey: serializeId(insertOp.id), kind: "insert" });
          await processIncomingOperation({
            coordinator,
            session: client.session,
            msg: operationToOpInsert(insertOp, 0),
          });
        }
      }

      // Quiescence check before reconciling: no client should still have anything buffered —
      // every operation above was awaited through the real write path and its real broadcast
      // relay, so nothing should be mid-flight.
      for (const client of clients) {
        expect(client.engine.pending.length).toBe(0);
      }
      expect(coordinator.engine.pending.length).toBe(0);

      // Ground truth for assertion 2 ("its effect is present... or accounted for by a specific
      // later deletion") — the coordinator's OWN engine nodes, by id.
      const nodesById = new Map(
        coordinator.engine.nodes.map((n) => [serializeId(n.id), n] as const),
      );

      // Assertions 1 and 2, per client, per ledger entry.
      let allLedgerStamps = 0;
      for (const client of clients) {
        for (const entry of client.ledger) {
          allLedgerStamps += 1;
          // serializeId() format is "c:r" (Identifier's own counter-then-replica order), not "r:c".
          const [stampC, stampR] = entry.stampKey.split(":").map(Number);
          const { rows } = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM operations WHERE document_id = $1 AND stamp_r = $2 AND stamp_c = $3`,
            [documentId, stampR, stampC],
          );
          // Assertion 1: appears EXACTLY once.
          expect(Number(rows[0]!.count)).toBe(1);

          if (entry.kind === "insert") {
            const node = nodesById.get(entry.stampKey);
            expect(node).toBeDefined(); // an insert's own node must always exist in the final structure — Engine Spec I5
            // Assertion 2: present in the final document (not deleted) OR its own tombstone
            // names a specific, real deletion (`deletedBy` is set to a real delete's id, never
            // a placeholder) — either is a valid account of the operation's effect.
            expect(node!.deleted === false || node!.deletedBy !== null).toBe(true);
          }
        }
      }
      expect(allLedgerStamps).toBe(TOTAL_OPS);

      // Assertion 3 — the direction usually omitted: every row in the durable log traces back
      // to SOME client's own ledger. Since every stamp is Engine-Spec-I1-guaranteed unique,
      // "the durable row count equals the sum of every client's ledger size" is the same claim
      // as "no operation exists in the log that no client ever originated" — a server/protocol
      // bug that fabricated or duplicated an operation would inflate this count without a
      // matching ledger entry to justify it.
      const { rows: totalRows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM operations WHERE document_id = $1`,
        [documentId],
      );
      expect(Number(totalRows[0]!.count)).toBe(allLedgerStamps);
    },
    300_000,
  );
});
