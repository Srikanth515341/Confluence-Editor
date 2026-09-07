import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { Engine } from "@collab-editor/engine";
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
   * supply this.
   */
  readonly authDeps?: { readonly pool: DbPool; readonly authConfig: AuthConfig };
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

export function createHttpApp(deps: HttpAppDeps): Express {
  const app = express();
  // Only POST /v1/auth/* bodies exist in this whole app — every other route is GET with no
  // body — but mounting this unconditionally is harmless (a no-op for a bodyless GET) and is
  // simpler than conditionally mounting it only when `authDeps` is present.
  app.use(express.json());
  // `express.json()` calls `next(err)` on syntactically invalid JSON, which — left unhandled —
  // would fall through to Express's own default HTML error page instead of this API's own
  // consistent `{ error: "..." }` JSON shape. Malformed input of ANY kind on an auth route is a
  // `validation_failed`, whether it's a missing field or a body that isn't valid JSON at all.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
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
