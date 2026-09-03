// Scheduled tombstone garbage collection (Phase 21, Engine Spec §7.3
// "causal stability", §7.4 COLLECT, §7.6 eviction, §7.7 undo horizon;
// API Spec §6.5; Test Plan M8-c/M8-d). Runs IN-PROCESS, once per open
// document, on a fixed interval — the same shape as auditScheduler.ts
// (Phase 18), for the same reason: this is the one place with direct
// in-memory access to each coordinator's own live `engine`, which is
// what actually gets mutated (physically shrunk) by a GC cycle.

import type { Gateway } from "./gateway.js";
import type { DocumentCoordinator } from "./documentCoordinator.js";
import type { GcConfig } from "./config.js";
import { logger } from "./logger.js";

export interface GcScheduler {
  stop(): void;
}

/**
 * Starts a recurring timer that runs one GC cycle per open document
 * (`gateway.coordinators`) every `gcConfig.gcIntervalMs` (Scope-IN: "GC
 * cycle every 60s per open document"). A document with no open
 * coordinator (nobody connected) is simply not swept by this scheduler —
 * mirrors auditScheduler.ts's own identical scoping decision, and for
 * the same reason: this is an in-process, currently-open-documents-only
 * control, not a sweep of every document that has ever existed.
 */
export function startGcScheduler(gateway: Gateway, gcConfig: GcConfig): GcScheduler {
  const timer = setInterval(() => {
    void runAllOpenDocuments(gateway, gcConfig);
  }, gcConfig.gcIntervalMs);
  // Same reasoning as every other in-process scheduler in this codebase (snapshotter.ts's
  // implicit per-op scheduling aside, auditScheduler.ts explicitly): never keep the Node
  // process alive solely for this timer, so tests can construct many gateways and exit
  // cleanly without each one explicitly calling `.stop()`.
  timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}

async function runAllOpenDocuments(gateway: Gateway, gcConfig: GcConfig): Promise<void> {
  for (const coordinator of gateway.coordinators.values()) {
    await runOneDocument(coordinator, gcConfig);
  }
}

/** Exported directly (not only reachable via the timer) so tests can trigger exactly one GC cycle deterministically instead of waiting on `gcIntervalMs` or faking timers. */
export async function runOneDocument(
  coordinator: DocumentCoordinator,
  gcConfig: GcConfig,
): Promise<void> {
  coordinator.lastGcAttemptAt = new Date();
  try {
    await coordinator.ready; // a coordinator can be in the map while still warming up

    // API Spec §6.5 / Engine Spec Definition 7.2: the stability frontier, via a real DB
    // query — Rule 7.1's 10-minute eviction window and cold-load compaction's COALESCE
    // fallback both live inside `getStabilityFrontier` itself (operationStore.ts), not here.
    const frontier = await coordinator.operationStore.getStabilityFrontier(
      coordinator.documentId,
    );
    if (frontier > coordinator.lastKnownFrontier || coordinator.frontierLastAdvancedAt === null) {
      coordinator.lastKnownFrontier = frontier;
      coordinator.frontierLastAdvancedAt = new Date();
    }

    // Wall-clock safety cap (Phase 21 safety net) — `budgetMs`/`clock` bound how long ONE
    // document's fixpoint sweep may run before yielding, so a pathological anchor chain on
    // this document can never block the event loop for every OTHER document sharing this
    // process. See engine.ts's CollectOptions/collect() doc comments for the full reasoning.
    const result = coordinator.engine.collect(frontier, {
      nowMs: Date.now(),
      maxAgeMs: gcConfig.undoHorizonMaxAgeMs,
      maxOpsPerReplica: gcConfig.undoHorizonMaxOpsPerReplica,
      budgetMs: gcConfig.gcFixpointBudgetMs,
      clock: () => Date.now(),
    });

    coordinator.lastGcCollectedCount = result.collectedCount;
    coordinator.lastGcSuccessAt = new Date();
    if (result.incomplete) {
      coordinator.gcCycleIncompleteCount += 1;
    }

    const stats = coordinator.engine.stats();
    logger.info("gc.cycle", {
      documentId: coordinator.documentId,
      frontier: frontier.toString(),
      collectedCount: result.collectedCount,
      incomplete: result.incomplete,
      totalElements: stats.totalElements,
      tombstones: stats.tombstones,
      tombstoneRatio: stats.totalElements === 0 ? 0 : stats.tombstones / stats.totalElements,
    });
    if (result.incomplete) {
      // Observable, not silent (Scope-IN's own principle, restated for this specific case): a
      // document that keeps hitting the budget cap every cycle without making progress is
      // itself worth knowing about, separate from "GC hasn't succeeded in N minutes" (this
      // cycle DID succeed — it just didn't finish the whole sweep).
      logger.warn("gc.cycleIncomplete", {
        documentId: coordinator.documentId,
        collectedCount: result.collectedCount,
        cumulativeIncompleteCount: coordinator.gcCycleIncompleteCount,
      });
    }
  } catch (err) {
    // Deliberately NOT rethrown, and deliberately does NOT touch `lastGcSuccessAt` — a
    // document's own GC failure must never stop the rest of this tick's sweep (same
    // reasoning as auditScheduler.ts), and per Scope-IN's own framing ("GC's failure mode
    // is silent, so liveness is monitored, not errors"), the intended way to NOTICE this is
    // `gc.minutes_since_last_success` climbing, not a thrown exception anywhere visible.
    logger.error("gc.documentFailed", {
      documentId: coordinator.documentId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
