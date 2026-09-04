// The persistence abstraction the write path (writePath.ts, API Spec §6.3)
// commits through. Deliberately an interface with two implementations,
// not a hard-wired `pg.Pool` dependency directly in the write path or
// DocumentCoordinator: every EXISTING server test that builds a real
// server (gateway.test.ts, httpApp.test.ts, and client's
// headlessHarness.test.ts, part of the default `pnpm test`) predates
// Phase 16 and doesn't care about persistence — forcing them to require a
// real Postgres instance would break `pnpm test`'s infra-free property,
// the same property Phase 15 deliberately preserved by gating its own
// schema tests behind `pnpm test:db` instead of the default run. This
// split achieves the same thing one layer down: PRODUCTION always uses
// `PostgresOperationStore` (server.ts/index.ts), and only Phase 16's OWN
// new tests (packages/server/src/db/*.db.test.ts, `pnpm test:db`) ever
// construct one.
//
// Auto-provisioning, and why it reaches THREE tables, not one: `warmStart`
// ensures a `documents` row (owned by a fixed placeholder SYSTEM_USER_ID)
// exists; `commitOperations` separately ensures a PER-SESSION `users` row
// and a `sessions` row exist, because `operations.author_session
// REFERENCES sessions(id)` and `sessions.user_id REFERENCES users(id)` —
// neither of which `documents`'s own provisioning touches. Discovered by
// actually running the write path against a real database: the first
// attempt provisioned only `documents`/`users` for the document's OWNER,
// and every real commit failed on `operations_author_session_fkey` since
// nothing had ever created a row for the CONNECTING session's own
// identity. No auth exists until Phases 26-29, so every session's
// `users`/`sessions` rows are placeholders — but per-session, not
// collapsed onto one shared identity, so `author_user` still carries the
// same thin per-connection signal Phase 8's random-UUID-per-session
// already established.

import { randomUUID } from "node:crypto";
import type { Identifier, Node, Operation } from "@collab-editor/engine";
import { serializeId } from "@collab-editor/engine";
import {
  decodeFrame,
  decodeStructureSnapshotBody,
  encodeFrame,
  operationToOpDelete,
  operationToOpInsert,
  operationToOpUndelete,
} from "@collab-editor/protocol";
import { toOperations } from "../ingest.js";
import type { DbPool } from "./pool.js";

/**
 * A fixed placeholder identity (Phase 16 scope table's own decision:
 * "auto-provision a documents/users row on first connection, mirroring
 * Phase 8/9's existing no-auth stance"). NOT a real user — real
 * users/ownership don't exist until Phase 26-29. Every document this
 * server has ever touched is durably owned by this one row until then.
 */
export const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000000";
const SYSTEM_USER_EMAIL = "system@collab-editor.internal";
const SYSTEM_USER_DISPLAY_NAME = "System";
// Deliberately unusable as a real password hash — same reasoning as Phase
// 15's seed script (scripts/seed.ts): password hashing doesn't exist
// until auth (Phases 26-29), and users.password_hash is NOT NULL, so
// provisioning needs SOME value; this one can never be mistaken for real.
const SYSTEM_USER_PASSWORD_HASH_PLACEHOLDER = "unset:not-a-real-hash:phase-26-29";

export interface CommitOperationsInput {
  readonly documentId: string;
  /** The first operation's seq — operations.seq is per-OPERATION (see writePath.ts's own doc comment for why), so a run/batch of N operations occupies `startSeq .. startSeq + ops.length - 1`. */
  readonly startSeq: bigint;
  readonly ops: readonly Operation[];
  readonly authorSession: string;
  readonly authorUser: string;
  /**
   * The session's OBSEQ replica id and display name — needed only to
   * auto-provision `users`/`sessions` rows for `authorUser`/
   * `authorSession` the first time this session ever commits (see this
   * store's own header comment on auto-provisioning: `operations.
author_session REFERENCES sessions(id)`, and `sessions.user_id
   * REFERENCES users(id)` for a PER-SESSION placeholder user, distinct
   * from `documents.owner_id`'s single shared SYSTEM_USER_ID — real
   * per-user identity doesn't exist until auth, Phases 26-29, but
   * collapsing every author onto one shared row would throw away even
   * the thin per-session identity signal Phase 8 already established).
   */
  readonly replicaId: number;
  readonly displayName: string;
}

