// Scheduled AUDIT() runs (Phase 18 Scope-IN: "Scheduled job, configurable
// interval") — runs IN-PROCESS, auditing every currently-open
// coordinator on a fixed interval. This is the ONLY audit entry point
// that can supply `liveText` (AUDIT step 5, comparing against the live
// coordinator's own materialize()) — it has direct in-memory access to
// each coordinator's `engine`, unlike scripts/admin.ts's standalone CLI,
// which only ever talks to Postgres and therefore only ever runs steps
// 1-4 (see that file's own header comment).

import type { Gateway } from "./gateway.js";
import { auditDocument } from "./audit.js";
import { logger } from "./logger.js";

/** RFC §13.2 names 500 ops/30s for snapshotting specifically; the audit's own cadence isn't spec-mandated (API Spec §6.6 describes WHAT to check, not how often to run it unattended) — 5 minutes is a reasonable default for a "continuously running production control" that materializes and replays a potentially large log on every tick, not so frequent it competes for database connections with real traffic, not so rare that a real divergence sits undetected for hours. Configurable (this function's own `intervalMs` parameter) specifically because this is a judgment call, not a spec value, and a future phase or operator may reasonably want it tighter or looser. */
export const DEFAULT_AUDIT_INTERVAL_MS = 5 * 60 * 1000;

export interface AuditScheduler {
  stop(): void;
}

/**
 * Starts a recurring timer that audits every document with an open
 * `DocumentCoordinator` (`gateway.coordinators`) once per tick. A
 * document with NO open coordinator (nobody currently connected) is
 * simply not audited by this scheduler — auditing something nobody has
 * touched recently is lower priority than a document actively being
 * edited, and a document with no live coordinator has no `liveText` to
 * compare against anyway (steps 1-4 would still be meaningful, but
 * scaling this scheduler to sweep every document that has EVER existed,
 * not just currently-open ones, is a real design question left for a
 * future phase, not decided here).
 */
export function startAuditScheduler(
  gateway: Gateway,
  intervalMs: number = DEFAULT_AUDIT_INTERVAL_MS,
): AuditScheduler {
  const timer = setInterval(() => {
    void runAllOpenDocuments(gateway);
  }, intervalMs);
  // Don't keep the Node process alive solely for this timer — tests construct many gateways in
  // a single process and must be able to exit cleanly without every one of them explicitly
  // calling `.stop()`.
  timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}

async function runAllOpenDocuments(gateway: Gateway): Promise<void> {
  for (const coordinator of gateway.coordinators.values()) {
    try {
      await coordinator.ready; // a coordinator can be in the map while still warming up
      await auditDocument(coordinator.documentId, coordinator.operationStore, {
        liveText: coordinator.engine.text(),
      });
    } catch (err) {
      // One document's audit failing (or even its own warm start failing) must never stop the
      // rest of this tick's sweep from running.
      logger.error("auditScheduler.documentFailed", {
        documentId: coordinator.documentId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
