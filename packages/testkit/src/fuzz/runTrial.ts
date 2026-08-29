import { fisherYatesShuffle, mulberry32, randInt } from "./prng.js";
import type { ReplicaAdapter, ReplicaFactory } from "./adapter.js";
import type { TrialConfig } from "./configs.js";

export interface ConvergedOutcome {
  readonly status: "converged";
  readonly seed: number;
  readonly replicaCount: number;
}

export interface DivergedOutcome {
  readonly status: "diverged";
  readonly seed: number;
  readonly texts: readonly string[];
}

export interface StuckPendingOutcome {
  readonly status: "stuck-pending";
  readonly seed: number;
  readonly pendingCounts: readonly number[];
}

export interface ErroredOutcome {
  readonly status: "errored";
  readonly seed: number;
  readonly error: unknown;
}

export type TrialOutcome =
  ConvergedOutcome | DivergedOutcome | StuckPendingOutcome | ErroredOutcome;

interface Delivery<Op> {
  readonly op: Op;
  readonly targetReplica: number;
}

/**
 * Positions are drawn from a hot region, not uniformly (Test Plan §2.2):
 * width 1 always returns 0 ("every edit at the same position"); width w
 * draws uniformly from the first min(w, maxIndex+1) valid positions.
 * `maxIndex` is the largest valid position for the caller's purpose —
 * `currentLength` for an insert, `currentLength - 1` for a delete.
 */
function hotRegionIndex(rand: () => number, maxIndex: number, width: number): number {
  const span = Math.max(1, Math.min(width, maxIndex + 1));
  return randInt(rand, 0, span - 1);
}

/**
 * Runs one randomized interleaving trial (Test Plan §2.2). Deterministic
 * from `seed` alone: re-running the same (seed, config, factory) always
 * reproduces the exact same delivery sequence, which is what makes a
 * failure a usable regression-corpus entry (Test Plan §2.3) rather than a
 * one-off flake.
 *
 * The harness enforces NO causal ordering whatsoever — an operation from
 * round 12 may be delivered before one from round 1. Causal readiness is
 * the replica's problem (Engine Spec §4.2), never the harness's.
 */
export function runTrial<Op>(
  seed: number,
  config: TrialConfig,
  factory: ReplicaFactory<Op>,
): TrialOutcome {
  const rand = mulberry32(seed);
  const replicaCount = randInt(rand, config.minReplicas, config.maxReplicas);
  const replicas: ReplicaAdapter<Op>[] = Array.from({ length: replicaCount }, (_, i) =>
    factory(i + 1),
  );

  if (config.clockSkew) {
    for (const replica of replicas) {
      replica.preSkewClock?.(randInt(rand, -100_000, 100_000));
    }
  }

  const deliveries: Delivery<Op>[] = [];

  try {
    for (let round = 0; round < config.rounds; round++) {
      for (let i = 0; i < replicas.length; i++) {
        const replica = replicas[i];
        if (!replica) continue;

        const opCount = randInt(rand, config.opsPerRoundMin, config.opsPerRoundMax);
        for (let k = 0; k < opCount; k++) {
          const currentLength = replica.text().length;
          const wantsInsert = rand() < config.insertWeight;

          if (wantsInsert || currentLength === 0) {
            const visibleIndex = hotRegionIndex(rand, currentLength, config.hotRegionWidth);
            const value = 0x61 + randInt(rand, 0, 25); // 'a'..'z' — readable in failure diagnostics
            const op = replica.localInsert(visibleIndex, value);
            for (let j = 0; j < replicas.length; j++) {
              if (j !== i) deliveries.push({ op, targetReplica: j });
            }
          } else {
            const visibleIndex = hotRegionIndex(rand, currentLength - 1, config.hotRegionWidth);
            const ops = replica.localDelete(visibleIndex, 1);
            for (const op of ops) {
              for (let j = 0; j < replicas.length; j++) {
                if (j !== i) deliveries.push({ op, targetReplica: j });
              }
            }
          }
        }
      }
    }

    // Duplicate injection (Test Plan §2.2): duplicate delivery is a
    // consequence of correct retry behaviour, not a network defect
    // (API Spec §9.3), and must be exercised above production rates.
    const withDuplicates = [...deliveries];
    for (const delivery of deliveries) {
      if (rand() < config.duplicateRate) {
        withDuplicates.push(delivery);
      }
    }

    // Global shuffle across ALL rounds and ALL replicas' deliveries at once.
    fisherYatesShuffle(withDuplicates, rand);

    for (const delivery of withDuplicates) {
      replicas[delivery.targetReplica]?.applyRemote(delivery.op);
    }
  } catch (error) {
    return { status: "errored", seed, error };
  }

  // Assertion (2), asserted SEPARATELY from text equality below: a
  // replica that silently dropped an operation instead of buffering it
  // can still produce matching text if the drop was a duplicate. Test
  // Plan §2.8 confirmed this empirically — mutant M10_no_drain is caught
  // by this assertion and by nothing else.
  const pendingCounts = replicas.map((r) => r.pendingCount());
  if (pendingCounts.some((p) => p !== 0)) {
    return { status: "stuck-pending", seed, pendingCounts };
  }

  // Assertions (1) and (3): text AND structure length must agree across
  // every replica. Structure-length equality catches a class of bug text
  // equality alone would miss (e.g. two replicas holding a different
  // number of tombstones for content that happens to render the same).
  const texts = replicas.map((r) => r.text());
  const structureLengths = replicas.map((r) => r.structureLength());
  const firstText = texts[0];
  const firstStructureLength = structureLengths[0];
  const textsMatch = texts.every((t) => t === firstText);
  const structuresMatch = structureLengths.every((n) => n === firstStructureLength);

  if (!textsMatch || !structuresMatch) {
    return { status: "diverged", seed, texts };
  }

  return { status: "converged", seed, replicaCount };
}

export interface FuzzSuiteSummary {
  readonly total: number;
  readonly converged: number;
  readonly diverged: readonly DivergedOutcome[];
  readonly stuckPending: readonly StuckPendingOutcome[];
  readonly errored: readonly ErroredOutcome[];
}

/** Runs `seedCount` trials of `config` against `factory`, starting at `startSeed`. */
export function runFuzzSuite<Op>(
  config: TrialConfig,
  factory: ReplicaFactory<Op>,
  seedCount: number,
  startSeed = 0,
): FuzzSuiteSummary {
  let converged = 0;
  const diverged: DivergedOutcome[] = [];
  const stuckPending: StuckPendingOutcome[] = [];
  const errored: ErroredOutcome[] = [];

  for (let i = 0; i < seedCount; i++) {
    const outcome = runTrial(startSeed + i, config, factory);
    switch (outcome.status) {
      case "converged":
        converged += 1;
        break;
      case "diverged":
        diverged.push(outcome);
        break;
      case "stuck-pending":
        stuckPending.push(outcome);
        break;
      case "errored":
        errored.push(outcome);
        break;
    }
  }

  return { total: seedCount, converged, diverged, stuckPending, errored };
}