/**
 * One operation from `warmStart`'s suffix replay, carrying what
 * `engine.applyRemote`'s optional GC context needs (Phase 21, Engine Spec
 * §7.3) — `seq` (for causal-stability) and `committedAtMs` (for the undo
 * horizon, §7.7), sourced from `operations.committed_at`. That column's
 * own comment says "observability ONLY; never read for ordering (PRD
 * FR-CE-2)" — reading it here is not an ordering use (GC's age check
 * never decides WHERE an operation integrates, only WHEN a tombstone
 * becomes eligible for physical removal), so this does not violate that
 * constraint. Without this, a delete replayed after a server restart
 * would carry no GC context at all (the pre-Phase-21 shape of
 * `WarmStartResult.suffixOps: Operation[]`) and could never become
 * collectible until superseded by a fresh delete — a real, if gradual,
 * effectiveness regression for any long-lived document that survives a
 * restart, not merely a cosmetic gap.
 */
export interface WarmStartSuffixOperation {
  readonly op: Operation;
  readonly seq: bigint;
  readonly committedAtMs: number;
}

export interface WarmStartResult {
  /**
   * The latest snapshot's decoded node structure (Phase 17, API Spec
   * §2.7/§6.4), or `null` if this document has never been snapshotted
   * yet — a coordinator's `engine` must be seeded from these nodes
   * BEFORE replaying `suffixOps`, since `suffixOps` only covers what
   * happened AFTER this snapshot was taken, not the document's full
   * history from genesis. This is the entire point of Phase 17: warm
   * start no longer needs to replay every operation a document has ever
   * had — only the snapshot (one row) plus whatever's happened since.
   */
  readonly snapshotNodes: readonly Node[] | null;
  /** The snapshot's own `seq` (0n if `snapshotNodes` is null — genesis) — `suffixOps` is exactly the operations with `seq > snapshotSeq`. */
  readonly snapshotSeq: bigint;
  /** Operations with `seq > snapshotSeq`, in seq order — replay these (and ONLY these) on top of `snapshotNodes` to reach the document's current state. Carries `seq`/`committedAtMs` (Phase 21) so GC context survives a restart. */
  readonly suffixOps: readonly WarmStartSuffixOperation[];
  /** `documents.current_seq` AFTER provisioning — the highest seq ever assigned for this document, including seq values "spent" on a resent duplicate that hit ON CONFLICT DO NOTHING (see commitOperations's own doc comment) and therefore left no row of their own. This, not `MAX(operations.seq)` or `ops.length`, is what a coordinator must resume numbering from — using either of those instead would eventually reissue an already-spent seq and crash on the operations table's own PRIMARY KEY the moment a genuinely new operation collided with it. */
  readonly currentSeq: bigint;
}

/** One row of `snapshots`, content only — audit.ts's bisect (Phase 18) only ever needs `content` for the byte comparison, never `structure`; a separate, lighter query than `warmStart`'s (which needs `structure` to seed an engine). */
export interface SnapshotRecord {
  readonly seq: bigint;
  readonly content: string;
}

/** One row of `operations`, WITH its seq — `loadFullOperationLog` (Phase 17) deliberately drops seq, since neither of its two consumers (httpApp.ts's diagnostic endpoints, Phase 17's own genesis-replay comparison) needed it. Phase 18's audit does: bisect needs to know exactly WHICH seq a given operation came from to report a divergence point, and the pendingCount()!==0 error path needs it to identify which persisted operation(s) never became ready. */
export interface SeqOperation {
  readonly seq: bigint;
  readonly op: Operation;
}

/** API Spec §2.8 / §6.6 — one row of `audit_runs`. `result`/`divergenceSeq`/`detail` are exactly the columns AUDIT() (audit.ts) decides; `id`/`ranAt` are assigned by the database. */
export interface AuditRunInput {
  readonly documentId: string;
  readonly replayedToSeq: bigint;
  readonly result: "ok" | "mismatch" | "error";
  readonly divergenceSeq: bigint | null;
  readonly detail: string | null;
}

export interface AuditRunRow extends AuditRunInput {
  readonly id: string;
  readonly ranAt: Date;
}

export interface WriteSnapshotInput {
  readonly documentId: string;
  /** State AFTER applying operations up to and including this seq (API Spec §2.7's own column comment) — always `coordinator.currentSeq` AT THE MOMENT the snapshot is actually taken, which may be later (and higher) than whatever seq was current when the snapshot was first SCHEDULED, since writing runs off the hot path (snapshotter.ts). */
  readonly seq: bigint;
  /** `engine.text()` — the materialized visible text at `seq`. What the integrity audit compares a log replay against (never structure, RFC §13.2 — see this file's own note on snapshot non-determinism). */
  readonly content: string;
  /** `encodeStructureSnapshotBody(engine.nodes)` — full node structure, tombstones included. */
  readonly structure: Uint8Array;
  /** Operations committed since the PREVIOUS snapshot — the DoD's own "~500" observable. */
  readonly opCount: number;
}

