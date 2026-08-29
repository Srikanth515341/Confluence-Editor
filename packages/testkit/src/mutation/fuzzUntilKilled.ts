import { runTrial } from "../fuzz/runTrial.js";
import type { TrialConfig } from "../fuzz/configs.js";
import type { ReplicaFactory } from "../fuzz/adapter.js";

export interface FuzzKillResult {
  readonly killed: boolean;
  /** Seed that first produced a non-converged outcome, if killed. */
  readonly seed?: number;
  readonly reason?: string;
  readonly seedsRun: number;
}

/**
 * Runs `runTrial` (the SAME trial logic the real convergence suite uses)
 * seed by seed, stopping at the first non-"converged" outcome. For
 * mutation testing this is the only tractable design: running the full
 * 10,000-seed budget for every one of 10 mutants across multiple configs
 * would take hours, and once a mutant is dead, more seeds add no
 * information — Test Plan §2.8's "seeds-to-first-detection" framing
 * already implies exactly this early-exit shape.
 */
export function fuzzUntilKilled(
  config: TrialConfig,
  factory: ReplicaFactory<unknown>,
  maxSeeds: number,
  startSeed = 0,
): FuzzKillResult {
  for (let i = 0; i < maxSeeds; i++) {
    const seed = startSeed + i;
    try {
      const outcome = runTrial(seed, config, factory);
      if (outcome.status !== "converged") {
        const reason =
          outcome.status === "diverged"
            ? `diverged: ${JSON.stringify(outcome.texts)}`
            : outcome.status === "stuck-pending"
              ? `stuck-pending: ${JSON.stringify(outcome.pendingCounts)}`
              : `errored: ${String(outcome.error)}`;
        return { killed: true, seed, reason, seedsRun: i + 1 };
      }
    } catch (error) {
      // runTrial's own try/catch covers generation and delivery, but its
      // pendingCounts read happens AFTER that block (Test Plan §2.8's
      // real convergence suite never throws there, so this was never a
      // problem before mutation testing). An assertInvariants violation
      // thrown from pendingCount() — quiescent check — is exactly the
      // kind of thing mutation testing exists to surface, so it counts
      // as a detection here rather than crashing the whole matrix run.
      return { killed: true, seed, reason: `uncaught: ${String(error)}`, seedsRun: i + 1 };
    }
  }
  return { killed: false, seedsRun: maxSeeds };
}
