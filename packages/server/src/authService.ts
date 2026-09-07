// Phase 26 — login/refresh/logout orchestration (API Spec §4.1/§4.2, Test Plan §11.1/SEC-11g).
// Deliberately separate from httpApp.ts's own route handlers: every function here is directly
// unit/integration-testable against a real `DbPool` with NO Express request/response object
// involved — most importantly `attemptLogin`, which SEC-11g's own timing test calls directly,
// 2,000 times, bypassing the outer HTTP layer (rate limiting, cookie serialization, status-code
// mapping) entirely. That bypass is deliberate, not a shortcut: rate limiting is a genuinely
// SEPARATE concern from "does the credential-verification code path itself leak a timing
// signal," and folding a rate-limit check into this function would reintroduce the exact same
// class of bug SEC-11g exists to catch, one layer up (an early return for "this account/IP is
// rate-limited" is still an early return relative to the always-run-Argon2id code path,
// discoverable via a *different* timing side-channel).

import type { DbPool } from "./db/pool.js";
import {
  findRefreshTokenByHash,
  findUserByEmail,
  insertRefreshToken,
  markRefreshTokenUsed,
  revokeFamily,
  type UserRow,
} from "./db/authStore.js";
import { getDummyPasswordHash, verifyPassword } from "./passwordHash.js";
import type { AuthConfig } from "./config.js";
import {
  accessTokenTtlSeconds,
  generateRawRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "./tokens.js";
import { randomUUID } from "node:crypto";

/**
 * The SEC-11g fix, literally: `hashToCompare` is resolved to a REAL user's stored hash OR the
 * fixed dummy hash BEFORE `verifyPassword` is ever called — never inside a branch taken only
 * when a user exists. `verifyPassword` (an Argon2id comparison, ~100-150ms on this project's own
 * measured hardware) always runs, on every call, regardless of which case this is — the ONLY
 * difference between the two cases is which hash string gets passed in, never whether the
 * expensive comparison happens at all. Returns `null` for EITHER "no such user" or "wrong
 * password" — API Spec §4.1's own requirement that the two cases be indistinguishable extends to
 * the return value here, not just to the eventual HTTP response: a caller of this function has
 * no way to tell the two failure modes apart either.
 */
export async function attemptLogin(
  pool: DbPool,
  email: string,
  password: string,
): Promise<UserRow | null> {
  const user = await findUserByEmail(pool, email);
  const hashToCompare = user ? user.passwordHash : await getDummyPasswordHash();
  const passwordMatches = await verifyPassword(hashToCompare, password);
  if (!user || !passwordMatches) return null;
  return user;
}

export function issueAccessToken(user: UserRow, config: AuthConfig): { accessToken: string; expiresIn: number } {
  return {
    accessToken: signAccessToken(
      { sub: user.id, email: user.email, displayName: user.displayName },
      config,
    ),
    expiresIn: accessTokenTtlSeconds(config),
  };
}

export interface IssuedRefreshToken {
  readonly rawToken: string;
  readonly expiresAt: Date;
}

/** A brand-new rotation FAMILY — used only at login (never at /refresh, which extends an EXISTING family; see `rotateRefreshToken` below). */
export async function createRefreshFamily(
  pool: DbPool,
  config: AuthConfig,
  userId: string,
): Promise<IssuedRefreshToken> {
  const familyId = randomUUID();
  const rawToken = generateRawRefreshToken();
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlMs);
  await insertRefreshToken(pool, {
    familyId,
    userId,
    tokenHash: hashRefreshToken(rawToken, config),
    expiresAt,
  });
  return { rawToken, expiresAt };
}

export type RotateRefreshTokenResult =
  | { readonly outcome: "rotated"; readonly userId: string; readonly issued: IssuedRefreshToken }
  // Covers: cookie names a token that doesn't exist (never issued, or the row's family was
  // already revoked by an earlier theft-detection event or a /logout), OR the token has expired.
  // API Spec §4.2 maps ALL of these to the SAME 401 session_expired.
  | { readonly outcome: "invalid" }
  // The theft-detection case: this EXACT token was already rotated once before, and is now
  // being presented a second time. The whole family has already been revoked (as a side effect
  // of THIS call, below) by the time this is returned — the caller still gets 401
  // session_expired (same as "invalid"), but this outcome is reported separately so it can be
  // logged/alerted on distinctly, matching this project's own established "GC/audit failure
  // modes are logged with a specific, greppable message" convention (gcScheduler.ts,
  // offlineWindowScheduler.ts).
  | { readonly outcome: "reuse_detected"; readonly userId: string; readonly familyId: string };

/**
 * The rotation-with-theft-detection state machine (this phase's own brief, verbatim): "1. The
 * presented token is marked used/rotated. 2. A new token is issued, same family... 3. If a
 * token that's already marked used/rotated is presented again... revoke EVERY token in that
 * entire family." Ordering matters: `usedAt`/`revokedAt` are checked BEFORE anything is
 * mutated, so a single presented token can never be double-counted as both "rotate me" and
 * "reuse detected" — it is unambiguously one or the other, decided up front.
 */
export async function rotateRefreshToken(
  pool: DbPool,
  config: AuthConfig,
  presentedRawToken: string,
): Promise<RotateRefreshTokenResult> {
  const tokenHash = hashRefreshToken(presentedRawToken, config);
  const row = await findRefreshTokenByHash(pool, tokenHash);
  if (!row) return { outcome: "invalid" };
  if (row.revokedAt) return { outcome: "invalid" };
  if (row.expiresAt.getTime() <= Date.now()) return { outcome: "invalid" };
  if (row.usedAt) {
    await revokeFamily(pool, row.familyId);
    return { outcome: "reuse_detected", userId: row.userId, familyId: row.familyId };
  }
  await markRefreshTokenUsed(pool, row.id);
  const rawToken = generateRawRefreshToken();
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlMs);
  await insertRefreshToken(pool, {
    familyId: row.familyId,
    userId: row.userId,
    tokenHash: hashRefreshToken(rawToken, config),
    expiresAt,
  });
  return { outcome: "rotated", userId: row.userId, issued: { rawToken, expiresAt } };
}

/** /logout — idempotent by design: presenting an already-invalid/missing cookie is not an error (matches ordinary logout UX; API Spec §4.2 names no error case for this route at all, only `204 No Content`). Revokes the WHOLE family (not just the single presented token) — logout means "end this login session," and a family IS one continuous login session's own chain of rotations. */
export async function revokeRefreshFamilyByRawToken(
  pool: DbPool,
  config: AuthConfig,
  presentedRawToken: string,
): Promise<void> {
  const row = await findRefreshTokenByHash(pool, hashRefreshToken(presentedRawToken, config));
  if (row) {
    await revokeFamily(pool, row.familyId);
  }
}
