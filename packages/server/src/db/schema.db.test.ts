// Phase 15 Definition of Done, verified against a REAL, migrated Postgres
// instance — not mocked, the same "run it for real" discipline this
// project has used since the Phase 8 gateway tests. Requires:
//   docker compose up -d
//   pnpm db:migrate
// Run via `pnpm test:db` (packages/server/vitest.db.config.ts) — never
// swept into the default `pnpm test`, since most dev/CI environments
// don't have a Postgres instance running. See that config's own comment.
//
// Each test that mutates data runs inside its own transaction, rolled
// back in `afterEach` — no test leaves rows behind, and tests never see
// each other's fixtures.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createPool, type DbPool } from "./pool.js";

let pool: DbPool;
let client: pg.PoolClient;

beforeAll(async () => {
  const config = loadConfig();
  pool = createPool(config.databaseUrl);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
});

afterEach(async () => {
  // Rolling back, not deleting, is what guarantees a test can never leave
  // partial state behind even if an assertion throws mid-test.
  await client.query("ROLLBACK");
  client.release();
});

/** Inserts one user + one document (owned by that user) + one session, returning their ids. Shared fixture shape needed by most of the tests below. */
async function seedUserDocumentSession(): Promise<{
  userId: string;
  documentId: string;
  sessionId: string;
}> {
  const userId = randomUUID();
  const documentId = randomUUID();
  const sessionId = randomUUID();

  await client.query(
    `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
    [userId, `${userId}@example.com`, "Test User", "not-a-real-hash"],
  );
  await client.query(`INSERT INTO documents (id, owner_id) VALUES ($1, $2)`, [documentId, userId]);
  await client.query(
    `INSERT INTO document_permissions (document_id, user_id, role, granted_by)
     VALUES ($1, $2, 'owner', $2)`,
    [documentId, userId],
  );
  await client.query(
    `INSERT INTO sessions (id, user_id, document_id, replica_id, role_at_connect)
     VALUES ($1, $2, $3, 1, 'owner')`,
    [sessionId, userId, documentId],
  );

  return { userId, documentId, sessionId };
}

describe("Phase 15 schema — table/index existence", () => {
  it("pnpm db:migrate creates all ten tables", async () => {
    // `pgmigrations` is node-pg-migrate's own bookkeeping table (records
    // which migrations have run) — an implementation detail of the chosen
    // migration tool, not one of API Spec §2's eight tables, so it's
    // excluded here rather than added to the expected list below.
    //
    // Ten, not eight, as of Phase 27: Phase 26 added `refresh_tokens`
    // (API Spec §4.2, no verbatim DDL supplied — this project's own
    // disclosed design) and Phase 27 added `idempotency_keys` (API Spec
    // §9.2, same reasoning) — this literal list was never updated when
    // Phase 26 landed, a real, if narrow, pre-existing gap this phase's
    // own DoD verification found and fixed while confirming its OWN new
    // table's presence, not something Phase 27 itself introduced.
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name <> 'pgmigrations'`,
    );
    const tableNames = rows.map((r) => r.table_name).sort();
    expect(tableNames).toEqual(
      [
        "audit_runs",
        "document_permissions",
        "documents",
        "idempotency_keys",
        "operations",
        "refresh_tokens",
        "sessions",
        "snapshots",
        "users",
        "version_marks",
      ].sort(),
    );
  });

  it("creates every named constraint/index from API Spec §2", async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const indexNames = new Set(rows.map((r) => r.indexname));
    for (const expected of [
      "users_email_ci_idx",
      "documents_owner_idx",
      "docperm_user_idx",
      "docperm_single_owner_idx",
      "sessions_replica_uq",
      "sessions_frontier_idx",
      "operations_stamp_uq",
      "snapshots_latest_idx",
      "version_marks_doc_idx",
      "audit_runs_bad_idx",
    ]) {
      expect(indexNames.has(expected), `missing index ${expected}`).toBe(true);
    }
  });
});

