import type { MutantMatrixRow } from "./runMatrix.js";

function fuzzCell(col: {
  readonly killed: boolean;
  readonly seed?: number;
  readonly seedsRun: number;
}): string {
  if (col.killed) {
    return `killed (seed ${col.seed}, ${col.seedsRun} trial(s) run)`;
  }
  return `survived (${col.seedsRun} trials)`;
}

function checkCell(col: {
  readonly killed: boolean;
  readonly failingChecks: readonly string[];
}): string {
  if (col.killed) {
    return `killed — ${col.failingChecks.join("; ")}`;
  }
  return "survived";
}

export function generateMatrixReport(
  rows: readonly MutantMatrixRow[],
  generatedAt: string,
  mutKillResult?: { readonly killed: boolean; readonly trials: number; readonly seed?: number },
): string {
  const lines: string[] = [];
  lines.push("# Mutation matrix (Test Plan §2.8)");
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push("");
  lines.push(
    "Ten mutants (patches supplied verbatim from Test Plan §2.8), each string-patched " +
      "into an isolated, freshly-transpiled copy of `packages/engine/src` — never the real " +
      "source on disk — then run against four detection mechanisms: the convergence fuzzer " +
      "with invariant assertions OFF (pure text/structure/pendingCount agreement — what " +
      "existed since Phase 2), the same fuzzer with invariant assertions ON (Phase 4's " +
      "`assertInvariants`, checked after every mutating call), a hand-picked subset of the " +
      "Phase 5 adversarial suite re-targeted at the mutant engine, and a reduced-count " +
      "reimplementation of PROP-1/PROP-2. See `packages/testkit/src/mutation/` for the harness.",
  );
  lines.push("");
  lines.push(
    "| Mutant | Violated invariant | Fuzzer (convergence only) | Fuzzer (+ invariants) | Adversarial (targeted) | Properties (targeted) | Overall |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const row of rows) {
    const overall = row.overallKilled ? "**KILLED**" : "**SURVIVED**";
    lines.push(
      `| \`${row.mutant.id}\` | ${row.mutant.violatedInvariant} | ${fuzzCell(row.fuzzerConvergence)} | ` +
        `${fuzzCell(row.fuzzerInvariants)} | ${checkCell(row.adversarial)} | ${checkCell(row.properties)} | ${overall} |`,
    );
  }
  lines.push("");

  const survivors = rows.filter((r) => !r.overallKilled);
  lines.push("## Mutant descriptions");
  lines.push("");
  for (const row of rows) {
    lines.push(`- **${row.mutant.id}**: ${row.mutant.description}`);
  }
  lines.push("");

  lines.push("## MUT-KILL-01 (Test Plan §14.2)");
  lines.push("");
  if (mutKillResult) {
    if (mutKillResult.killed) {
      lines.push(
        `A directed search constructing partially overlapping origin intervals killed \`M3_no_case_c\` ` +
          `at trial ${mutKillResult.seed} (of a ${mutKillResult.trials.toLocaleString("en-US")}-trial budget).`,
      );
    } else {
      lines.push(
        `A directed search constructing partially overlapping origin intervals ran the full ` +
          `${mutKillResult.trials.toLocaleString("en-US")}-trial budget against \`M3_no_case_c\` without finding a ` +
          "pure convergence divergence. Per the Phase 6 Definition of Done, a test-build Case C assertion in " +
          "`integrate()` was added as the fallback (see engine.ts and the CLAUDE.md Phase 6 entry). Because " +
          "`fuzzUntilKilled` treats ANY thrown exception — including that assertion firing — as a kill, this " +
          "same `killed: false` result also confirms the assertion did NOT fire during any of these trials " +
          "(M3's own patch only removes the Case C `break`; the assertion's code and the `compareRank` it calls " +
          "are untouched by M3's mutation, so it stays live and would have registered a kill had it fired).",
      );
    }
  } else {
    lines.push("Not run — M3_no_case_c was killed by another suite before MUT-KILL-01 was needed.");
  }
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(
    `- ${rows.length - survivors.length} of ${rows.length} mutants killed by at least one suite.`,
  );
  if (survivors.length > 0) {
    lines.push(
      `- Survives every suite here: ${survivors.map((r) => `\`${r.mutant.id}\``).join(", ")}.`,
    );
  } else {
    lines.push("- No mutant survives every suite in this matrix.");
  }
  lines.push("");

  return lines.join("\n");
}
