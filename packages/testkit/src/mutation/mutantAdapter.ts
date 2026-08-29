import type { ReplicaAdapter, ReplicaFactory } from "../fuzz/adapter.js";
import type { LoadedEngineModule } from "./loadMutantEngine.js";

/**
 * Wraps a dynamically-loaded (possibly mutated) engine as a
 * ReplicaAdapter, reusing the exact same fuzz harness (runTrial.ts) the
 * real convergence suite uses. `withInvariants` is the key knob for
 * mutation testing specifically: Test Plan §2.8 treats "the convergence
 * fuzzer" (pure text/structure/pendingCount agreement — what existed
 * since Phase 2) and "invariant assertions" (Phase 4's assertInvariants,
 * checked after every mutating call) as two DISTINCT detection
 * mechanisms with different catching power — several mutants (e.g.
 * M5_double_tick) are completely invisible to convergence checking
 * (they never make two replicas disagree) but are caught immediately by
 * an invariant that inspects state convergence checking never looks at
 * (the clock value itself, for M5). Reporting them as one merged
 * "fuzzer" column would hide exactly the distinction Test Plan §2.8 is
 * making.
 */
export function createMutantAdapter(
  mod: LoadedEngineModule,
  withInvariants: boolean,
): ReplicaFactory<unknown> {
  return (replicaId: number): ReplicaAdapter<unknown> => {
    const engine = new mod.Engine(replicaId);
    const check = (quiescent = false): void => {
      if (withInvariants) {
        mod.assertInvariants(engine, { quiescent });
      }
    };

    return {
      replicaId,
      localInsert: (visibleIndex, value) => {
        const op = engine.localInsert(visibleIndex, value);
        check();
        return op;
      },
      localDelete: (visibleIndex, count) => {
        const ops = engine.localDelete(visibleIndex, count);
        check();
        return ops;
      },
      applyRemote: (op) => {
        const result = engine.applyRemote(op);
        check();
        return result;
      },
      text: () => engine.text(),
      structureLength: () => engine.stats().totalElements,
      pendingCount: () => {
        check(true);
        return engine.pending.length;
      },
      preSkewClock: (delta: number) => engine.observe(engine.currentClock + delta),
    };
  };
}
