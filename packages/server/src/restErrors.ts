// Phase 27 — the single error envelope (API Spec §5.1) plus the per-request id it names, used by
// every route THIS phase adds (POST/GET/PATCH/DELETE /v1/documents[/:id], GET /v1/users/search)
// and by the new REST auth middleware (authMiddleware.ts) guarding them.
//
// Deliberately NOT retrofitted onto Phase 26's already-shipped /v1/auth/login, /refresh, /logout
// routes, even though §5.1's own text reads "every non-2xx response" without qualification: this
// phase's own Scope-IN names a specific, new set of endpoints (§4.3-§4.6, §4.16), not a rewrite
// of an already-completed, already-DoD-verified phase's response shape — auth.db.test.ts's own
// existing assertions (`{ error: "invalid_credentials" }`, a flat string, not this envelope) are
// real, passing, load-bearing tests this phase has no mandate to break. A future phase can migrate
// the auth routes to this same envelope explicitly, if and when asked.

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface ErrorEnvelopeDetails {
  readonly fields?: readonly string[];
}

/**
 * API Spec §5.1, exactly this shape: `{ error: { code, message, requestId, details? } }`.
 * `details` is present ONLY for `validation_failed` (§5.1's own explicit carve-out) — every other
 * code omits the key entirely rather than sending `details: undefined`/`null`, so a client can
 * reliably treat the key's mere PRESENCE as "this response names specific offending fields."
 */
export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  requestId: string,
  details?: ErrorEnvelopeDetails,
): void {
  res.status(status).json({
    error: {
      code,
      message,
      requestId,
      ...(details ? { details } : {}),
    },
  });
}

/**
 * One request id per HTTP request, attached to `res.locals` (not a custom `Request` field — no
 * ambient module augmentation needed) and logged on both the way in and the way out — API Spec
 * §5.1's own requirement: "requestId appears in every server log line for that request." Mounted
 * as the very FIRST `app.use()` in httpApp.ts, ahead of `express.json()`, so even a request that
 * fails JSON parsing already has a requestId to report in its own error envelope.
 */
export interface RequestIdLocals {
  readonly requestId: string;
}

export function requestIdMiddleware(
  logRequest: (event: string, fields: Record<string, unknown>) => void,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = randomUUID();
    (res.locals as { requestId: string }).requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    const startedAtMs = Date.now();
    logRequest("http.request", { requestId, method: req.method, path: req.path });
    res.on("finish", () => {
      logRequest("http.response", {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAtMs,
      });
    });
    next();
  };
}
