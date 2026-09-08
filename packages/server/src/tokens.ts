// Phase 26 — access-token (JWT) and refresh-token (opaque, hashed) primitives (API Spec
// §4.1/§4.2). Two structurally DIFFERENT token shapes, deliberately: the access token is a
// self-verifying JWT (no DB read needed to check it — cheap, since it's presented on every
// authenticated request going forward), while the refresh token is a plain high-entropy random
// secret, never self-describing anything, whose validity can ONLY be checked against the
// `refresh_tokens` table (necessary anyway, since revocation/rotation/reuse-detection are
// inherently stateful — a self-verifying refresh JWT could never be revoked before its own
// expiry without also maintaining server-side state, so it buys nothing here). This split
// mirrors this phase's brief's own literal wording: "Store: a refresh_tokens table... do not
// store raw tokens, store a hash, same principle as password_hash" — a password is a raw secret
// hashed for storage, not a self-describing token, and the brief draws that exact analogy for
// the refresh token too.

import { createHmac, randomBytes } from "node:crypto";
import jwt, { TokenExpiredError } from "jsonwebtoken";
import type { AuthConfig } from "./config.js";

export interface AccessTokenClaims {
  readonly sub: string; // user id
  readonly email: string;
  readonly displayName: string;
}

/** API Spec §4.1: `expiresIn` in the response body is SECONDS, not ms. */
export function accessTokenTtlSeconds(config: AuthConfig): number {
  return Math.round(config.accessTokenTtlMs / 1000);
}

export function signAccessToken(claims: AccessTokenClaims, config: AuthConfig): string {
  return jwt.sign(claims, config.jwtAccessSecret, {
    expiresIn: accessTokenTtlSeconds(config),
  });
}

/** Not used by any Phase 26 route (nothing yet VERIFIES an access token server-side — Scope-IN's three endpoints only ISSUE one) — included because it's the trivial, obviously-needed other half of `signAccessToken`, and a future phase authenticating a request would otherwise have to reinvent it against the same secret/claims shape. Returns `null` (never throws) for any invalid/expired/malformed token, the same "normalize to a safe negative result" discipline as `verifyPassword`. */
export function verifyAccessToken(token: string, config: AuthConfig): AccessTokenClaims | null {
  try {
    const decoded = jwt.verify(token, config.jwtAccessSecret);
    if (typeof decoded !== "object" || decoded === null) return null;
    const { sub, email, displayName } = decoded as Record<string, unknown>;
    if (typeof sub !== "string" || typeof email !== "string" || typeof displayName !== "string") {
      return null;
    }
    return { sub, email, displayName };
  } catch {
    return null;
  }
}

/**
 * Phase 27 (API Spec §5.1/§5.2, Test Plan §11.1's "missing auth / expired token" row) — unlike
 * `verifyAccessToken` above (which collapses every failure to a single `null`, correct for its
 * one existing caller, which has no reason to distinguish them), the REST auth middleware
 * (authMiddleware.ts) needs the distinction: a genuinely EXPIRED token must map to the specific
 * `401 session_expired` code the Test Plan names explicitly, while a missing/malformed/wrong-
 * secret token maps to a separate, generic "not authenticated at all" code. Reusing
 * `jwt.verify`'s own thrown error TYPE (not re-parsing/re-deriving expiry by hand) is what makes
 * this distinction reliable — `TokenExpiredError` is thrown ONLY for a syntactically-valid,
 * correctly-signed token whose `exp` claim has passed, never for any other failure mode.
 */
export type AccessTokenVerification =
  | { readonly outcome: "valid"; readonly claims: AccessTokenClaims }
  | { readonly outcome: "expired" }
  | { readonly outcome: "invalid" };

export function verifyAccessTokenDetailed(token: string, config: AuthConfig): AccessTokenVerification {
  try {
    const decoded = jwt.verify(token, config.jwtAccessSecret);
    if (typeof decoded !== "object" || decoded === null) return { outcome: "invalid" };
    const { sub, email, displayName } = decoded as Record<string, unknown>;
    if (typeof sub !== "string" || typeof email !== "string" || typeof displayName !== "string") {
      return { outcome: "invalid" };
    }
    return { outcome: "valid", claims: { sub, email, displayName } };
  } catch (err) {
    if (err instanceof TokenExpiredError) return { outcome: "expired" };
    return { outcome: "invalid" };
  }
}

const RAW_REFRESH_TOKEN_BYTES = 32; // 256 bits — matches this project's own convention for high-entropy secrets (e.g. the 256-bit family/token ids elsewhere are UUIDs, 122 bits of entropy; this is deliberately higher, since a refresh token is a bearer secret with a long, 30-day-default lifetime).

/** A fresh, high-entropy opaque secret — never a JWT, never self-describing anything (see this file's own header comment for why). base64url so it's cookie-safe with no further encoding. */
export function generateRawRefreshToken(): string {
  return randomBytes(RAW_REFRESH_TOKEN_BYTES).toString("base64url");
}

/**
 * HMAC-SHA256, keyed by `JWT_REFRESH_SECRET` — NOT a plain unkeyed hash (e.g. bare SHA-256).
 * The raw token is already a 256-bit random secret, so a plain hash would already be
 * computationally infeasible to reverse by brute force on its own; the HMAC key adds a genuine
 * second layer (a stolen database dump alone, without the server's own secret, cannot even be
 * used to CONFIRM a guessed raw token against a stored `token_hash`, let alone reverse one) —
 * the same "pepper" reasoning a keyed hash adds on top of already-strong entropy. Deterministic
 * (same input always produces the same output), which is required: this is looked up by exact
 * equality against `refresh_tokens.token_hash`, not compared via `verifyPassword`-style
 * constant-time-but-slow re-derivation — Argon2id's slow, salted design exists specifically to
 * resist brute-forcing a LOW-entropy, user-chosen secret (a password); a refresh token is neither
 * low-entropy nor user-chosen, so that property brings no benefit here and would only add
 * needless latency to every single refresh call.
 */
export function hashRefreshToken(rawToken: string, config: AuthConfig): string {
  return createHmac("sha256", config.jwtRefreshSecret).update(rawToken).digest("base64url");
}
