import { Engine, assertInvariants } from "@collab-editor/engine";
import type { Operation } from "@collab-editor/engine";
import type { ReplicaAdapter, ReplicaFactory } from "./adapter.js";

/**
 * Wraps the real OBSEQ engine for the convergence harness. Every mutating
 * method re-checks all ten Engine Spec §5 invariants (I0–I9) immediately
 * after the call via assertInvariants() (Test Plan §2.6) — not just once
 * at the end of a trial — because I2/I3/I7 are "never changes"/"never
 * regresses" claims that need a history of prior calls to mean anything.
 * `pendingCount()` is the one call that additionally checks I9: it is
 * called by runTrial.ts exactly once, right after all deliveries for a
 * trial complete, which is the only point at which a nonempty pending
 * buffer is actually a violation rather than normal mid-trial buffering
 * (Engine Spec §4.2).
 */
export function createEngineAdapter(): ReplicaFactory<Operation> {
  return (replicaId: number): ReplicaAdapter<Operation> => {
    const engine = new Engine(replicaId);

    return {
      replicaId,
      localInsert: (visibleIndex, value) => {
        const op = engine.localInsert(visibleIndex, value);
        assertInvariants(engine);
        return op;
      },
      localDelete: (visibleIndex, count) => {
        const ops = engine.localDelete(visibleIndex, count);
        assertInvariants(engine);
        return ops;
      },
      applyRemote: (op) => {
        const result = engine.applyRemote(op);
        assertInvariants(engine);
        return result;
      },
      text: () => engine.text(),
      structureLength: () => engine.stats().totalElements,
      pendingCount: () => {
        assertInvariants(engine, { quiescent: true });
        return engine.pending.length;
      },
      preSkewClock: (delta) => engine.observe(engine.currentClock + delta),
    };
  };
}
