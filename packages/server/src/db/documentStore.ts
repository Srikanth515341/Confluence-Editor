// Phase 27 — REST document lifecycle (API Spec §4.3-§4.6, §4.16, §9.2). Real Postgres access for
// documents/document_permissions (Phase 15's own verbatim-DDL tables) plus this phase's own new
// idempotency_keys table. A separate module from operationStore.ts (whose `OperationStore`
// interface is scoped to the CRDT write path) and from authStore.ts (users/refresh_tokens) —
// mirrors authStore.ts's own precedent: one file per concern's own raw queries, no business logic
// (role checks, 404-vs-403 decisions, idempotency orchestration) here — that lives in
// documentService.ts, exactly the authStore.ts/authService.ts split Phase 26 already established.

import type { DbPool } from "./pool.js";

export type DocumentRole = "owner" | "editor" | "viewer";

export interface DocumentRow {
  readonly id: string;
  readonly title: string;
  readonly ownerId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly currentSeq: bigint;
  /**
   * Read directly from `documents.structure_size`/`tombstone_count` (Phase 15's own DDL comment:
   * "Maintained by the coordinator, not authoritative; the engine is") — DISCLOSED, pre-existing
   * gap, not introduced by this phase: no code path anywhere in this project currently WRITES
   * these two columns, so they read as their DB default (0) for every document, always. This
   * phase's own GET /v1/documents/{id} route prefers a currently-open coordinator's LIVE
   * `engine.stats()` when one exists (documentService.ts) and falls back to these columns only
   * when no coordinator is open in memory — see that file's own doc comment for the full
   * reasoning. Fixing the columns themselves (having some real write path maintain them) is out
   * of this phase's own Scope-IN.
   */
  readonly structureSize: number;
  readonly tombstoneCount: number;
  readonly accessRevokedAt: Date | null;
}

interface RawDocumentRow {
  readonly id: string;
  readonly title: string;
  readonly owner_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly current_seq: string; // BIGINT — node-postgres returns this as a string, never a number, to avoid silent precision loss
  readonly structure_size: number;
  readonly tombstone_count: number;
  readonly access_revoked_at: Date | null;
}

function mapDocumentRow(row: RawDocumentRow): DocumentRow {
  return {
    id: row.id,
    title: row.title,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currentSeq: BigInt(row.current_seq),
    structureSize: row.structure_size,
    tombstoneCount: row.tombstone_count,
    accessRevokedAt: row.access_revoked_at,
  };
}

/**
 * API Spec §4.3: "inserts the documents row and the owner's document_permissions row in ONE
 * transaction; the docperm_single_owner_idx constraint guarantees exactly one owner from the
 * first instant." A single-owner-at-creation invariant is only meaningful if BOTH rows land
 * atomically — a crash between the two inserts would otherwise leave a real, ownerless document
 * row behind.
 */
export async function createDocument(
  pool: DbPool,
  input: { readonly id: string; readonly title: string; readonly ownerId: string },
): Promise<DocumentRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<RawDocumentRow>(
      `INSERT INTO documents (id, title, owner_id) VALUES ($1, $2, $3) RETURNING *`,
      [input.id, input.title, input.ownerId],
    );
    await client.query(
      `INSERT INTO document_permissions (document_id, user_id, role, granted_by)
       VALUES ($1, $2, 'owner', $2)`,
      [input.id, input.ownerId],
    );
    await client.query("COMMIT");
    return mapDocumentRow(rows[0]!);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Regardless of `access_revoked_at` — callers decide what a revoked document means for their own endpoint (documentService.ts's role lookup naturally 404s once a revoked document's permission rows are gone, without this function needing to know about revocation at all). */
export async function getDocumentById(pool: DbPool, documentId: string): Promise<DocumentRow | null> {
  const { rows } = await pool.query<RawDocumentRow>(`SELECT * FROM documents WHERE id = $1`, [
    documentId,
  ]);
  const row = rows[0];
  return row ? mapDocumentRow(row) : null;
}

