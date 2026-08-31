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
 * Express app. `/healthz` plus, new this phase, a diagnostic replay
 * endpoint (Test Plan §2.7 E2E-CONV-01 assertion 3 — see
 * documentCoordinator.ts's `operationLog` doc comment for why an
 * independent replay, not just reading the coordinator's own live engine,
 * is the point). No auth on this route — consistent with this project's
 * existing "no security concern yet, nothing is exposed publicly" stance
 * (Phases 8-13 apply the same reasoning to the WS gateway itself).
 */
export function createHttpApp(deps: HttpAppDeps): Express {
  const app = express();
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/v1/documents/:documentId/replay", (req, res) => {
    const coordinator = deps.getCoordinators().get(req.params.documentId);
    if (!coordinator) {
      res.status(404).json({ error: "document not found" });
      return;
    }
    // Replica id here is arbitrary — this Engine only ever calls `applyRemote`, never mints a
    // local identifier, so its own replicaId never appears in any produced Identifier.
    const replay = new Engine(0);
    for (const op of coordinator.operationLog) {
      replay.applyRemote(op);
    }
    res.status(200).json({
      text: replay.text(),
      opCount: coordinator.operationLog.length,
      pendingCount: replay.pending.length,
    });
  });
  // Diagnostic-only addition (not part of any phase's Scope-IN): same replay as above, but
  // returns the full node structure (ids/origins/bind/tombstone state) instead of only
  // materialized text, so a cross-client divergence can be root-caused at the node level.
  // Added while investigating a real divergence found during Phase 14 DoD verification — see
  // CLAUDE.md's Phase 14 entry.
  app.get("/v1/documents/:documentId/replay-nodes", (req, res) => {
    const coordinator = deps.getCoordinators().get(req.params.documentId);
    if (!coordinator) {
      res.status(404).json({ error: "document not found" });
      return;
    }
    const replay = new Engine(0);
    for (const op of coordinator.operationLog) {
      replay.applyRemote(op);
    }
    res.status(200).json({
      nodes: replay.nodes.map((n) => ({
        id: n.id,
        originLeft: n.originLeft,
        originRight: n.originRight,
        bind: n.bind,
        deleted: n.deleted,
        deletedBy: n.deletedBy,
        value: n.value,
      })),
      opCount: coordinator.operationLog.length,
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
  return app;
}
