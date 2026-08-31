// MAYBE-SNAPSHOT() (RFC §13.2, API Spec §6.4): "500 operations or 30
// seconds, whichever comes first." Checked reactively after every
// committed operation batch (writePath.ts calls `maybeScheduleSnapshot`
// as its own last step) — not via an independent recurring timer, since
// there is nothing NEW to snapshot during a genuinely idle period where
// no operations have landed since the last one.
//
// The actual snapshot WORK (materialize() is O(N), Scope-IN's own
// warning: "must never sit between a keystroke and its broadcast") is
// deliberately deferred via `setImmediate` — scheduling happens
// synchronously (cheap: two field reads, one comparison), but nothing
// CPU- or I/O-heavy runs until the current synchronous turn (and this
// operation's own broadcast+ack, both already sent by the time this is
// called) has fully yielded back to the event loop. `writePath.ts` never
// awaits this — a snapshot write must not delay processIncomingOperation
// returning, which is what would delay this connection's NEXT queued
// message from being processed.

import { encodeStructureSnapshotBody } from "@collab-editor/protocol";
import type { DocumentCoordinator } from "./documentCoordinator.js";
import { logger } from "./logger.js";

/** RFC §13.2's own numbers — not casually configurable via env; a future phase that needs different cadence should change these deliberately, not accidentally via misconfiguration. */
export const SNAPSHOT_OP_THRESHOLD = 500;
export const SNAPSHOT_TIME_THRESHOLD_MS = 30_000;

/**
 * Checked once per committed operation batch. `opsJustCommitted` is
 * added to `coordinator.opsSinceSnap` synchronously here (so the count
 * is always accurate even if the actual write is still deferred/pending
 * from a prior call); the threshold check and `snapshotInFlight` guard
 * are also synchronous, so calling this twice in the same synchronous
 * turn (impossible in practice — writePath.ts calls it once per message,
 * and messages are handled one at a time per Node's event loop, per
 * writePath.ts's own concurrency comment) still could never schedule two
 * overlapping snapshot writes for one coordinator.
 */
export function maybeScheduleSnapshot(
  coordinator: DocumentCoordinator,
  opsJustCommitted: number,
): void {
  coordinator.opsSinceSnap += opsJustCommitted;
  const elapsedMs = Date.now() - coordinator.lastSnapAt.getTime();
  const due =
    coordinator.opsSinceSnap >= coordinator.snapshotOpThreshold ||
    elapsedMs >= coordinator.snapshotTimeThresholdMs;
  if (!due || coordinator.snapshotInFlight) {
    return;
  }
  coordinator.snapshotInFlight = true;
  setImmediate(() => {
    void writeSnapshotNow(coordinator).finally(() => {
      coordinator.snapshotInFlight = false;
    });
  });
}

/**
 * Reads `coordinator.engine`/`currentSeq`/`opsSinceSnap` AT EXECUTION
 * TIME, not at the moment `maybeScheduleSnapshot` scheduled this —
 * `setImmediate`'s deferral means more operations can land (and commit)
 * in between; reading current values here means the snapshot reflects
 * whatever the latest state actually is, never a stale capture, and
 * `opCount` always matches exactly what's being reset to zero below.
 */
async function writeSnapshotNow(coordinator: DocumentCoordinator): Promise<void> {
  const seq = coordinator.currentSeq;
  const opCount = coordinator.opsSinceSnap;
  const content = coordinator.engine.text();
  const structure = encodeStructureSnapshotBody(coordinator.engine.nodes);
  try {
    await coordinator.operationStore.writeSnapshot({
      documentId: coordinator.documentId,
      seq,
      content,
      structure,
      opCount,
    });
    // Reset only on success — a failed write leaves opsSinceSnap/lastSnapAt untouched, so the
    // very next committed operation's own maybeScheduleSnapshot call naturally re-triggers
    // (the threshold condition is still met), a simple retry-on-next-op without dedicated retry
    // logic.
    coordinator.opsSinceSnap = 0;
    coordinator.lastSnapAt = new Date();
  } catch (err) {
    logger.error("snapshotter.writeFailed", {
      documentId: coordinator.documentId,
      seq: seq.toString(),
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