/** API Spec §6.5 / Engine Spec Definition 7.1 — one session's liveness/ack heartbeat, upserted at JOIN time and on every PING so `sessions.last_ack_seq`/`last_seen_at` (the GC stability frontier's own raw material) are actually kept current. Before Phase 21, both columns existed in the schema (Phase 15) but nothing ever wrote them outside the one-time auto-provisioning insert `commitOperations` does on a session's FIRST commit — a session that only ever READS (never commits an operation) would otherwise never appear in the frontier query at all. */
export interface SessionHeartbeatInput {
  readonly sessionId: string;
  readonly documentId: string;
  readonly userId: string;
  readonly replicaId: number;
  readonly displayName: string;
  readonly lastAckSeq: bigint;
}

export interface OperationStore {
  /**
   * Ensures a `documents` row (and its placeholder `users` owner row)
   * exists for `documentId`, then loads everything a coordinator needs to
   * warm-start (API Spec §6.2, extended by Phase 17's §6.4): the latest
   * snapshot (if any) plus only the operation-log SUFFIX after it, and
   * the current seq watermark to resume numbering from.
   */
  warmStart(documentId: string): Promise<WarmStartResult>;

  /**
   * The FULL persisted operation log for a document, genesis to present,
   * ignoring any snapshot entirely — Phase 17 deliberately keeps this
   * separate from `warmStart`'s snapshot-optimized path. Used only by
   * httpApp.ts's diagnostic `/replay`/`/replay-nodes` endpoints (Test
   * Plan §2.7 E2E-CONV-01 assertion 3's independent ground truth) and by
   * this phase's own DoD test proving warm start's snapshot+suffix
   * result is byte-identical to a full genesis replay — both genuinely
   * want genesis, on purpose, not the fast path.
   */
  loadFullOperationLog(documentId: string): Promise<Operation[]>;

  /** Same query as {@link loadFullOperationLog}, but keeping each operation's own `seq` — audit.ts's (Phase 18) bisect and pendingCount()-error reporting both need to name a specific seq, which the seq-stripped version can't provide. */
  loadFullOperationLogWithSeq(documentId: string): Promise<SeqOperation[]>;

  /**
   * Phase 23 (API Spec §3.6.4-§3.6.5, CATCHUP): operations with
   * `fromSeqExclusive < seq <= toSeqInclusive`, in ascending seq order —
   * exactly the delta a reconnecting client with a resident engine needs
   * to replay on top of its own existing structure. Reads from the SAME
   * durable, never-pruned `operations` table `loadFullOperationLog` does
   * (not the live, GC-able in-memory engine — Phase 21's tombstone
   * collection physically removes nodes from `coordinator.engine` once
   * causally stable, but never touches this table), so a delta computed
   * here is correct regardless of how aggressively GC has run in the
   * meantime.
   */
  loadOperationLogRange(
    documentId: string,
    fromSeqExclusive: bigint,
    toSeqInclusive: bigint,
  ): Promise<SeqOperation[]>;

  /**
   * Phase 23 (API Spec §3.6.7, ALREADY_HAVE): of `stamps`, the subset that
   * already has a committed row in `operations` for this document — i.e.
   * origin stamps the server durably has, regardless of whether their
   * author ever received the OP_ACK for them (the exact RC-33d/RC-28
   * race: committed, but the ack was lost when the socket died). Queried
   * against durable storage, never the live engine's structure, for the
   * same GC-independence reason as {@link loadOperationLogRange} — a
   * stamp whose tombstone was already physically collected from
   * `coordinator.engine` must still be reported as "already have," or a
   * reconnecting client would wrongly re-mint and duplicate it.
   */
  findExistingStamps(documentId: string, stamps: readonly Identifier[]): Promise<Identifier[]>;

  /** Persists one snapshot row (API Spec §2.7, Phase 17 §6.4) — see snapshotter.ts for when this is called and why it's never awaited from the write path itself. */
  writeSnapshot(input: WriteSnapshotInput): Promise<void>;

  /** The latest snapshot's `seq`/`content` (content only — see {@link SnapshotRecord}'s own comment), or `null` if none exists yet. AUDIT() step 1/4 (API Spec §6.6, audit.ts). */
  getLatestSnapshot(documentId: string): Promise<SnapshotRecord | null>;

  /** EVERY persisted snapshot for a document, ascending by `seq` — used only by bisect (audit.ts, Phase 18) when the latest snapshot's content fails the byte comparison, to localize which snapshot (there may be several, one per historical MAYBE-SNAPSHOT trigger) is the first one whose content disagrees with an independent genesis replay to that same seq. */
  listSnapshots(documentId: string): Promise<SnapshotRecord[]>;

  /** Persists one `audit_runs` row (API Spec §2.8, §6.6) — the permanent record AUDIT() leaves behind on every run, not only on failure (a healthy run's own `result: 'ok'` row is what "last successful run" — the DoD's own metric — is computed from). */
  writeAuditRun(input: AuditRunInput): Promise<void>;

