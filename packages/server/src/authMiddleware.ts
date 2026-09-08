// Phase 27 — real Bearer-token authentication for the REST document-lifecycle routes (API Spec
// §4.3-§4.6/§4.16; Test Plan §11.1's "missing auth / expired token" row: "401 · 401
// session_expired"). Phase 26 issued the access token; nothing before this phase ever VERIFIED
// one on an incoming request (CLAUDE.md's own Phase 26 entry: "the WebSocket gateway's own
// handshake does NOT yet verify an access token" — this file is the first thing in the project
// that does, for the REST surface specifically; the WS gateway itself remains untouched, out of
// this phase's own Scope-IN).
//
// The access token travels as `Authorization: Bearer <token>` — never a cookie, unlike the
// refresh token (tokens.ts's own header comment: the two are structurally different secrets for
// a reason). A REST client is expected to hold the access token in memory/local state and attach
// it per request, the ordinary Bearer-token convention this project's own JWT choice already
// implies.

import type { NextFunction, Request, Response } from "express";
import type { AccessTokenClaims } from "./tokens.js";
import { verifyAccessTokenDetailed } from "./tokens.js";
import type { AuthConfig } from "./config.js";
import { sendError, type RequestIdLocals } from "./restErrors.js";

/**
 * What a route handler downstream of `requireAuth` can rely on `res.locals` carrying. Express's
 * own `Response.locals` type defaults to `Record<string, any>` (not this specific shape) — this
 * interface exists purely so route handlers in httpApp.ts can write `res.locals as AuthLocals`
 * once at the top of each handler, rather than re-typing `.user`/`.requestId` ad hoc everywhere.
 */
export interface AuthLocals extends RequestIdLocals {
  user: AccessTokenClaims;
}

/**
 * Test Plan §11.1's own two-way split: a MISSING/malformed/wrong-secret token is a generic
 * `401 unauthenticated` (the row's own bare "401", no code named), while a token that verifies
 * as a real, correctly-signed JWT whose `exp` has simply passed gets the SPECIFIC code the row
 * names explicitly — `401 session_expired`. See tokens.ts's `verifyAccessTokenDetailed` for why
 * this distinction is reliable (it comes from `jwt.verify`'s own thrown error TYPE, not a
 * hand-rolled re-derivation of expiry).
 */
export function requireAuth(authConfig: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = (res.locals as RequestIdLocals).requestId;
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) {
      sendError(res, 401, "unauthenticated", "Missing or malformed Authorization header", requestId);
      return;
    }
    const verification = verifyAccessTokenDetailed(token, authConfig);
    if (verification.outcome === "expired") {
      sendError(res, 401, "session_expired", "Access token has expired", requestId);
      return;
    }
    if (verification.outcome === "invalid") {
      sendError(res, 401, "unauthenticated", "Access token is invalid", requestId);
      return;
    }
    (res.locals as AuthLocals).user = verification.claims;
    next();
  };
}