/** `null` covers BOTH "no such document" and "document exists but this user has no permission row" — the 404-vs-403 rule (API Spec §4.5) means the caller must never distinguish those two cases from this return value alone; it can only ever be used to answer "does THIS user have SOME role," never "does the document exist." */
export async function getUserRole(
  pool: DbPool,
  documentId: string,
  userId: string,
): Promise<DocumentRole | null> {
  const { rows } = await pool.query<{ role: DocumentRole }>(
    `SELECT role FROM document_permissions WHERE document_id = $1 AND user_id = $2`,
    [documentId, userId],
  );
  return rows[0]?.role ?? null;
}

export interface PermissionEntry {
  readonly userId: string;
  readonly role: DocumentRole;
  readonly grantedBy: string;
  readonly grantedAt: Date;
}

/** GET /v1/documents/{id}'s owner-only `permissions` field. */
export async function listPermissions(pool: DbPool, documentId: string): Promise<PermissionEntry[]> {
  const { rows } = await pool.query<{
    user_id: string;
    role: DocumentRole;
    granted_by: string;
    granted_at: Date;
  }>(
    `SELECT user_id, role, granted_by, granted_at FROM document_permissions
     WHERE document_id = $1 ORDER BY granted_at ASC`,
    [documentId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    role: r.role,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
  }));
}