  /** Most recent `audit_runs` rows for a document, newest first — the DoD's "audit_runs rows are queryable" requirement, served by httpApp.ts's own endpoint. */
  listAuditRuns(documentId: string, limit: number): Promise<AuditRunRow[]>;

  /** `ran_at` of the most recent `result: 'ok'` row for a document, or `null` if the document has never passed an audit — the DoD's own "'last successful run' timestamp is exposed as a metric" requirement. */
  getLastSuccessfulAuditRunAt(documentId: string): Promise<Date | null>;

  /**
   * API Spec §6.3 step 8, ONE transaction for the WHOLE incoming message
   * (not one transaction per underlying operation) — BEGIN, then one
   * INSERT per operation (ON CONFLICT (document_id, stamp_r, stamp_c) DO
   * NOTHING — layer 3 duplicate suppression, API Spec §9.1), then one
   * UPDATE documents SET current_seq, then COMMIT. Resolves ONLY once
   * that transaction has actually committed — this is the durability
   * promise the write path's ack depends on.
   *
   * A resent duplicate (same stamp, reassigned a NEW seq by step 6 before
   * this is ever called — the write path doesn't dedupe before assigning
   * seq, only this INSERT's ON CONFLICT does) commits its row exactly
   * once: the retry's INSERT is silently skipped, and the seq value it
   * was assigned is left unused by any row. That gap is a deliberate,
   * accepted consequence — a range scan reconnection query doesn't care
   * about contiguity, and the alternative (checking for an existing stamp
   * BEFORE assigning seq) isn't one of API Spec §6.3's nine listed steps.
   */
  commitOperations(input: CommitOperationsInput): Promise<{ readonly insertedCount: number }>;

  /**
   * Engine Spec Definition 7.1/7.2 — upserts one session's ack watermark and liveness
   * timestamp. Called at JOIN time (so a session that never commits an operation still
   * appears in the frontier query) and on every PING (§3.6.11) thereafter. `ON CONFLICT (id)
   * DO UPDATE` rather than a separate insert-then-update: a session's row may or may not
   * exist yet (JOIN is the first write for it), and this must be idempotent across repeated
   * PINGs regardless.
   */
  upsertSessionHeartbeat(input: SessionHeartbeatInput): Promise<void>;

  /**
   * API Spec §6.5 / Engine Spec Definition 7.2 — the GC stability frontier F: the MINIMUM
   * `last_ack_seq` across sessions active within the offline window (Rule 7.1, 10 minutes —
   * a session whose `last_seen_at` has aged past that is evicted from the frontier simply by
   * falling out of this query's own WHERE clause, no separate eviction bookkeeping needed).
   * COALESCEs to `documents.current_seq` when no session is currently active — cold-load
   * compaction: with nobody connected, EVERYTHING durably committed is by definition stable,
   * so GC can collect anything otherwise eligible.
   */
  getStabilityFrontier(documentId: string): Promise<bigint>;
}

/** Re-encodes one engine Operation as the single-op OPS message it corresponds to, seq=0 (a placeholder — the real seq lives in the `operations.seq` column, never inside the payload itself) — reuses Phase 7's fully-tested codec rather than inventing a second serialization format for the same data. */
function encodeOperationPayload(op: Operation): Buffer {
  const msg =
    op.kind === "insert"
      ? operationToOpInsert(op, 0)
      : op.kind === "delete"
        ? operationToOpDelete(op, 0)
        : operationToOpUndelete(op, 0);
  return Buffer.from(encodeFrame(msg));
}

/** Inverse of {@link encodeOperationPayload}. `direction: "clientOrigin"` is required (not incidental) because it's the only direction decodeFrame accepts a seq === 0 frame under — exactly what encodeOperationPayload always writes. */
function decodeOperationPayload(payload: Buffer): Operation {
  const msg = decodeFrame(new Uint8Array(payload), { direction: "clientOrigin" });
  const ops = toOperations(msg);
  const op = ops[0];
  if (!op || ops.length !== 1) {
    throw new Error(
      `decodeOperationPayload: expected exactly one operation, got ${ops.length} — payload is corrupt`,
    );
  }
  return op;
}

