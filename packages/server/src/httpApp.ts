import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { Engine } from "@collab-editor/engine";
import { encodeControlFrame, SessionRole } from "@collab-editor/protocol";
import { parseCookie, stringifySetCookie } from "cookie";
import type { DocumentCoordinator } from "./documentCoordinator.js";
import type { AuthConfig } from "./config.js";
import type { DbPool } from "./db/pool.js";
import { findUserById } from "./db/authStore.js";
import {
  attemptLogin,
  createRefreshFamily,
  issueAccessToken,
  revokeRefreshFamilyByRawToken,
  rotateRefreshToken,
} from "./authService.js";
import { InMemoryRateLimiter } from "./rateLimiter.js";
import { logger } from "./logger.js";
import { requireAuth, type AuthLocals } from "./authMiddleware.js";
import { requestIdMiddleware, sendError, type RequestIdLocals } from "./restErrors.js";
import {
  ALL_DOCUMENT_ROLES,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  createDocumentForUser,
  deleteDocumentAccess,
  getDocumentForUser,
  grantPermissionForUser,
  isDocumentRole,
  listDocumentsForUserService,
  renameDocument,
  revokePermissionForUser,
  searchUsersForResponse,
  transferOwnershipForUser,
} from "./documentService.js";
import { getUserRole, type DocumentRole } from "./db/documentStore.js";
import type { InMemoryTicketStore } from "./ticketStore.js";

/**
 * Phase 28/29 (API Spec §4.7/§4.8/§3.6.9: "pushes PERMISSION_CHANGED to every open session for
 * that user on that document" — Phase 29's own `effectiveAtSeq` field now carried too). Finds the
 * target's live sessions via `DocumentCoordinator.getSessionsByUserId` — see that method's own
 * doc comment: this only genuinely reaches a live session as of Phase 29, when that session was
 * admitted through real ticket-based validation (its `userId` is then the real authenticated one,
 * not the Phase 8-28 random placeholder).
 *
 * `role: null` (DELETE .../permissions/{userId}, full revocation) still enforces immediately —
 * `session.role` itself is set to VIEWER either way, since VIEWER is what actually blocks every
 * mutating operation (`authorizeSession`) and there is no separate `SessionRole` value for "no
 * access at all" — but the WIRE message carries `role: null`, not `VIEWER`, so the client can
 * distinguish "you were downgraded to viewer" from "you lost all access" for its own UI/export
 * messaging (FR-PM-8). This does NOT disconnect the socket (unlike DELETE /v1/documents/{id}'s
 * `disconnectAllSessions`, which really does end the WHOLE document for everyone) — a revoked
 * user's live session simply stops being able to write, exactly like an ordinary viewer.
 */
function pushPermissionChanged(
  coordinator: DocumentCoordinator | undefined,
  userId: string,
  role: DocumentRole | null,
  effectiveAtSeq: number,
): void {
  if (!coordinator) return;
  const sessionRole =
    role === "owner" ? SessionRole.OWNER : role === "editor" ? SessionRole.EDITOR : SessionRole.VIEWER;
  for (const session of coordinator.getSessionsByUserId(userId)) {
    session.role = sessionRole;
    coordinator.invalidateAuthorizationCache(session.sessionId);
    session.queues.enqueue(
      "control",
      encodeControlFrame({
        kind: "permissionChanged",
        role: role === "owner" ? SessionRole.OWNER : role === "editor" ? SessionRole.EDITOR : role === "viewer" ? SessionRole.VIEWER : null,
        effectiveAtSeq,
      }),
    );
  }
}

/** API Spec §4.1/§4.2's own literal cookie name/path — the ONE place both are named, so /login, /refresh, and /logout can never drift out of sync with each other. */
const REFRESH_COOKIE_NAME = "rt";
const REFRESH_COOKIE_PATH = "/v1/auth/refresh";