export async function updateDocumentTitle(
  pool: DbPool,
  documentId: string,
  title: string,
): Promise<DocumentRow> {
  const { rows } = await pool.query<RawDocumentRow>(
    `UPDATE documents SET title = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [documentId, title],
  );
  return mapDocumentRow(rows[0]!);
}

/**
 * API Spec §4.5 DELETE: "sets access_revoked_at, revokes all permissions ... Does NOT delete the
 * operation log or snapshots (PRD FR-VH-5)." "Revokes all permissions" is implemented as an
 * actual `DELETE FROM document_permissions` — that table carries no `revoked_at` column of its
 * own (Phase 15's verbatim DDL), so a permission row's mere EXISTENCE is what "has access" means;
 * removing every row for this document is the only way to make "no one has access anymore" true.
 * `documents.access_revoked_at` is the durable, permanent record that this happened (never
 * cleared, unlike the permission rows) — kept for the SAME reason the operation log/snapshots
 * are kept: an audit trail of what existed, even after access is gone.
 */
export async function revokeDocumentAccess(pool: DbPool, documentId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE documents SET access_revoked_at = now() WHERE id = $1`, [
      documentId,
    ]);
    await client.query(`DELETE FROM document_permissions WHERE document_id = $1`, [documentId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface DocumentListEntry {
  readonly id: string;
  readonly title: string;
  readonly ownerId: string;
  readonly role: DocumentRole;
  readonly updatedAt: Date;
  readonly currentSeq: bigint;
}

export interface ListDocumentsInput {
  readonly userId: string;
  /** `undefined`/empty = every role (API Spec §4.4's `?role=` is optional and repeatable). */
  readonly roles?: readonly DocumentRole[];
  readonly limit: number;
  /** Opaque, from a PRIOR page's own `nextCursor` — see `encodeDocumentListCursor` below. `undefined` = first page. */
  readonly cursor?: { readonly updatedAt: Date; readonly id: string };
}

/**
 * Keyset (not OFFSET) pagination, ordered by `(updated_at DESC, id DESC)` — `id` is the
 * tie-breaker a keyset scheme structurally requires (two documents can share an `updated_at` to
 * the millisecond), and DESC-by-recency is the natural "documents I can see" ordering for a
 * collaborative-editing product (most-recently-active first), unlike, say, `schema.db.test.ts`'s
 * own reconnection-query index, which orders by `seq` for a completely different reason (replay
 * order, not recency). `docperm_user_idx` (Phase 15, `(user_id, document_id)`) serves the join's
 * own `WHERE dp.user_id = $1` half; there is no index on `documents (updated_at, id)` yet — this
 * phase did not add one, since API Spec §4.4 doesn't ask for one and this project has no evidence
 * yet (no real user has enough documents) that the ORDER BY here needs index support to stay
 * fast — a disclosed, deliberately deferred optimization, not an oversight.
 */
export async function listDocumentsForUser(
  pool: DbPool,
  input: ListDocumentsInput,
): Promise<{ readonly items: readonly DocumentListEntry[]; readonly hasMore: boolean }> {
  const params: unknown[] = [input.userId];
  const conditions = [`dp.user_id = $1`, `d.access_revoked_at IS NULL`];
  if (input.roles && input.roles.length > 0) {
    params.push(input.roles);
    conditions.push(`dp.role = ANY($${params.length}::document_role[])`);
  }
  if (input.cursor) {
    params.push(input.cursor.updatedAt, input.cursor.id);
    conditions.push(`(d.updated_at, d.id) < ($${params.length - 1}, $${params.length})`);
  }
  // Fetch one extra row — its mere presence (not its content) is what tells the caller whether a
  // `nextCursor` should be emitted, without a separate COUNT(*) query.
  params.push(input.limit + 1);
  const { rows } = await pool.query<{
    id: string;
    title: string;
    owner_id: string;
    role: DocumentRole;
    updated_at: Date;
    current_seq: string;
  }>(
    `SELECT d.id, d.title, d.owner_id, d.updated_at, d.current_seq, dp.role
     FROM documents d
     JOIN document_permissions dp ON dp.document_id = d.id
     WHERE ${conditions.join(" AND ")}
     ORDER BY d.updated_at DESC, d.id DESC
     LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  return {
    items: page.map((r) => ({
      id: r.id,
      title: r.title,
      ownerId: r.owner_id,
      role: r.role,
      updatedAt: r.updated_at,
      currentSeq: BigInt(r.current_seq),
    })),
    hasMore,
  };
}

export interface SearchUserRow {
  readonly id: string;
  readonly displayName: string;
  /** Unmasked — masking is a response-formatting concern (documentService.ts/httpApp.ts), not a data-access one. */
  readonly email: string;
}

/**
 * API Spec §4.16: "an EXACT email or a display NAME PREFIX." Deliberately ONE query with an OR,
 * not two separate lookups merged in application code — a single `LIMIT 10` here is what actually
 * caps the result at 10 total matches; running two separately-limited queries and concatenating
 * could return up to 20.
 */
export async function searchUsers(pool: DbPool, query: string): Promise<SearchUserRow[]> {
  const { rows } = await pool.query<{ id: string; display_name: string; email: string }>(
    `SELECT id, display_name, email FROM users
     WHERE lower(email) = lower($1) OR display_name ILIKE $1 || '%'
     ORDER BY display_name ASC
     LIMIT 10`,
    [query],
  );
  return rows.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email }));
}

export interface IdempotencyRecord {
  readonly requestBodyHash: string;
  readonly responseStatus: number;
  readonly responseBody: unknown;
}

/** API Spec §9.2's 24-hour window, enforced at query time — a row older than that is treated as though it never existed (see the idempotency_keys migration's own header comment for why no cleanup job exists). */
export async function findIdempotencyRecord(
  pool: DbPool,
  input: { readonly userId: string; readonly endpoint: string; readonly key: string },
): Promise<IdempotencyRecord | null> {
  const { rows } = await pool.query<{
    request_body_hash: string;
    response_status: number;
    response_body: unknown;
  }>(
    `SELECT request_body_hash, response_status, response_body FROM idempotency_keys
     WHERE user_id = $1 AND endpoint = $2 AND key = $3 AND created_at > now() - interval '24 hours'`,
    [input.userId, input.endpoint, input.key],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    requestBodyHash: row.request_body_hash,
    responseStatus: row.response_status,
    responseBody: row.response_body,
  };
}

/** `ON CONFLICT ... DO NOTHING` — the first writer for a given (user, endpoint, key) wins; a concurrent duplicate request racing this one simply doesn't overwrite it (its own response is still whatever THIS function's caller already computed and is about to return, so no client-visible inconsistency results either way). */
export async function saveIdempotencyRecord(
  pool: DbPool,
  input: {
    readonly userId: string;
    readonly endpoint: string;
    readonly key: string;
    readonly requestBodyHash: string;
    readonly responseStatus: number;
    readonly responseBody: unknown;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO idempotency_keys (user_id, endpoint, key, request_body_hash, response_status, response_body)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, endpoint, key) DO NOTHING`,
    [
      input.userId,
      input.endpoint,
      input.key,
      input.requestBodyHash,
      input.responseStatus,
      input.responseBody,
    ],
  );
}