/** True for a Postgres unique-constraint violation (SQLSTATE 23505) — the error `operations_stamp_uq` raises for a resent duplicate stamp under the SAVEPOINT-based retry scheme (see commitOperations's own comment for why this replaces ON CONFLICT here). `pg` attaches the raw SQLSTATE as `.code` on the thrown error; narrowed via a runtime check since the `pg` error type itself is untyped `Error`. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

export class PostgresOperationStore implements OperationStore {
  constructor(private readonly pool: DbPool) {}

  async warmStart(documentId: string): Promise<WarmStartResult> {
    // ON CONFLICT (id) DO NOTHING makes both inserts idempotent — safe to run on every
    // coordinator construction, including a document this server has already provisioned.
    await this.pool.query(
      `INSERT INTO users (id, email, display_name, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [
        SYSTEM_USER_ID,
        SYSTEM_USER_EMAIL,
        SYSTEM_USER_DISPLAY_NAME,
        SYSTEM_USER_PASSWORD_HASH_PLACEHOLDER,
      ],
    );
    await this.pool.query(
      `INSERT INTO documents (id, owner_id)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [documentId, SYSTEM_USER_ID],
    );

    // Phase 17: the latest snapshot (served directly by snapshots_latest_idx, Phase 15) plus
    // only the operations AFTER it — this is the whole point of snapshotting, replacing what
    // used to be an unconditional full-genesis SELECT (kept, unchanged, as loadFullOperationLog
    // below for the diagnostic/audit callers that genuinely want genesis).
    const { rows: snapRows } = await this.pool.query<{ seq: string; structure: Buffer }>(
      `SELECT seq, structure FROM snapshots WHERE document_id = $1 ORDER BY seq DESC LIMIT 1`,
      [documentId],
    );
    const snapshotRow = snapRows[0];
    const snapshotSeq = snapshotRow ? BigInt(snapshotRow.seq) : 0n;
    const snapshotNodes = snapshotRow
      ? decodeStructureSnapshotBody(new Uint8Array(snapshotRow.structure))
      : null;

    const { rows: opRows } = await this.pool.query<{
      seq: string;
      payload: Buffer;
      committed_at: Date;
    }>(
      `SELECT seq, payload, committed_at FROM operations WHERE document_id = $1 AND seq > $2 ORDER BY seq ASC`,
      [documentId, snapshotSeq.toString()],
    );
    const { rows: docRows } = await this.pool.query<{ current_seq: string }>(
      `SELECT current_seq FROM documents WHERE id = $1`,
      [documentId],
    );
    return {
      snapshotNodes,
      snapshotSeq,
      suffixOps: opRows.map((r) => ({
        op: decodeOperationPayload(r.payload),
        seq: BigInt(r.seq),
        committedAtMs: r.committed_at.getTime(),
      })),
      currentSeq: docRows[0] ? BigInt(docRows[0].current_seq) : 0n,
    };
  }

  async loadFullOperationLog(documentId: string): Promise<Operation[]> {
    const seqOps = await this.loadFullOperationLogWithSeq(documentId);
    return seqOps.map((r) => r.op);
  }

  async loadFullOperationLogWithSeq(documentId: string): Promise<SeqOperation[]> {
    const { rows } = await this.pool.query<{ seq: string; payload: Buffer }>(
      `SELECT seq, payload FROM operations WHERE document_id = $1 ORDER BY seq ASC`,
      [documentId],
    );
    return rows.map((r) => ({ seq: BigInt(r.seq), op: decodeOperationPayload(r.payload) }));
  }

  async loadOperationLogRange(
    documentId: string,
    fromSeqExclusive: bigint,
    toSeqInclusive: bigint,
  ): Promise<SeqOperation[]> {
    const { rows } = await this.pool.query<{ seq: string; payload: Buffer }>(
      `SELECT seq, payload FROM operations
        WHERE document_id = $1 AND seq > $2 AND seq <= $3
        ORDER BY seq ASC`,
      [documentId, fromSeqExclusive.toString(), toSeqInclusive.toString()],
    );
    return rows.map((r) => ({ seq: BigInt(r.seq), op: decodeOperationPayload(r.payload) }));
  }

  async findExistingStamps(
    documentId: string,
    stamps: readonly Identifier[],
  ): Promise<Identifier[]> {
    if (stamps.length === 0) {
      return [];
    }
    // (stamp_r, stamp_c) tuple membership against the caller's own list, via UNNEST — the same
    // parallel-array technique Phase 15/17's own bulk-insert fixtures already established for
    // this codebase, applied here to a read instead of a write.
    const rs = stamps.map((s) => s.r);
    const cs = stamps.map((s) => s.c);
    const { rows } = await this.pool.query<{ stamp_r: string; stamp_c: string }>(
      `SELECT o.stamp_r, o.stamp_c
         FROM operations o
         JOIN UNNEST($2::bigint[], $3::bigint[]) AS t(r, c) ON o.stamp_r = t.r AND o.stamp_c = t.c
        WHERE o.document_id = $1`,
      [documentId, rs, cs],
    );
    return rows.map((r) => ({ r: Number(r.stamp_r), c: Number(r.stamp_c) }));
  }

  async writeSnapshot(input: WriteSnapshotInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO snapshots (document_id, seq, content, structure, op_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.documentId,
        input.seq.toString(),
        input.content,
        Buffer.from(input.structure),
        input.opCount,
      ],
    );
  }

  async getLatestSnapshot(documentId: string): Promise<SnapshotRecord | null> {
    // Served directly by snapshots_latest_idx (document_id, seq DESC) — Phase 15.
    const { rows } = await this.pool.query<{ seq: string; content: string }>(
      `SELECT seq, content FROM snapshots WHERE document_id = $1 ORDER BY seq DESC LIMIT 1`,
      [documentId],
    );
    const row = rows[0];
    return row ? { seq: BigInt(row.seq), content: row.content } : null;
  }

  async listSnapshots(documentId: string): Promise<SnapshotRecord[]> {
    const { rows } = await this.pool.query<{ seq: string; content: string }>(
      `SELECT seq, content FROM snapshots WHERE document_id = $1 ORDER BY seq ASC`,
      [documentId],
    );
    return rows.map((r) => ({ seq: BigInt(r.seq), content: r.content }));
  }

  async writeAuditRun(input: AuditRunInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_runs (id, document_id, replayed_to_seq, result, divergence_seq, detail)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [
        input.documentId,
        input.replayedToSeq.toString(),
        input.result,
        input.divergenceSeq === null ? null : input.divergenceSeq.toString(),
        input.detail,
      ],
    );
  }

  async listAuditRuns(documentId: string, limit: number): Promise<AuditRunRow[]> {
    const { rows } = await this.pool.query<{
      id: string;
      document_id: string;
      replayed_to_seq: string;
      result: "ok" | "mismatch" | "error";
      divergence_seq: string | null;
      detail: string | null;
      ran_at: Date;
    }>(
      `SELECT id, document_id, replayed_to_seq, result, divergence_seq, detail, ran_at
         FROM audit_runs WHERE document_id = $1 ORDER BY ran_at DESC LIMIT $2`,
      [documentId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      replayedToSeq: BigInt(r.replayed_to_seq),
      result: r.result,
      divergenceSeq: r.divergence_seq === null ? null : BigInt(r.divergence_seq),
      detail: r.detail,
      ranAt: r.ran_at,
    }));
  }

  async getLastSuccessfulAuditRunAt(documentId: string): Promise<Date | null> {
    const { rows } = await this.pool.query<{ ran_at: Date }>(
      `SELECT ran_at FROM audit_runs WHERE document_id = $1 AND result = 'ok' ORDER BY ran_at DESC LIMIT 1`,
      [documentId],
    );
    return rows[0]?.ran_at ?? null;
  }

  async commitOperations(
    input: CommitOperationsInput,
  ): Promise<{ readonly insertedCount: number }> {
    if (input.ops.length === 0) {
      return { insertedCount: 0 };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Auto-provision THIS session's own users/sessions rows (see this file's header comment
      // for why documents/warmStart's provisioning alone isn't enough) — ON CONFLICT DO NOTHING
      // makes both idempotent across this session's many commits, all within the same
      // transaction as the operations themselves so a session row can never exist without a
      // users row backing it, or vice versa.
      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [
          input.authorUser,
          `${input.authorUser}@placeholder.collab-editor.internal`,
          input.displayName,
          SYSTEM_USER_PASSWORD_HASH_PLACEHOLDER,
        ],
      );
      await client.query(
        `INSERT INTO sessions (id, user_id, document_id, replica_id, role_at_connect)
         VALUES ($1, $2, $3, $4, 'editor')
         ON CONFLICT (id) DO NOTHING`,
        [input.authorSession, input.authorUser, input.documentId, input.replicaId],
      );

      // NOT `ON CONFLICT (document_id, stamp_r, stamp_c) DO NOTHING`, even though that's the
      // obvious way to express "skip a duplicate stamp" — Postgres flatly REFUSES `INSERT ...
      // ON CONFLICT` on any table that has a `CREATE RULE` defined on it, and `operations` has
      // two (`operations_no_update`/`operations_no_delete`, Phase 15, verbatim from the spec,
      // not something Phase 16 may change): "ERROR: INSERT with ON CONFLICT clause cannot be
      // used with table that has INSERT or UPDATE rules". Discovered only by actually running
      // this against a real Postgres instance — every earlier phase's own EXPLAIN/constraint
      // tests happened to never combine ON CONFLICT with a ruled table before. The functionally
      // equivalent alternative that doesn't touch the schema: a plain INSERT per row inside its
      // own SAVEPOINT, catching a unique_violation (SQLSTATE 23505) on `operations_stamp_uq`
      // and rolling back JUST that savepoint — the rest of the transaction (other rows in this
      // same batch, the UPDATE below, the COMMIT) is unaffected, exactly matching what ON
      // CONFLICT DO NOTHING would have done if it were legal here.
      let insertedCount = 0;
      for (let i = 0; i < input.ops.length; i++) {
        const op = input.ops[i]!;
        const seq = input.startSeq + BigInt(i);
        const savepoint = `op_${i}`; // unique within this call; i is a loop counter, never user input
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          await client.query(
            `INSERT INTO operations (document_id, seq, stamp_r, stamp_c, author_session, author_user, kind, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              input.documentId,
              seq.toString(),
              op.id.r,
              op.id.c,
              input.authorSession,
              input.authorUser,
              op.kind,
              encodeOperationPayload(op),
            ],
          );
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          insertedCount += 1;
        } catch (err) {
          if (isUniqueViolation(err)) {
            // A resent duplicate — this exact (document_id, stamp_r, stamp_c) already has a
            // row. Roll back only this row's savepoint (the transaction as a whole is still
            // healthy) and move on without counting it.
            await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          } else {
            throw err; // a genuine error — let the outer catch below abort the whole commit
          }
        }
      }
      const endSeq = input.startSeq + BigInt(input.ops.length) - 1n;
      await client.query(
        `UPDATE documents SET current_seq = GREATEST(current_seq, $2) WHERE id = $1`,
        [input.documentId, endSeq.toString()],
      );
      await client.query("COMMIT");
      return { insertedCount };
    } catch (err) {
      // Best-effort — if the connection itself is what failed, ROLLBACK will fail too, and
      // that's fine: a dead connection can't have left a transaction half-committed either.
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertSessionHeartbeat(input: SessionHeartbeatInput): Promise<void> {
    // Same per-session auto-provisioning as commitOperations (this store's own header
    // comment) — a session that joins but never commits an operation still needs a real
    // `users` row for `sessions.user_id`'s FK, and this may be the FIRST write that session
    // ever makes (JOIN happens before any operation is necessarily sent).
    await this.pool.query(
      `INSERT INTO users (id, email, display_name, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [
        input.userId,
        `${input.userId}@placeholder.collab-editor.internal`,
        input.displayName,
        SYSTEM_USER_PASSWORD_HASH_PLACEHOLDER,
      ],
    );
    await this.pool.query(
      `INSERT INTO sessions (id, user_id, document_id, replica_id, role_at_connect, last_ack_seq, last_seen_at)
       VALUES ($1, $2, $3, $4, 'editor', $5, now())
       ON CONFLICT (id) DO UPDATE
         SET last_ack_seq = GREATEST(sessions.last_ack_seq, EXCLUDED.last_ack_seq),
             last_seen_at = now()`,
      [input.sessionId, input.userId, input.documentId, input.replicaId, input.lastAckSeq.toString()],
    );
  }

  async getStabilityFrontier(documentId: string): Promise<bigint> {
    // 10 minutes, NOT the 8-second presence-stale threshold. These are different
    // timers and merging them is a correctness bug: evicting at 8s lets GC collect
    // tombstones a client mid-tunnel still needs as anchors, stranding its operations
    // forever. API Spec §11.4; the failure trace is Engine Spec §10.3.
    //
    // sessions_frontier_idx (document_id, last_seen_at, last_ack_seq — Phase 15's own schema
    // comment anticipated exactly this query) serves the WHERE + MIN directly. The 10-minute
    // window is Rule 7.1's own literal value (heartbeat.ts's `SESSION_INACTIVE_MS`, kept in
    // sync by hand — SQL cannot import a JS constant) — kept as a query-time interval rather
    // than a parameter, since nothing about "active" is meant to be tunable per call the way
    // the undo horizon is (Scope-IN: horizon is configuration; the offline window is a spec
    // constant).
    const { rows } = await this.pool.query<{ frontier: string }>(
      `SELECT COALESCE(
         (SELECT MIN(last_ack_seq) FROM sessions
           WHERE document_id = $1 AND last_seen_at > now() - interval '10 minutes'),
         (SELECT current_seq FROM documents WHERE id = $1)
       ) AS frontier`,
      [documentId],
    );
    return rows[0] ? BigInt(rows[0].frontier) : 0n;
  }
}

/**
 * Test-only, in-memory stand-in — see this file's own header comment for
 * why it exists. `commitOperations` always "succeeds" immediately with no
 * real durability (the entire point), and `warmStart` always returns an
 * empty log at seq 0 (a coordinator built on this store always starts
 * from nothing, exactly like every server test before Phase 16). NEVER
 * constructed in production — server.ts/index.ts always build a real
 * `PostgresOperationStore` when actually running the server.
 */
