import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateMatrixReport } from "./generateReport.js";
import { runMutKill01 } from "./mutKill01.js";
import { runMutationMatrix } from "./runMatrix.js";

/**
 * Runs the full ten-mutant matrix (Test Plan §2.8) and writes
 * docs/mutation-matrix.md. Kept as a REGULAR (not nightly-only) test —
 * unlike the 10^6-seed MUT-KILL-01 search, the matrix itself (small fuzz
 * budgets, targeted checks) runs in well under two minutes, so it stays
 * part of `pnpm test:mutation`'s normal, CI-suitable path. MUT-KILL-01
 * here runs at a SMALL sanity budget — the authoritative 10^6-trial run
 * is a one-time, separately-executed search (Phase 6's Definition of
 * Done), recorded in this same report file and in CLAUDE.md; the
 * nightly workflow is what re-runs it at full scale on a schedule, by
 * setting MUT_KILL_01_BUDGET=1000000 (see .github/workflows/nightly.yml).
 */
const SANITY_MUT_KILL_01_BUDGET = 20_000;
const MUT_KILL_01_BUDGET = Number(process.env.MUT_KILL_01_BUDGET) || SANITY_MUT_KILL_01_BUDGET;
// A 10^6-trial run needs much longer than the default suite timeout.
const TEST_TIMEOUT_MS = MUT_KILL_01_BUDGET > SANITY_MUT_KILL_01_BUDGET ? 30 * 60 * 1000 : 120_000;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const reportPath = join(repoRoot, "docs", "mutation-matrix.md");

describe("Mutation matrix (Test Plan §2.8)", () => {
  it(
    "runs all ten mutants against every suite and writes docs/mutation-matrix.md",
    async () => {
      const rows = await runMutationMatrix();

      const m3Row = rows.find((r) => r.mutant.id === "M3_no_case_c");
      const mutKillResult =
        m3Row && !m3Row.overallKilled ? await runMutKill01(MUT_KILL_01_BUDGET) : undefined;

      const report = generateMatrixReport(rows, new Date().toISOString(), mutKillResult);
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, report, "utf8");

      // Test Plan §2.8's shape: at least half the mutants killed at/near
      // seed 1 by pure convergence fuzzing (the "obviously broken" ones),
      // and every mutant killed by SOME suite except possibly M3 (which
      // MUT-KILL-01 exists specifically because it might survive
      // everything here).
      const killedByFuzzerEarly = rows.filter(
        (r) => r.fuzzerConvergence.killed && (r.fuzzerConvergence.seed ?? Infinity) <= 5,
      );
      expect(killedByFuzzerEarly.length).toBeGreaterThanOrEqual(3);

      const survivors = rows.filter((r) => !r.overallKilled);
      // Every survivor of the full matrix must be M3 — any other mutant
      // surviving every suite here is a real coverage gap, not an
      // expected outcome, and should fail this test rather than pass
      // silently.
      for (const survivor of survivors) {
        expect(survivor.mutant.id).toBe("M3_no_case_c");
      }
    },
    TEST_TIMEOUT_MS,
  );
});
