import { Engine } from "@collab-editor/engine";
import type { Operation } from "@collab-editor/engine";
import type { ReplicaAdapter, ReplicaFactory } from "./adapter.js";

/**
 * Wraps the real OBSEQ engine (Phase 1 shell, Phase 3 integrate()/
 * applyRemote()) for the convergence harness. Every method below calls
 * genuinely-implemented Engine code — this is the oracle the convergence
 * suite (Engine Spec §4.3) is checked against.
 */
export function createEngineAdapter(): ReplicaFactory<Operation> {
  return (replicaId: number): ReplicaAdapter<Operation> => {
    const engine = new Engine(replicaId);

    return {
      replicaId,
      localInsert: (visibleIndex, value) => engine.localInsert(visibleIndex, value),
      localDelete: (visibleIndex, count) => engine.localDelete(visibleIndex, count),
      applyRemote: (op) => engine.applyRemote(op),
      text: () => engine.text(),
      structureLength: () => engine.stats().totalElements,
      pendingCount: () => engine.pending.length,
      preSkewClock: (delta) => engine.observe(engine.currentClock + delta),
    };
  };
}