export class InMemoryOperationStore implements OperationStore {
  /**
   * Purely so `loadFullOperationLog` (and therefore httpApp.ts's
   * `/replay`/`/replay-nodes` diagnostic endpoints) has something real
   * to return for the common no-Postgres case — this used to be exactly
   * what `DocumentCoordinator.operationLog` provided before Phase 17
   * removed it in favor of always querying the store. NOT "real
   * durability" in the persist-across-restart sense (this class's whole
   * point): a fresh `InMemoryOperationStore` instance — as opposed to a
   * fresh coordinator sharing the SAME instance — still starts empty,
   * same as before.
   */
  private readonly opsByDocument = new Map<string, Operation[]>();

  // `async` (rather than a sync function returning an already-resolved value) is deliberate:
  // it satisfies the OperationStore interface's Promise-returning shape exactly like the real
  // store, so a caller can never accidentally rely on this resolving synchronously just
  // because the test double happens to.
  async warmStart(_documentId: string): Promise<WarmStartResult> {
    return { snapshotNodes: null, snapshotSeq: 0n, suffixOps: [], currentSeq: 0n };
  }

  /** GC-relevant methods (Phase 21) — see this file's own header for why this store never has real durability. No sessions exist to query, so the frontier is always the coordinator's own current_seq-equivalent (0n here, since this store tracks no seq at all) — cold-load compaction's own COALESCE fallback shape, degenerately. */
  async getStabilityFrontier(_documentId: string): Promise<bigint> {
    return 0n;
  }

