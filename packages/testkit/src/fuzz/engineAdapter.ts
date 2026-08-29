import { Engine } from "@collab-editor/engine";
import type { ReplicaAdapter, ReplicaFactory } from "./adapter.js";

/**
 * Thrown by every mutating method of the real-engine adapter until Phase 3
 * implements integrate()/applyRemote() (Engine Spec §4.3). This is the
 * mechanism behind this phase's Definition of Done: the convergence suite
 * must fail or error right now, FOR THIS REASON specifically — no
 * apply/integrate method exists — rather than because of a harness bug.
 */
export class NotImplementedError extends Error {}

/**
 * No operation type exists yet (Phase 1's `Operation` is a placeholder,
 * and Phase 3 defines the real Insert/Delete/Undelete union). `never` is
 * the honest type here: no value of it can actually be produced, because
 * every producer below throws.
 */
type EngineOp = never;

/**
 * Wraps the real OBSEQ engine (Phase 1) for the convergence harness.
 * text() / structureLength() / pendingCount() call genuinely-implemented
 * Phase 1 code — proving the real Engine is actually wired in, not just
 * imported for show. localInsert / localDelete / applyRemote throw,
 * because integrate() does not exist yet.
 */
export function createEngineAdapter(): ReplicaFactory<EngineOp> {
  return (replicaId: number): ReplicaAdapter<EngineOp> => {
    const engine = new Engine(replicaId);

    const notImplemented = (method: string): never => {
      throw new NotImplementedError(
        `Engine.${method}() is not implemented yet — integrate() and applyRemote() ` +
          "land in Phase 3 (Engine Spec §4.3). This failure is correct and expected " +
          "for the convergence suite before Phase 3 merges.",
      );
    };

    return {
      replicaId,
      localInsert: () => notImplemented("localInsert"),
      localDelete: () => notImplemented("localDelete"),
      applyRemote: () => notImplemented("applyRemote"),
      text: () => engine.text(),
      structureLength: () => engine.stats().totalElements,
      pendingCount: () => engine.pending.length,
    };
  };
}
