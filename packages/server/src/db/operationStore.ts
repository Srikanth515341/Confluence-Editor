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

import type { Operation } from "@collab-editor/engine";
import {
  decodeFrame,
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

export interface WarmStartResult {
  /** The full persisted operation log for this document, in seq order. */
  readonly ops: readonly Operation[];
  /** `documents.current_seq` AFTER provisioning — the highest seq ever assigned for this document, including seq values "spent" on a resent duplicate that hit ON CONFLICT DO NOTHING (see commitOperations's own doc comment) and therefore left no row of their own. This, not `MAX(operations.seq)` or `ops.length`, is what a coordinator must resume numbering from — using either of those instead would eventually reissue an already-spent seq and crash on the operations table's own PRIMARY KEY the moment a genuinely new operation collided with it. */
  readonly currentSeq: bigint;
}

export interface OperationStore {
  /**
   * Ensures a `documents` row (and its placeholder `users` owner row)
   * exists for `documentId`, then loads everything a coordinator needs to
   * warm-start (API Spec §6.2): the persisted operation log in seq order,
   * plus the current seq watermark to resume numbering from.
   */
  warmStart(documentId: string): Promise<WarmStartResult>;

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

    const { rows: opRows } = await this.pool.query<{ payload: Buffer }>(
      `SELECT payload FROM operations WHERE document_id = $1 ORDER BY seq ASC`,
      [documentId],
    );
    const { rows: docRows } = await this.pool.query<{ current_seq: string }>(
      `SELECT current_seq FROM documents WHERE id = $1`,
      [documentId],
    );
    return {
      ops: opRows.map((r) => decodeOperationPayload(r.payload)),
      currentSeq: docRows[0] ? BigInt(docRows[0].current_seq) : 0n,
    };
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
  // `async` (rather than a sync function returning an already-resolved value) is deliberate:
  // it satisfies the OperationStore interface's Promise-returning shape exactly like the real
  // store, so a caller can never accidentally rely on this resolving synchronously just
  // because the test double happens to.
  async warmStart(_documentId: string): Promise<WarmStartResult> {
    return { ops: [], currentSeq: 0n };
  }

  async commitOperations(
    input: CommitOperationsInput,
  ): Promise<{ readonly insertedCount: number }> {
    return { insertedCount: input.ops.length };
  }
}
