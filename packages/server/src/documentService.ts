// Phase 27 — REST document lifecycle orchestration (API Spec §4.3-§4.6, §4.16, §9.2). Mirrors
// authService.ts's own split from httpApp.ts: every function here is directly testable against a
// real `DbPool` with no Express request/response object involved, and httpApp.ts's own route
// handlers stay thin — parse the request, call one of these, map the discriminated outcome to a
// status code and the §5.1 envelope (or a bare success body).

import { randomUUID, createHash } from "node:crypto";
import type { DbPool } from "./db/pool.js";
import {
  createDocument,
  findIdempotencyRecord,
  getDocumentById,
  getUserRole,
  listDocumentsForUser,
  listPermissions,
  revokeDocumentAccess,
  saveIdempotencyRecord,
  searchUsers,
  updateDocumentTitle,
  type DocumentRole,
  type DocumentRow,
} from "./db/documentStore.js";

export const DEFAULT_TITLE = "Untitled";
export const MAX_TITLE_LENGTH = 512;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

/** The idempotency table's own `endpoint` discriminator (db/documentStore.ts) — a literal string, not derived from the Express route path, so a future refactor of the route's own literal path string can never silently change which stored records a request matches against. */
const CREATE_DOCUMENT_ENDPOINT = "POST /v1/documents";

export const ALL_DOCUMENT_ROLES: readonly DocumentRole[] = ["owner", "editor", "viewer"];

export function isDocumentRole(value: string): value is DocumentRole {
  return (ALL_DOCUMENT_ROLES as readonly string[]).includes(value);
}

/** API Spec §4.16's own literal masking example, `"a***@example.com"`: first character of the local part, then a fixed `***`, then the untouched domain. Defensively returns the input unmasked if it somehow contains no `@` at all — `users.email` is never actually malformed like this (a real column value always has one), so this branch exists only to avoid a confusing crash on a value that should be structurally impossible. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  return `${email[0]}***${email.slice(at)}`;
}

/** Recursively sorts object keys so `canonicalJsonStringify` never depends on a request body's own incidental key ORDER — two JSON payloads that are semantically identical but written with keys in a different order must hash identically for API Spec §9.2's "same body" check to mean what it should. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(body)).digest("hex");
}

export interface TitleValidation {
  readonly ok: boolean;
  readonly title: string;
}

/** POST's own rule: `title` is optional, defaulting to `"Untitled"` (API Spec §4.3) when omitted entirely; when PRESENT it must be a string no longer than 512 characters (§4.3's own `400 validation_failed (title > 512 chars)` — extended here to also reject a non-string value the same way, since a wrong-type title is just as much "not a valid title" as an over-length one, matching Phase 26's own `attemptLogin` validation precedent of rejecting wrong-typed fields alongside missing ones). */
export function resolveTitleForCreate(rawTitle: unknown): { readonly ok: true; readonly title: string } | { readonly ok: false } {
  if (rawTitle === undefined) return { ok: true, title: DEFAULT_TITLE };
  if (typeof rawTitle !== "string" || rawTitle.length > MAX_TITLE_LENGTH) return { ok: false };
  return { ok: true, title: rawTitle };
}

/** PATCH's own rule is stricter than POST's: a title is the ONLY thing PATCH updates (API Spec §4.5), so — unlike creation — it must actually be PRESENT in the body; there is no sensible "default" for an update that names nothing to change. */
export function resolveTitleForUpdate(rawTitle: unknown): { readonly ok: true; readonly title: string } | { readonly ok: false } {
  if (typeof rawTitle !== "string" || rawTitle.length === 0 || rawTitle.length > MAX_TITLE_LENGTH) {
    return { ok: false };
  }
  return { ok: true, title: rawTitle };
}

export interface DocumentSummaryResponse {
  readonly id: string;
  readonly title: string;
  readonly ownerId: string;
  readonly role: DocumentRole;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * API Spec §4.3's own literal example response shows `"currentSeq": 0` as a bare JSON number,
   * not a string — followed here even though `documents.current_seq` is a BIGINT and this
   * project's OTHER bigint-carrying endpoints (`/audit-runs`'s `replayedToSeq`) deliberately
   * serialize as a STRING to avoid silent precision loss past 2^53. That precaution matters far
   * less here: an operation sequence number reaching Number.MAX_SAFE_INTEGER (9 quadrillion) is
   * not a realistic concern for a single document's lifetime, and this phase's own Scope-IN cites
   * the literal example response shape directly, so fidelity to that literal shape wins here.
   */
  readonly currentSeq: number;
}

export function toDocumentSummary(document: DocumentRow, role: DocumentRole): DocumentSummaryResponse {
  return {
    id: document.id,
    title: document.title,
    ownerId: document.ownerId,
    role,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    currentSeq: Number(document.currentSeq),
  };
}