describe("Phase 15 DoD — operations is append-only (structural, not app-level)", () => {
  it("an UPDATE on operations is a silent no-op", async () => {
    const { documentId, sessionId, userId } = await seedUserDocumentSession();
    const payload = Buffer.from([1, 2, 3]);
    await client.query(
      `INSERT INTO operations (document_id, seq, stamp_r, stamp_c, author_session, author_user, kind, payload)
       VALUES ($1, 1, 1, 1, $2, $3, 'insert', $4)`,
      [documentId, sessionId, userId, payload],
    );

    // operations_no_update (1788134640000_create-operations.js) rewrites this to
    // DO INSTEAD NOTHING — no error, no rows affected, and the row's
    // payload must be byte-for-byte unchanged afterward.
    await client.query(`UPDATE operations SET payload = $1 WHERE document_id = $2 AND seq = 1`, [
      Buffer.from([9, 9, 9]),
      documentId,
    ]);

    const { rows } = await client.query<{ payload: Buffer }>(
      `SELECT payload FROM operations WHERE document_id = $1 AND seq = 1`,
      [documentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.equals(payload)).toBe(true);
  });

  it("a DELETE on operations is a silent no-op", async () => {
    const { documentId, sessionId, userId } = await seedUserDocumentSession();
    await client.query(
      `INSERT INTO operations (document_id, seq, stamp_r, stamp_c, author_session, author_user, kind, payload)
       VALUES ($1, 1, 1, 1, $2, $3, 'insert', $4)`,
      [documentId, sessionId, userId, Buffer.from([1])],
    );

    // operations_no_delete: DO INSTEAD NOTHING — the row must still be there.
    await client.query(`DELETE FROM operations WHERE document_id = $1 AND seq = 1`, [documentId]);

    const { rows } = await client.query(
      `SELECT 1 FROM operations WHERE document_id = $1 AND seq = 1`,
      [documentId],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("Phase 15 DoD — single-owner and duplicate-stamp constraints", () => {
  it("rejects a second owner row for the same document", async () => {
    const { documentId, userId } = await seedUserDocumentSession();
    const secondUserId = randomUUID();
    await client.query(
      `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
      [secondUserId, `${secondUserId}@example.com`, "Second Owner", "not-a-real-hash"],
    );

    // docperm_single_owner_idx: a partial unique index on (document_id)
    // WHERE role = 'owner' — the second owner row for the same document
    // must violate it, regardless of which user it names.
    await expect(
      client.query(
        `INSERT INTO document_permissions (document_id, user_id, role, granted_by)
         VALUES ($1, $2, 'owner', $3)`,
        [documentId, secondUserId, userId],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint "docperm_single_owner_idx"/);
  });

  it("rejects a duplicate (document_id, stamp_r, stamp_c)", async () => {
    const { documentId, sessionId, userId } = await seedUserDocumentSession();
    await client.query(
      `INSERT INTO operations (document_id, seq, stamp_r, stamp_c, author_session, author_user, kind, payload)
       VALUES ($1, 1, 7, 42, $2, $3, 'insert', $4)`,
      [documentId, sessionId, userId, Buffer.from([1])],
    );

    // operations_stamp_uq: same (document_id, stamp_r, stamp_c) at a
    // different seq must still be rejected — this is duplicate-operation
    // suppression, not a seq collision check (seq is already the PK).
    await expect(
      client.query(
        `INSERT INTO operations (document_id, seq, stamp_r, stamp_c, author_session, author_user, kind, payload)
         VALUES ($1, 2, 7, 42, $2, $3, 'insert', $4)`,
        [documentId, sessionId, userId, Buffer.from([2])],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint "operations_stamp_uq"/);
  });
});

describe("Phase 15 DoD — the reconnection query plan", () => {
  it("WHERE document_id=$1 AND seq > $2 ORDER BY seq is a primary-key range scan", async () => {
    const { documentId, sessionId, userId } = await seedUserDocumentSession();

    // A small table, or a target document that isn't a small SLICE of the
    // whole table, can make the planner correctly prefer a seq scan
    // regardless of index availability — that would make this test pass or
    // fail based on Postgres's own cost heuristics rather than on whether
    // the index actually exists and is actually chosen. An earlier version
    // of this test used only 2 documents x 500 rows (1,000 total); the
    // target document was 50% of the table, and the planner correctly chose
    // Sort + Seq Scan over the index for that (confirmed by actually
    // running it, not assumed) — a real instance of this project's own
    // "green isn't evidence until it's been checked at the right scale"
    // lesson (CLAUDE.md, Phases 5/7/14). Fixed by making the target
    // document a small fraction of a much larger table: 60 documents x
    // 2,000 rows each (120,000 total), inserted via unnest/generate_series
    // rather than 120,000 individually-parameterized rows (which would be
    // slow and hit Postgres's per-statement parameter limit), then
    // ANALYZE so the planner has real stats to reason from.
    const OTHER_DOCUMENT_COUNT = 59;
    const ROWS_PER_DOCUMENT = 2000;
    const otherDocumentIds = Array.from({ length: OTHER_DOCUMENT_COUNT }, () => randomUUID());
    const allDocumentIds = [documentId, ...otherDocumentIds];

    await client.query(`INSERT INTO documents (id, owner_id) SELECT unnest($1::uuid[]), $2`, [
      otherDocumentIds,
      userId,
    ]);
    await client.query(
      `INSERT INTO operations (document_id, seq, stamp_r, stamp_c, author_session, author_user, kind, payload)
       SELECT d, s, s, 1, $3, $4, 'insert', $5
         FROM unnest($1::uuid[]) AS d
         CROSS JOIN generate_series(1, $2::int) AS s`,
      [allDocumentIds, ROWS_PER_DOCUMENT, sessionId, userId, Buffer.from([1])],
    );
    await client.query("ANALYZE operations");

    const { rows } = await client.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT document_id, seq, stamp_r, stamp_c, author_session, author_user, kind, payload
         FROM operations WHERE document_id = $1 AND seq > $2 ORDER BY seq`,
      [documentId, 0],
    );
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/Index (Only )?Scan.*operations_pkey/i);
    expect(plan).not.toMatch(/Seq Scan/i);
  });
});
