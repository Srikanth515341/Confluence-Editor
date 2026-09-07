// Phase 26 — real Postgres access for authentication (API Spec §4.1/§4.2). A separate module
// from operationStore.ts deliberately: that file's `OperationStore` interface (and its
// in-memory/Postgres split) exists to keep the CRDT write path infra-free for every pre-Phase-16
// test — an orthogonal concern to user accounts/auth, which this phase introduces for the first
// time and which has no meaningful "in-memory" stand-in (a login system IS its own persistence
// layer; there is no lighter-weight substitute worth building the way `InMemoryOperationStore`
// is a genuine substitute for a document's CRDT log). Every auth route in httpApp.ts requires a
// REAL `DbPool` — see httpApp.ts's own `authDeps` doc comment for what happens when one isn't
// supplied (the routes are simply not mounted, mirroring `OperationStore`'s own "pnpm test stays
// infra-free" precedent one level up).

import { randomUUID } from "node:crypto";
import type { DbPool } from "./pool.js";

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
}

export async function findUserByEmail(pool: DbPool, email: string): Promise<UserRow | null> {
  // `users_email_ci_idx` (Phase 15, verbatim spec DDL) is a case-insensitive unique index on
  // `lower(email)` — matching it here via `lower($1) = lower(email)` (equivalently
  // `lower(email) = lower($1)`) is what makes login itself case-insensitive on email, consistent
  // with the constraint that already prevents two users from registering "a@b.com" and
  // "A@b.com" as if they were distinct accounts.
  const { rows } = await pool.query<{
    id: string;
    email: string;
    display_name: string;
    password_hash: string;
  }>(`SELECT id, email, display_name, password_hash FROM users WHERE lower(email) = lower($1)`, [
    email,
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
  };
}

/** Used by POST /v1/auth/refresh to rebuild a full `AccessTokenClaims` shape after rotation — `rotateRefreshToken` (authService.ts) only carries `userId` forward, not the full user row, since the tokens table itself has no reason to duplicate `users` columns. */
export async function findUserById(pool: DbPool, userId: string): Promise<UserRow | null> {
  const { rows } = await pool.query<{
    id: string;
    email: string;
    display_name: string;
    password_hash: string;
  }>(`SELECT id, email, display_name, password_hash FROM users WHERE id = $1`, [userId]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
  };
}

export interface CreateRefreshTokenInput {
  readonly familyId: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/** Inserts a new refresh-token row — used both at login (a BRAND NEW `familyId`, minted by the caller) and at rotation (the SAME `familyId` as the token being rotated, a NEW row/hash). */
export async function insertRefreshToken(pool: DbPool, input: CreateRefreshTokenInput): Promise<void> {
  await pool.query(
    `INSERT INTO refresh_tokens (id, family_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), input.familyId, input.userId, input.tokenHash, input.expiresAt],
  );
}

export interface RefreshTokenRow {
  readonly id: string;
  readonly familyId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly revokedAt: Date | null;
}

export async function findRefreshTokenByHash(
  pool: DbPool,
  tokenHash: string,
): Promise<RefreshTokenRow | null> {
  const { rows } = await pool.query<{
    id: string;
    family_id: string;
    user_id: string;
    expires_at: Date;
    used_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT id, family_id, user_id, expires_at, used_at, revoked_at
     FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
  };
}

/** Marks exactly one token as used (rotated) — the FIRST time it's ever presented to /refresh. A SECOND presentation of the SAME already-used token is the theft signal `rotateRefreshToken` (authService.ts) checks for BEFORE ever calling this. */
export async function markRefreshTokenUsed(pool: DbPool, tokenId: string): Promise<void> {
  await pool.query(`UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [tokenId]);
}

/** The theft-detection response: revoke EVERY token in a family at once, not just the one that was reused — "reusing a rotated refresh token revokes the whole family" (this phase's own brief, verbatim). Idempotent (`revoked_at IS NULL` guard) so calling this twice for the same family is harmless. */
export async function revokeFamily(pool: DbPool, familyId: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId],
  );
}