export type CreateDocumentOutcome =
  | { readonly kind: "validation-failed" }
  | { readonly kind: "idempotency-conflict" }
  | { readonly kind: "replay"; readonly status: number; readonly body: unknown }
  | { readonly kind: "created"; readonly body: DocumentSummaryResponse };

/**
 * API Spec §9.2's full state machine: a request with NO Idempotency-Key always creates a fresh
 * document (idempotency is opt-in, per the header's own "optional but recommended" wording,
 * §4.3). A request WITH a key checks for a prior record first — same key + same body replays the
 * ORIGINAL stored response verbatim (never a freshly-recomputed one, which could differ if, say,
 * this ran a second time after `currentSeq` had already advanced); same key + different body is
 * `409 idempotency_key_reused`, deliberately never "helpfully" applying either version (§9.2's own
 * explicit "this is a client bug; do not silently apply either version").
 */
export async function createDocumentForUser(
  pool: DbPool,
  input: { readonly ownerId: string; readonly rawTitle: unknown; readonly idempotencyKey?: string },
): Promise<CreateDocumentOutcome> {
  const titleResult = resolveTitleForCreate(input.rawTitle);
  if (!titleResult.ok) return { kind: "validation-failed" };

  const requestBodyHash = hashRequestBody({ title: input.rawTitle });
  if (input.idempotencyKey) {
    const existing = await findIdempotencyRecord(pool, {
      userId: input.ownerId,
      endpoint: CREATE_DOCUMENT_ENDPOINT,
      key: input.idempotencyKey,
    });
    if (existing) {
      if (existing.requestBodyHash !== requestBodyHash) {
        return { kind: "idempotency-conflict" };
      }
      return { kind: "replay", status: existing.responseStatus, body: existing.responseBody };
    }
  }

  const document = await createDocument(pool, {
    id: randomUUID(),
    title: titleResult.title,
    ownerId: input.ownerId,
  });
  const body = toDocumentSummary(document, "owner");
  if (input.idempotencyKey) {
    await saveIdempotencyRecord(pool, {
      userId: input.ownerId,
      endpoint: CREATE_DOCUMENT_ENDPOINT,
      key: input.idempotencyKey,
      requestBodyHash,
      responseStatus: 201,
      responseBody: body,
    });
  }
  return { kind: "created", body };
}

export type GetDocumentOutcome =
  | { readonly kind: "not-found" }
  | { readonly kind: "ok"; readonly body: unknown };

/**
 * API Spec §4.5's 404-vs-403 rule (see this project's own README/CLAUDE.md quoting it verbatim):
 * a user with NO permission row gets 404, indistinguishable from the document genuinely not
 * existing — GET never returns 403 at all (every row/no-row split for GET is 200-or-404, per the
 * Test Plan §11.1 matrix's own GET row). `liveStats`, when supplied, overrides the durable
 * `structure_size`/`tombstone_count` columns with a currently-open coordinator's live
 * `engine.stats()` — see `db/documentStore.ts`'s own `DocumentRow.structureSize` doc comment for
 * why the durable columns alone are not authoritative.
 */
export async function getDocumentForUser(
  pool: DbPool,
  input: {
    readonly documentId: string;
    readonly userId: string;
    readonly liveStats?: { readonly structureSize: number; readonly tombstoneCount: number };
  },
): Promise<GetDocumentOutcome> {
  const role = await getUserRole(pool, input.documentId, input.userId);
  if (!role) return { kind: "not-found" };
  const document = await getDocumentById(pool, input.documentId);
  if (!document) return { kind: "not-found" }; // structurally shouldn't happen — a permission row's own FK guarantees the document row exists — but never assumed, only checked
  const base = toDocumentSummary(document, role);
  if (role !== "owner") {
    // §4.5: "permissions (owner only)... structureSize/tombstoneCount (owner only)" — a
    // non-owner's response is exactly the base object, nothing more.
    return { kind: "ok", body: base };
  }
  const permissions = await listPermissions(pool, input.documentId);
  const stats = input.liveStats ?? {
    structureSize: document.structureSize,
    tombstoneCount: document.tombstoneCount,
  };
  return {
    kind: "ok",
    body: {
      ...base,
      permissions: permissions.map((p) => ({
        userId: p.userId,
        role: p.role,
        grantedBy: p.grantedBy,
        grantedAt: p.grantedAt.toISOString(),
      })),
      structureSize: stats.structureSize,
      tombstoneCount: stats.tombstoneCount,
    },
  };
}

export type PatchDocumentOutcome =
  | { readonly kind: "not-found" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "validation-failed" }
  | { readonly kind: "ok"; readonly body: DocumentSummaryResponse };

