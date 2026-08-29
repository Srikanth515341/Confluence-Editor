import { C1_BASELINE, C2_COLLISION } from "../fuzz/configs.js";
import { loadEngine } from "./loadMutantEngine.js";
import { createMutantAdapter } from "./mutantAdapter.js";
import { fuzzUntilKilled, type FuzzKillResult } from "./fuzzUntilKilled.js";
import { MUTANTS, type MutantDefinition } from "./mutants.js";
import { runTargetedChecks } from "./targetedChecks.js";
import { runTargetedProperties } from "./targetedProperties.js";

/**
 * The full mutation matrix (Test Plan §2.8): for each of the ten
 * mutants, run every suite and record what caught it, or that nothing
 * did. Four suites, matching Test Plan §2.8's framing that "the fuzzer"
 * (pure convergence: text/structure/pendingCount agreement) and
 * "invariant assertions" are DISTINCT detection mechanisms with
 * different catching power (see mutantAdapter.ts) — collapsing them
 * into one column would hide that distinction.
 */

const FUZZ_CONFIGS = [C1_BASELINE, C2_COLLISION];
const MAX_SEEDS_PER_CONFIG = 500;
const PROPERTY_SEED = 424_242;
const PROPERTY_TRIALS = 300;

export interface FuzzColumnResult extends FuzzKillResult {
  readonly config?: string;
}

export interface CheckColumnResult {
  readonly killed: boolean;
  readonly failingChecks: readonly string[];
}

export interface MutantMatrixRow {
  readonly mutant: MutantDefinition;
  readonly fuzzerConvergence: FuzzColumnResult;
  readonly fuzzerInvariants: FuzzColumnResult;
  readonly adversarial: CheckColumnResult;
  readonly properties: CheckColumnResult;
  readonly overallKilled: boolean;
}

async function runFuzzAcrossConfigs(
  mutant: MutantDefinition | null,
  withInvariants: boolean,
): Promise<FuzzColumnResult> {
  let seedsRunTotal = 0;
  for (const config of FUZZ_CONFIGS) {
    const mod = await loadEngine(mutant);
    try {
      const factory = createMutantAdapter(mod, withInvariants);
      const result = fuzzUntilKilled(config, factory, MAX_SEEDS_PER_CONFIG);
      seedsRunTotal += result.seedsRun;
      if (result.killed) {
        return { ...result, seedsRun: seedsRunTotal, config: config.name };
      }
    } finally {
      mod.dispose();
    }
  }
  return {
    killed: false,
    seedsRun: seedsRunTotal,
    config: FUZZ_CONFIGS.map((c) => c.name).join(", "),
  };
}

export async function runMutant(
  mutant: MutantDefinition | null,
): Promise<Omit<MutantMatrixRow, "mutant">> {
  const fuzzerConvergence = await runFuzzAcrossConfigs(mutant, false);
  const fuzzerInvariants = await runFuzzAcrossConfigs(mutant, true);

  const mod = await loadEngine(mutant);
  let adversarial: CheckColumnResult;
  let properties: CheckColumnResult;
  try {
    const advResults = runTargetedChecks(mod);
    const failingAdv = advResults.filter((r) => !r.passed).map((r) => r.name);
    adversarial = { killed: failingAdv.length > 0, failingChecks: failingAdv };

    const propResults = runTargetedProperties(mod, PROPERTY_SEED, PROPERTY_TRIALS);
    const failingProp = propResults.filter((r) => !r.passed).map((r) => r.name);
    properties = { killed: failingProp.length > 0, failingChecks: failingProp };
  } finally {
    mod.dispose();
  }

  const overallKilled =
    fuzzerConvergence.killed || fuzzerInvariants.killed || adversarial.killed || properties.killed;
  return { fuzzerConvergence, fuzzerInvariants, adversarial, properties, overallKilled };
}

export async function runMutationMatrix(
  onRowComplete?: (row: MutantMatrixRow) => void,
): Promise<MutantMatrixRow[]> {
  const rows: MutantMatrixRow[] = [];
  for (const mutant of MUTANTS) {
    const result = await runMutant(mutant);
    const row: MutantMatrixRow = { mutant, ...result };
    rows.push(row);
    onRowComplete?.(row);
  }
  return rows;
}