  async upsertSessionHeartbeat(_input: SessionHeartbeatInput): Promise<void> {
    // No real durability — nothing to persist.
  }

  async commitOperations(
    input: CommitOperationsInput,
  ): Promise<{ readonly insertedCount: number }> {
    let ops = this.opsByDocument.get(input.documentId);
    if (!ops) {
      ops = [];
      this.opsByDocument.set(input.documentId, ops);
    }
    ops.push(...input.ops);
    return { insertedCount: input.ops.length };
  }

  async loadFullOperationLog(documentId: string): Promise<Operation[]> {
    return [...(this.opsByDocument.get(documentId) ?? [])];
  }

  async loadFullOperationLogWithSeq(documentId: string): Promise<SeqOperation[]> {
    // This store never tracks a real per-operation seq (nothing durable exists to number) —
    // array position (1-indexed) is a reasonable stand-in, since this store's own `ops` array
    // is already append-only and gapless.
    return (this.opsByDocument.get(documentId) ?? []).map((op, i) => ({ seq: BigInt(i + 1), op }));
  }

  async loadOperationLogRange(
    documentId: string,
    fromSeqExclusive: bigint,
    toSeqInclusive: bigint,
  ): Promise<SeqOperation[]> {
    // Same 1-indexed array-position-as-seq convention as loadFullOperationLogWithSeq above —
    // this store never tracks a real per-operation seq, since nothing durable exists to number.
    return (this.opsByDocument.get(documentId) ?? [])
      .map((op, i): SeqOperation => ({ seq: BigInt(i + 1), op }))
      .filter(({ seq }) => seq > fromSeqExclusive && seq <= toSeqInclusive);
  }

