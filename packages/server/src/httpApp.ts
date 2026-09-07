import express, { type Express } from "express";
import { Engine } from "@collab-editor/engine";
import type { DocumentCoordinator } from "./documentCoordinator.js";

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
export function createHttpApp(deps: HttpAppDeps): Express {
  const app = express();
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
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
