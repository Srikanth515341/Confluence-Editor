import type { TrialConfig } from "../fuzz/configs.js";
import { fuzzUntilKilled } from "./fuzzUntilKilled.js";
import { loadEngine } from "./loadMutantEngine.js";
import { createMutantAdapter } from "./mutantAdapter.js";
import { MUTANTS } from "./mutants.js";

/**
 * MUT-KILL-01 (Test Plan §14.2): a directed search specifically
 * constructing partially overlapping origin intervals, attempting to
 * kill M3_no_case_c. Case C is reached exactly when a scanned node's
 * origin lies OUTSIDE the current conflict window — i.e. its own window
 * partially overlaps, rather than nests inside or matches, the window
 * being integrated. A config biased toward MANY small, concurrent,
 * variously-anchored inserts per round (high insert weight, a moderate
 * — not minimal — hot-region width so windows overlap without all
 * coinciding) maximizes how often the scan actually reaches a genuine
 * Case C node, which is the only way this mutant's removed `break` can
 * ever matter. Trials are deliberately small (few replicas, few rounds)
 * so 10^6 of them is tractable in minutes, not hours — this search
 * trades trial complexity for trial VOLUME, unlike the six standard
 * fuzz configs.
 */
export const MUT_KILL_01_CONFIG: TrialConfig = {
  name: "MUT-KILL-01-directed",
  minReplicas: 2,
  maxReplicas: 4,
  rounds: 6,
  opsPerRoundMin: 2,
  opsPerRoundMax: 5,
  insertWeight: 0.85,
  hotRegionWidth: 3,
  duplicateRate: 0,
  clockSkew: false,
  // Unchanged from this search's original design (deferred-shuffled, C1-C6's shape) — never
  // re-run as an "immediate delivery" variant. C7_IMMEDIATE_DELIVERY (Phase 20, Engine Spec
  // §6.2 sub-case iii-d correction) is a separate, permanent fuzz config, not a retrofit of
  // this one.
  deliveryMode: "deferred-shuffled",
};

export interface MutKillResult {
  readonly killed: boolean;
  readonly seed?: number;
  readonly reason?: string;
  readonly trials: number;
}

export async function runMutKill01(budget: number): Promise<MutKillResult> {
  const mutant = MUTANTS.find((m) => m.id === "M3_no_case_c");
  if (!mutant) {
    throw new Error("M3_no_case_c not found in MUTANTS — mutants.ts must have changed");
  }
  const mod = await loadEngine(mutant);
  try {
    // No invariant checking here: MUT-KILL-01 is specifically hunting a
    // pure CONVERGENCE divergence (Engine Spec §6.2's proof failing),
    // and skipping the invariant call keeps each trial as fast as
    // possible, which is what makes a 10^6-trial budget tractable.
    const factory = createMutantAdapter(mod, false);
    const result = fuzzUntilKilled(MUT_KILL_01_CONFIG, factory, budget);
    return result.killed
      ? {
          killed: true,
          trials: result.seedsRun,
          ...(result.seed !== undefined ? { seed: result.seed } : {}),
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        }
      : { killed: false, trials: result.seedsRun };
  } finally {
    mod.dispose();
  }
}