/** API Spec §4.5 PATCH (owner only): a caller with NO role gets 404 (same enumeration-oracle reasoning as GET); a caller with SOME role but not `owner` gets 403 — the "has a role, just not a sufficient one" half of the 404-vs-403 split. */
export async function renameDocument(
  pool: DbPool,
  input: { readonly documentId: string; readonly userId: string; readonly rawTitle: unknown },
): Promise<PatchDocumentOutcome> {
  const role = await getUserRole(pool, input.documentId, input.userId);
  if (!role) return { kind: "not-found" };
  if (role !== "owner") return { kind: "forbidden" };
  const titleResult = resolveTitleForUpdate(input.rawTitle);
  if (!titleResult.ok) return { kind: "validation-failed" };
  const document = await updateDocumentTitle(pool, input.documentId, titleResult.title);
  return { kind: "ok", body: toDocumentSummary(document, "owner") };
}

export type DeleteDocumentOutcome =
  | { readonly kind: "not-found" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "ok" };

/** API Spec §4.5 DELETE (owner only) — same 404/403 split as PATCH. Deliberately does NOT itself notify any open WebSocket session (that's httpApp.ts's own job, via the live `DocumentCoordinator` — this function only touches durable state, so it stays testable without a running gateway). */
export async function deleteDocumentAccess(
  pool: DbPool,
  input: { readonly documentId: string; readonly userId: string },
): Promise<DeleteDocumentOutcome> {
  const role = await getUserRole(pool, input.documentId, input.userId);
  if (!role) return { kind: "not-found" };
  if (role !== "owner") return { kind: "forbidden" };
  await revokeDocumentAccess(pool, input.documentId);
  return { kind: "ok" };
}

/** Opaque to the client (API Spec §4.4's `?cursor=` is never documented as a literal format) — base64url of `{updatedAt, id}`, the exact keyset-pagination tuple `db/documentStore.ts`'s own `ORDER BY updated_at DESC, id DESC` needs to resume from. */
export function encodeDocumentListCursor(cursor: { readonly updatedAt: Date; readonly id: string }): string {
  return Buffer.from(
    JSON.stringify({ updatedAt: cursor.updatedAt.toISOString(), id: cursor.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeDocumentListCursor(
  raw: string,
): { readonly updatedAt: Date; readonly id: string } | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      updatedAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") return undefined;
    const updatedAt = new Date(parsed.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) return undefined;
    return { updatedAt, id: parsed.id };
  } catch {
    return undefined;
  }
}

export interface DocumentListItem {
  readonly id: string;
  readonly title: string;
  readonly role: DocumentRole;
  readonly ownerId: string;
  readonly updatedAt: string;
  readonly currentSeq: number;
  readonly activeParticipants: number;
}

export type ListDocumentsOutcome =
  | { readonly kind: "invalid-cursor" }
  | {
      readonly kind: "ok";
      readonly documents: readonly DocumentListItem[];
      readonly nextCursor: string | null;
    };

/**
 * `getActiveParticipants` is a plain callback, not a `DocumentCoordinator`/`Gateway` reference —
 * keeps this file (and therefore anything that unit-tests it) decoupled from the WebSocket
 * gateway's own internals, the same separation `audit.ts`'s `AuditOptions.liveText` already
 * established for an analogous "the live in-memory truth, supplied by whoever has it" parameter.
 */
export async function listDocumentsForUserService(
  pool: DbPool,
  input: {
    readonly userId: string;
    readonly roles?: readonly DocumentRole[];
    readonly limit: number;
    readonly cursor?: string;
  },
  getActiveParticipants: (documentId: string) => number,
): Promise<ListDocumentsOutcome> {
  let decodedCursor: { readonly updatedAt: Date; readonly id: string } | undefined;
  if (input.cursor !== undefined) {
    decodedCursor = decodeDocumentListCursor(input.cursor);
    if (!decodedCursor) return { kind: "invalid-cursor" };
  }
  const { items, hasMore } = await listDocumentsForUser(pool, {
    userId: input.userId,
    limit: input.limit,
    // `exactOptionalPropertyTypes` (project-wide convention, e.g. server.ts's own `authDeps`
    // spread) — an optional field must be OMITTED, never explicitly assigned `undefined`.
    ...(input.roles ? { roles: input.roles } : {}),
    ...(decodedCursor ? { cursor: decodedCursor } : {}),
  });
  const documents = items.map((item) => ({
    id: item.id,
    title: item.title,
    role: item.role,
    ownerId: item.ownerId,
    updatedAt: item.updatedAt.toISOString(),
    currentSeq: Number(item.currentSeq),
    activeParticipants: getActiveParticipants(item.id),
  }));
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeDocumentListCursor({ updatedAt: last.updatedAt, id: last.id }) : null;
  return { kind: "ok", documents, nextCursor };
}

export interface SearchUserResult {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
}

/** API Spec §4.16 — the raw rows from `db/documentStore.ts`'s `searchUsers` (unmasked) become the RESPONSE shape only here, at the boundary where masking is actually mandated. */
export async function searchUsersForResponse(pool: DbPool, query: string): Promise<SearchUserResult[]> {
  const rows = await searchUsers(pool, query);
  return rows.map((r) => ({ id: r.id, displayName: r.displayName, email: maskEmail(r.email) }));
}