export interface HttpAppDeps {
  /**
   * Lazily reads the gateway's live coordinator map. A getter, not the map
   * itself, because of construction order: `createHttpApp()` runs BEFORE
   * `createGateway()` (the HTTP server needs the Express app before the
   * gateway can attach to it — server.ts), so no `Gateway` object exists
   * yet at the point this function is called. The closure server.ts passes
   * resolves once the gateway is actually created, before any real request
   * could ever reach this route handler.
   */
  readonly getCoordinators: () => ReadonlyMap<string, DocumentCoordinator>;
  /**
   * Phase 26 (API Spec §4.1/§4.2) — REQUIRED for POST /v1/auth/login, /refresh, /logout to be
   * mounted at all. Optional here for the SAME reason `OperationStore` is injectable rather than
   * hard-wired (operationStore.ts's own header comment): every pre-Phase-26 test constructing an
   * app via `createHttpApp`/`createCollabServer` (gateway.test.ts, httpApp.test.ts, client's
   * headlessHarness.test.ts — part of the default `pnpm test`) has no real Postgres instance and
   * must keep working unchanged. When omitted, the three auth routes are simply never mounted
   * (a request to them 404s, the same as any other undefined route) — mirroring how every
   * existing `/v1/documents/:id/...` route already 404s for an unknown id rather than crashing.
   * Only `index.ts`'s real direct-run path and this phase's own new `*.db.test.ts` suite ever
   * supply this. `ticketStore` (Phase 29, API Spec §4.10) is REQUIRED alongside the other two
   * rather than its own separate optional field — WebSocket admission tickets are meaningless
   * without the same real Postgres/JWT infrastructure `authDeps` already gates, and this MUST be
   * the exact same `InMemoryTicketStore` instance `createGateway`'s own `auth.ticketStore` is
   * given (server.ts's own construction is what guarantees that single-instance sharing).
   */
  readonly authDeps?: {
    readonly pool: DbPool;
    readonly authConfig: AuthConfig;
    readonly ticketStore: InMemoryTicketStore;
  };
}

/** Builds the exact `Set-Cookie` value API Spec §4.1/§4.2 requires: `HttpOnly; Secure; SameSite=Strict; Path=/v1/auth/refresh`. `maxAgeSeconds: 0` (logout, or any dead-end auth failure) clears the cookie in every real browser — the standard "expire a cookie" idiom, since there is no separate "delete cookie" primitive in the Set-Cookie spec itself. */
function refreshCookieHeader(rawToken: string, maxAgeSeconds: number): string {
  return stringifySetCookie({
    name: REFRESH_COOKIE_NAME,
    value: rawToken,
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: Math.max(0, Math.trunc(maxAgeSeconds)),
  });
}

/**
 * Express app. `/healthz` plus a diagnostic replay endpoint (Test Plan
 * §2.7 E2E-CONV-01 assertion 3 — independent ground truth, not just
 * reading the coordinator's own live engine). As of Phase 17, this
 * replays the FULL persisted operation log from genesis, on demand, via
 * `operationStore.loadFullOperationLog()` — deliberately NOT the
 * coordinator's own `engine` (which, since Phase 17, only reflects the
 * latest snapshot plus its suffix, not necessarily a genesis replay) and
 * no longer backed by an in-memory `operationLog` array at all (removed
 * this phase — it was written but never read once these two endpoints
 * became the only consumer of "full genesis history" and now query the
 * database directly, on demand, instead of keeping every operation a
 * coordinator has ever seen resident in memory for the life of the
 * process). No auth on this route — consistent with this project's
 * existing "no security concern yet, nothing is exposed publicly" stance
 * (Phases 8-13 apply the same reasoning to the WS gateway itself).
 */
/**
 * Phase 26 — POST /v1/auth/login, /refresh, /logout (API Spec §4.1/§4.2). A separate function,
 * not inlined into `createHttpApp`, purely to keep that function's own body from growing
 * unreadably long — no behavioral reason for the split. The `InMemoryRateLimiter` instance is
 * created ONCE here (one per `createHttpApp()` call, i.e. one per real server process — or one
 * per test-constructed app) and captured by the login route's closure, so it persists for the
 * whole app's lifetime rather than resetting per request.
 */