  async findExistingStamps(
    documentId: string,
    stamps: readonly Identifier[],
  ): Promise<Identifier[]> {
    const wanted = new Set(stamps.map((s) => serializeId(s)));
    const present: Identifier[] = [];
    for (const op of this.opsByDocument.get(documentId) ?? []) {
      const key = serializeId(op.id);
      if (wanted.has(key)) {
        present.push(op.id);
      }
    }
    return present;
  }

  async writeSnapshot(_input: WriteSnapshotInput): Promise<void> {
    // No real durability (the entire point of this store) — snapshotting a document that isn't
    // actually persisted has nothing to snapshot INTO, so this is a no-op rather than an error.
  }

  async getLatestSnapshot(_documentId: string): Promise<SnapshotRecord | null> {
    return null; // no real durability — never any snapshots to find
  }

  async listSnapshots(_documentId: string): Promise<SnapshotRecord[]> {
    return [];
  }

  /** Purely so `listAuditRuns`/`getLastSuccessfulAuditRunAt` have something to read back — same "test double keeps state so the interface is genuinely exercised" reasoning as `opsByDocument`. */
  private readonly auditRunsByDocument = new Map<string, AuditRunRow[]>();

  async writeAuditRun(input: AuditRunInput): Promise<void> {
    let runs = this.auditRunsByDocument.get(input.documentId);
    if (!runs) {
      runs = [];
      this.auditRunsByDocument.set(input.documentId, runs);
    }
    runs.push({ ...input, id: randomUUID(), ranAt: new Date() });
  }

  async listAuditRuns(documentId: string, limit: number): Promise<AuditRunRow[]> {
    const runs = this.auditRunsByDocument.get(documentId) ?? [];
    return [...runs].reverse().slice(0, limit);
  }

  async getLastSuccessfulAuditRunAt(documentId: string): Promise<Date | null> {
    const runs = this.auditRunsByDocument.get(documentId) ?? [];
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i]!.result === "ok") {
        return runs[i]!.ranAt;
      }
    }
    return null;
  }
}