function mountAuthRoutes(app: Express, pool: DbPool, authConfig: AuthConfig): void {
  const rateLimiter = new InMemoryRateLimiter();

  app.post("/v1/auth/login", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { email, password } = body;
    if (
      typeof email !== "string" ||
      email.length === 0 ||
      typeof password !== "string" ||
      password.length === 0
    ) {
      res.status(400).json({ error: "validation_failed" });
      return;
    }

    // Rate limiting happens BEFORE `attemptLogin` — a genuinely separate concern from SEC-11g's
    // own timing requirement (see authService.ts's own header comment for why folding this
    // check into `attemptLogin` itself would reintroduce the same class of bug one layer up).
    // Per-IP first, then per-account — order doesn't affect correctness (both are checked on
    // every request either way), only which 429 fires first when both would trip.
    const ip = req.ip ?? "unknown";
    if (!rateLimiter.consume(`ip:${ip}`, authConfig.loginRateLimitPerIp)) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    if (!rateLimiter.consume(`account:${email.toLowerCase()}`, authConfig.loginRateLimitPerAccount)) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    const user = await attemptLogin(pool, email, password);
    if (!user) {
      // API Spec §4.1: IDENTICAL response body and timing for an unknown email and a wrong
      // password — `attemptLogin` itself already guarantees the timing half (SEC-11g); this is
      // the response-body half, a single `401 invalid_credentials` for both cases, with no
      // field anywhere that could distinguish them.
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    const { accessToken, expiresIn } = issueAccessToken(user, authConfig);
    const { rawToken, expiresAt } = await createRefreshFamily(pool, authConfig, user.id);
    res.setHeader(
      "Set-Cookie",
      refreshCookieHeader(rawToken, (expiresAt.getTime() - Date.now()) / 1000),
    );
    res.status(200).json({
      accessToken,
      expiresIn,
      user: { id: user.id, email: user.email, displayName: user.displayName },
    });
  });

  app.post("/v1/auth/refresh", async (req, res) => {
    const presented = parseCookie(req.headers.cookie ?? "")[REFRESH_COOKIE_NAME];
    if (!presented) {
      res.status(401).json({ error: "session_expired" });
      return;
    }
    const result = await rotateRefreshToken(pool, authConfig, presented);
    if (result.outcome !== "rotated") {
      if (result.outcome === "reuse_detected") {
        // No token value logged — only identifiers (API Spec's own "no token appears in any
        // URL or server log" requirement extends to every log call this phase adds, not just
        // to the routes' own request/response handling).
        logger.warn("auth.refreshReuseDetected", {
          userId: result.userId,
          familyId: result.familyId,
        });
      }
      res.setHeader("Set-Cookie", refreshCookieHeader("", 0));
      res.status(401).json({ error: "session_expired" });
      return;
    }
    const user = await findUserById(pool, result.userId);
    if (!user) {
      // Structurally shouldn't happen (a refresh_tokens.user_id FK guarantees the row exists)
      // — treated as a dead session rather than a 500, the same "fail closed" discipline as
      // `verifyPassword`'s own malformed-hash handling.
      res.setHeader("Set-Cookie", refreshCookieHeader("", 0));
      res.status(401).json({ error: "session_expired" });
      return;
    }
    const { accessToken, expiresIn } = issueAccessToken(user, authConfig);
    res.setHeader(
      "Set-Cookie",
      refreshCookieHeader(result.issued.rawToken, (result.issued.expiresAt.getTime() - Date.now()) / 1000),
    );
    res.status(200).json({ accessToken, expiresIn });
  });

  app.post("/v1/auth/logout", async (req, res) => {
    const presented = parseCookie(req.headers.cookie ?? "")[REFRESH_COOKIE_NAME];
    if (presented) {
      await revokeRefreshFamilyByRawToken(pool, authConfig, presented);
    }
    res.setHeader("Set-Cookie", refreshCookieHeader("", 0));
    res.status(204).end();
  });
}

/**
 * Phase 27 — POST/GET/PATCH/DELETE /v1/documents[/:id], GET /v1/users/search (API Spec §4.3-§4.6,
 * §4.16). Every route runs behind `requireAuth` (authMiddleware.ts) — the Test Plan §11.1 "any"
 * row's missing-auth/expired-token cases apply uniformly across all of them. Each handler stays
 * thin: parse the request, call one documentService.ts function, map its discriminated outcome to
 * a status code — the actual role-check/idempotency/pagination logic lives there, independently
 * testable without an Express request/response object.
 */
function mountDocumentRoutes(
  app: Express,
  pool: DbPool,
  authConfig: AuthConfig,
  getCoordinators: () => ReadonlyMap<string, DocumentCoordinator>,
  ticketStore: InMemoryTicketStore,
): void {
  const auth = requireAuth(authConfig);
  // Phase 29 — same "one instance for this app's whole lifetime" shape as mountAuthRoutes's own
  // login rate limiter, a SEPARATE limiter (a per-user ticket-churn cap is a different concern
  // than a per-IP/per-account login cap, and reusing the login limiter's own keys would let
  // ticket-issuance traffic and login traffic silently interfere with each other's counters).
  const ticketRateLimiter = new InMemoryRateLimiter();

  function requestId(res: Response): string {
    return (res.locals as RequestIdLocals).requestId;
  }

  function authedUserId(res: Response): string {
    return (res.locals as AuthLocals).user.sub;
  }

  function authedUser(res: Response): AuthLocals["user"] {
    return (res.locals as AuthLocals).user;
  }

  app.post("/v1/documents", auth, async (req, res) => {
    const idempotencyKeyHeader = req.headers["idempotency-key"];
    const idempotencyKey =
      typeof idempotencyKeyHeader === "string" ? idempotencyKeyHeader : undefined;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const outcome = await createDocumentForUser(pool, {
      ownerId: authedUserId(res),
      rawTitle: body.title,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    switch (outcome.kind) {
      case "validation-failed":
        sendError(
          res,
          400,
          "validation_failed",
          "title must be a string of at most 512 characters",
          requestId(res),
          { fields: ["title"] },
        );
        return;
      case "idempotency-conflict":
        sendError(
          res,
          409,
          "idempotency_key_reused",
          "This Idempotency-Key was already used with a different request body",
          requestId(res),
        );
        return;
      case "replay":
        res.status(outcome.status).json(outcome.body);
        return;
      case "created":
        res.status(201).location(`/v1/documents/${outcome.body.id}`).json(outcome.body);
        return;
    }
  });

  app.get("/v1/documents", auth, async (req, res) => {
    const rawRoles = req.query.role;
    const roleTokens = Array.isArray(rawRoles) ? rawRoles : rawRoles !== undefined ? [rawRoles] : [];
    const roles: DocumentRole[] = [];
    for (const token of roleTokens) {
      if (typeof token !== "string" || !isDocumentRole(token)) {
        sendError(
          res,
          400,
          "validation_failed",
          `?role= must be one of: ${ALL_DOCUMENT_ROLES.join(", ")}`,
          requestId(res),
          { fields: ["role"] },
        );
        return;
      }
      roles.push(token);
    }
    const requestedLimit = Number(req.query.limit ?? DEFAULT_LIST_LIMIT);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_LIST_LIMIT)
      : DEFAULT_LIST_LIMIT;
    const rawCursor = req.query.cursor;
    if (rawCursor !== undefined && typeof rawCursor !== "string") {
      sendError(res, 400, "validation_failed", "?cursor= must be a string", requestId(res), {
        fields: ["cursor"],
      });
      return;
    }
    const outcome = await listDocumentsForUserService(
      pool,
      {
        userId: authedUserId(res),
        limit,
        ...(roles.length > 0 ? { roles } : {}),
        ...(rawCursor !== undefined ? { cursor: rawCursor } : {}),
      },
      (documentId) => getCoordinators().get(documentId)?.sessionCount ?? 0,
    );
    if (outcome.kind === "invalid-cursor") {
      sendError(res, 400, "validation_failed", "?cursor= is not a valid cursor", requestId(res), {
        fields: ["cursor"],
      });
      return;
    }
    res.status(200).json({ documents: outcome.documents, nextCursor: outcome.nextCursor });
  });

  app.get("/v1/documents/:documentId", auth, async (req: Request<{ documentId: string }>, res: Response) => {
    const coordinator = getCoordinators().get(req.params.documentId);
    // API Spec §4.5's structureSize/tombstoneCount are "owner only" and reflect editing VOLUME —
    // prefer a currently-open coordinator's live `engine.stats()` over the durable
    // `documents.structure_size`/`tombstone_count` columns, which no code path in this project
    // currently maintains (db/documentStore.ts's own `DocumentRow.structureSize` doc comment).
    const liveStats = coordinator
      ? {
          structureSize: coordinator.engine.stats().totalElements,
          tombstoneCount: coordinator.engine.stats().tombstones,
        }
      : undefined;
    const outcome = await getDocumentForUser(pool, {
      documentId: req.params.documentId,
      userId: authedUserId(res),
      ...(liveStats ? { liveStats } : {}),
    });
    if (outcome.kind === "not-found") {
      sendError(
        res,
        404,
        "document_not_found",
        "No document with this id, or you do not have access to it",
        requestId(res),
      );
      return;
    }
    res.status(200).json(outcome.body);
  });

  app.patch("/v1/documents/:documentId", auth, async (req: Request<{ documentId: string }>, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const outcome = await renameDocument(pool, {
      documentId: req.params.documentId,
      userId: authedUserId(res),
      rawTitle: body.title,
    });
    switch (outcome.kind) {
      case "not-found":
        sendError(
          res,
          404,
          "document_not_found",
          "No document with this id, or you do not have access to it",
          requestId(res),
        );
        return;
      case "forbidden":
        sendError(res, 403, "permission_denied", "Only the document owner may rename it", requestId(res));
        return;
      case "validation-failed":
        sendError(
          res,
          400,
          "validation_failed",
          "title must be a non-empty string of at most 512 characters",
          requestId(res),
          { fields: ["title"] },
        );
        return;
      case "ok":
        res.status(200).json(outcome.body);
        return;
    }
  });

  app.delete("/v1/documents/:documentId", auth, async (req: Request<{ documentId: string }>, res: Response) => {
    const documentId = req.params.documentId;
    const outcome = await deleteDocumentAccess(pool, { documentId, userId: authedUserId(res) });
    switch (outcome.kind) {
      case "not-found":
        sendError(
          res,
          404,
          "document_not_found",
          "No document with this id, or you do not have access to it",
          requestId(res),
        );
        return;
      case "forbidden":
        sendError(res, 403, "permission_denied", "Only the document owner may delete it", requestId(res));
        return;
      case "ok":
        // API Spec §4.5: "causes every open socket for the document to receive GOODBYE{reason:
        // 2}" — AFTER the durable revocation above has already committed, never before (telling a
        // live socket "you're revoked" while the database still showed active permissions would
        // be a real, if narrow, inconsistency window).
        getCoordinators().get(documentId)?.disconnectAllSessions();
        res.status(204).end();
        return;
    }
  });

  app.put(
    "/v1/documents/:documentId/permissions/:userId",
    auth,
    async (req: Request<{ documentId: string; userId: string }>, res: Response) => {
      const { documentId, userId } = req.params;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const outcome = await grantPermissionForUser(pool, {
        documentId,
        callerId: authedUserId(res),
        targetUserId: userId,
        rawRole: body.role,
      });
      switch (outcome.kind) {
        case "not-found":
          sendError(
            res,
            404,
            "document_not_found",
            "No document with this id, or you do not have access to it",
            requestId(res),
          );
          return;
        case "forbidden":
          sendError(
            res,
            403,
            "permission_denied",
            "Only the document owner may grant or change a permission",
            requestId(res),
          );
          return;
        case "user-not-found":
          sendError(res, 404, "user_not_found", "No user with this id", requestId(res));
          return;
        case "cannot-change-own-owner-role":
          sendError(
            res,
            409,
            "cannot_change_own_owner_role",
            "The owner cannot change their own role this way — use POST /v1/documents/{id}/owner to transfer ownership",
            requestId(res),
          );
          return;
        case "validation-failed":
          sendError(
            res,
            400,
            "validation_failed",
            "role must be one of: editor, viewer",
            requestId(res),
            { fields: ["role"] },
          );
          return;
        case "ok":
          // API Spec §4.7: "publishes an authorization invalidation and pushes PERMISSION_CHANGED
          // to every open session for that user on that document" — see pushPermissionChanged's
          // own doc comment for the disclosed limit on what "that user"'s live sessions actually
          // means today.
          pushPermissionChanged(
            getCoordinators().get(documentId),
            userId,
            outcome.body.role,
            outcome.body.effectiveAtSeq,
          );
          res.status(200).json(outcome.body);
          return;
      }
    },
  );

  app.delete(
    "/v1/documents/:documentId/permissions/:userId",
    auth,
    async (req: Request<{ documentId: string; userId: string }>, res: Response) => {
      const { documentId, userId } = req.params;
      const outcome = await revokePermissionForUser(pool, {
        documentId,
        callerId: authedUserId(res),
        targetUserId: userId,
      });
      switch (outcome.kind) {
        case "not-found":
          sendError(
            res,
            404,
            "document_not_found",
            "No document with this id, or you do not have access to it",
            requestId(res),
          );
          return;
        case "forbidden":
          sendError(
            res,
            403,
            "permission_denied",
            "Only the document owner may revoke a permission",
            requestId(res),
          );
          return;
        case "target-not-found":
          sendError(res, 404, "user_not_found", "No user with this id", requestId(res));
          return;
        case "cannot-revoke-owner":
          sendError(
            res,
            409,
            "cannot_revoke_owner",
            "The document owner's own access cannot be revoked — transfer ownership first",
            requestId(res),
          );
          return;
        case "ok":
          pushPermissionChanged(getCoordinators().get(documentId), userId, null, outcome.effectiveAtSeq);
          res.status(204).end();
          return;
      }
    },
  );

  app.post(
    "/v1/documents/:documentId/owner",
    auth,
    async (req: Request<{ documentId: string }>, res: Response) => {
      const documentId = req.params.documentId;
      const callerId = authedUserId(res);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const outcome = await transferOwnershipForUser(pool, {
        documentId,
        callerId,
        rawNewOwnerId: body.newOwnerId,
      });
      switch (outcome.kind) {
        case "not-found":
          sendError(
            res,
            404,
            "document_not_found",
            "No document with this id, or you do not have access to it",
            requestId(res),
          );
          return;
        case "forbidden":
          sendError(
            res,
            403,
            "permission_denied",
            "Only the current document owner may transfer ownership",
            requestId(res),
          );
          return;
        case "validation-failed":
          sendError(res, 400, "validation_failed", "newOwnerId is required", requestId(res), {
            fields: ["newOwnerId"],
          });
          return;
        case "user-not-found":
          sendError(res, 404, "user_not_found", "No user with this id", requestId(res));
          return;
        case "target-has-no-access":
          sendError(
            res,
            409,
            "target_has_no_access",
            "The target user must already have some access to this document before receiving ownership",
            requestId(res),
          );
          return;
        case "ok": {
          const coordinator = getCoordinators().get(documentId);
          // Both parties' roles changed as one atomic transaction (transferOwnership's own
          // FOR-UPDATE-serialized transaction) — push PERMISSION_CHANGED to both, if either is
          // currently connected (see pushPermissionChanged's own doc comment for the disclosed
          // limit on what "connected" actually means today).
          const newOwnerId = typeof body.newOwnerId === "string" ? body.newOwnerId : "";
          pushPermissionChanged(coordinator, callerId, "editor", outcome.body.currentSeq);
          pushPermissionChanged(coordinator, newOwnerId, "owner", outcome.body.currentSeq);
          res.status(200).json(outcome.body);
          return;
        }
      }
    },
  );

  /**
   * Phase 29 (API Spec §4.10) — the WebSocket admission ticket endpoint. "Any role" (owner,
   * editor, or viewer all qualify — a viewer needs a ticket to even READ over WS, same as an
   * editor needs one to write), so the ONLY 404-vs-403 split possible here is the standard
   * enumeration-oracle rule (no permission row at all → 404, same as every other route) — this
   * endpoint structurally never returns 403 `permission_denied`, since there is no "has SOME role
   * but an insufficient one" case for "any role."
   */
  app.post(
    "/v1/documents/:documentId/rt-ticket",
    auth,
    async (req: Request<{ documentId: string }>, res: Response) => {
      const documentId = req.params.documentId;
      const user = authedUser(res);
      const role = await getUserRole(pool, documentId, user.sub);
      if (!role) {
        sendError(
          res,
          404,
          "document_not_found",
          "No document with this id, or you do not have access to it",
          requestId(res),
        );
        return;
      }
      if (!ticketRateLimiter.consume(`ticket:${user.sub}`, authConfig.ticketRateLimit)) {
        sendError(res, 429, "rate_limited", "Too many ticket requests", requestId(res));
        return;
      }
      const { ticket, expiresAtMs } = ticketStore.issue(
        documentId,
        user.sub,
        user.displayName,
        authConfig.ticketTtlMs,
      );
      res.status(201).json({
        ticket,
        expiresIn: Math.round((expiresAtMs - Date.now()) / 1000),
        documentId,
      });
    },
  );

  app.get("/v1/users/search", auth, async (req, res) => {
    const q = req.query.q;
    if (typeof q !== "string" || q.length === 0) {
      sendError(res, 400, "validation_failed", "?q= is required", requestId(res), { fields: ["q"] });
      return;
    }
    const users = await searchUsersForResponse(pool, q);
    res.status(200).json({ users });
  });
}

export function createHttpApp(deps: HttpAppDeps): Express {
  const app = express();
  // Phase 27 (API Spec §5.1) — MUST run before `express.json()`: even a request that fails JSON
  // parsing (the very next middleware) needs a requestId to report in its own error envelope, and
  // "requestId ... in every server log line for that request" means the very FIRST log line for a
  // request (below) needs one too.
  app.use(requestIdMiddleware(logger.info));
  // Only POST /v1/auth/* and POST/PATCH /v1/documents* bodies exist in this whole app — every
  // other route is GET with no body — but mounting this unconditionally is harmless (a no-op for
  // a bodyless GET) and is simpler than conditionally mounting it only when a body-bearing route
  // is present.
  app.use(express.json());
  // `express.json()` calls `next(err)` on syntactically invalid JSON, which — left unhandled —
  // would fall through to Express's own default HTML error page instead of this API's own
  // consistent error shape. Malformed input of ANY kind is a `validation_failed`, whether it's a
  // missing field or a body that isn't valid JSON at all — but WHICH shape depends on which
  // phase's routes are being hit: Phase 27's own new `/v1/documents*` routes use the real §5.1
  // envelope (restErrors.ts); Phase 26's already-shipped `/v1/auth/*` routes keep their own
  // simpler, already-DoD-verified `{ error: "..." }` shape unchanged (see restErrors.ts's own
  // header comment for why this phase doesn't retrofit that).
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      if (req.path.startsWith("/v1/documents")) {
        sendError(
          res,
          400,
          "validation_failed",
          "Malformed JSON request body",
          (res.locals as RequestIdLocals).requestId,
        );
        return;
      }
      res.status(400).json({ error: "validation_failed" });
      return;
    }
    next(err);
  });
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  if (deps.authDeps) {
    mountAuthRoutes(app, deps.authDeps.pool, deps.authDeps.authConfig);
    mountDocumentRoutes(
      app,
      deps.authDeps.pool,
      deps.authDeps.authConfig,
      deps.getCoordinators,
      deps.authDeps.ticketStore,
    );
  }
  app.get("/v1/documents/:documentId/replay", async (req, res) => {
    const coordinator = deps.getCoordinators().get(req.params.documentId);
    if (!coordinator) {
      res.status(404).json({ error: "document not found" });
      return;
    }
    const ops = await coordinator.operationStore.loadFullOperationLog(req.params.documentId);
    // Replica id here is arbitrary — this Engine only ever calls `applyRemote`, never mints a
    // local identifier, so its own replicaId never appears in any produced Identifier.
    const replay = new Engine(0);
    for (const op of ops) {
      replay.applyRemote(op);
    }
    res.status(200).json({
      text: replay.text(),
      opCount: ops.length,
      pendingCount: replay.pending.length,
    });
  });
  // Diagnostic-only addition (not part of any phase's Scope-IN): same replay as above, but
  // returns the full node structure (ids/origins/bind/tombstone state) instead of only
  // materialized text, so a cross-client divergence can be root-caused at the node level.
  // Added while investigating a real divergence found during Phase 14 DoD verification — see
  // CLAUDE.md's Phase 14 entry.
  app.get("/v1/documents/:documentId/replay-nodes", async (req, res) => {
    const coordinator = deps.getCoordinators().get(req.params.documentId);
    if (!coordinator) {
      res.status(404).json({ error: "document not found" });
      return;
    }
    const ops = await coordinator.operationStore.loadFullOperationLog(req.params.documentId);
    const replay = new Engine(0);
    for (const op of ops) {
      replay.applyRemote(op);
    }
    res.status(200).json({
      nodes: replay.nodes.map((n) => ({
        id: n.id,
        parent: n.parent,
        side: n.side,
        bind: n.bind,
        deleted: n.deleted,
        deletedBy: n.deletedBy,
        value: n.value,
      })),
      opCount: ops.length,
      pendingCount: replay.pending.length,
    });
  });
  // Diagnostic-only addition (see documentCoordinator.ts's CoordinatorSession.receivedFrameCount
  // doc comment): per-connection frame-receipt counts, so a client's own reported send-call
  // count can be compared directly against how many of those the server actually saw arrive.
  app.get("/v1/documents/:documentId/session-frame-counts", (req, res) => {
    const coordinator = deps.getCoordinators().get(req.params.documentId);
    if (!coordinator) {
      res.status(404).json({ error: "document not found" });
      return;
    }
    res.status(200).json({ sessions: coordinator.listReceivedFrameCounts() });
  });
  // Phase 18 DoD: "audit_runs rows are queryable and the 'last successful run' timestamp is
  // exposed as a metric." Read-only, observability only — nothing here TRIGGERS an audit; that's
  // auditScheduler.ts's recurring timer or scripts/admin.ts's on-demand CLI. `?limit=` defaults
  // to 20, capped at 200 to keep this endpoint cheap regardless of how long a document has
  // existed. Reads through `coordinator.operationStore` (real Postgres in production,
  // `InMemoryOperationStore` in every pre-Phase-18 test) rather than a separate store reference,
  // consistent with `/replay`'s own pattern above.
  app.get("/v1/documents/:documentId/audit-runs", async (req, res) => {
    const coordinator = deps.getCoordinators().get(req.params.documentId);
    if (!coordinator) {
      res.status(404).json({ error: "document not found" });
      return;
    }
    const requestedLimit = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : 20;
    const [runs, lastSuccessAt] = await Promise.all([
      coordinator.operationStore.listAuditRuns(req.params.documentId, limit),
      coordinator.operationStore.getLastSuccessfulAuditRunAt(req.params.documentId),
    ]);
    res.status(200).json({
      runs: runs.map((r) => ({
        id: r.id,
        replayedToSeq: r.replayedToSeq.toString(),
        result: r.result,
        divergenceSeq: r.divergenceSeq?.toString() ?? null,
        detail: r.detail,
        ranAt: r.ranAt.toISOString(),
      })),
      lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    });
  });
  // Phase 21 DoD: "gc.minutes_since_last_success is a metric — GC's failure mode is silent, so
  // liveness is monitored, not errors." Read-only, observability only — nothing here TRIGGERS a
  // GC cycle; that's gcScheduler.ts's recurring timer. `minutesSinceLastSuccess` is `null` before
  // this coordinator's very first GC cycle has ever completed (nothing to measure against yet),
  // matching `/audit-runs`'s own `lastSuccessAt: null` convention for the identical situation.
  app.get("/v1/documents/:documentId/gc-status", (req, res) => {
    const coordinator = deps.getCoordinators().get(req.params.documentId);
    if (!coordinator) {
      res.status(404).json({ error: "document not found" });
      return;
    }
    const stats = coordinator.engine.stats();
    const nowMs = Date.now();
    res.status(200).json({
      lastAttemptAt: coordinator.lastGcAttemptAt?.toISOString() ?? null,
      lastSuccessAt: coordinator.lastGcSuccessAt?.toISOString() ?? null,
      minutesSinceLastSuccess: coordinator.lastGcSuccessAt
        ? (nowMs - coordinator.lastGcSuccessAt.getTime()) / 60_000
        : null,
      nodesCollectedLastCycle: coordinator.lastGcCollectedCount,
      cycleIncompleteCount: coordinator.gcCycleIncompleteCount,
      frontier: coordinator.lastKnownFrontier.toString(),
      frontierLagSeconds: coordinator.frontierLastAdvancedAt
        ? (nowMs - coordinator.frontierLastAdvancedAt.getTime()) / 1_000
        : null,
      tombstoneRatio: stats.totalElements === 0 ? 0 : stats.tombstones / stats.totalElements,
      totalElements: stats.totalElements,
      tombstones: stats.tombstones,
    });
  });
  return app;
}
