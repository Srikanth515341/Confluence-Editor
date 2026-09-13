/**
 * The M7 load sweep runner (Phase 38, Test Plan §4.4 PERF-M7). Builds the 50,000-character
 * baseline document once, then runs each concurrency level in ascending order against the
 * SAME, continuously-growing document (matching how a real long-lived document actually
 * accumulates content — rebuilding a fresh 50,000-character baseline per level would cost
 * Fugue's own disclosed O(N^2) sequential-insertion penalty five times over for no benefit).
 *
 * Run duration is controlled by `LOAD_EDIT_DURATION_MS` specifically so this ONE script
 * serves BOTH the reduced-pass validation run (a short, disclosed duration) AND the full,
 * literal Test Plan §4.4 10-minute-per-level sweep — same code, same output format, only the
 * duration knob differs. See docs/benchmarks.md's own M7 section for exactly which duration
 * produced which published numbers.
 *
 * Usage: `pnpm --filter @collab-editor/testkit run load:sweep` (from the repo root or that
 * package directory). This runs via VITEST, not bare `tsx`/`node` — `@collab-editor/server`
 * transitively imports `jsonwebtoken` (Phase 26 auth), a CommonJS-only package with no named
 * ESM exports; bare Node ESM loading (even through `tsx`) fails on it with `SyntaxError: The
 * requested module 'jsonwebtoken' does not provide an export named 'TokenExpiredError'`,
 * while Vitest's own transform handles the interop correctly — the EXACT same class of
 * failure and fix already documented in CLAUDE.md's Phase 37 account (`realTimeGcDrill.ts`).
 * See `runLoadSweep.script.test.ts` and `vitest.load.config.ts` for the actual entry point.
 *
 * Environment variables (all optional):
 *   LOAD_LEVELS            comma-separated editor counts, default "2,4,8,16,32"
 *   LOAD_EDIT_DURATION_MS  per-level EDITING duration in ms, default 45000 (45s, the
 *                          reduced-pass window — see docs/benchmarks.md for the reasoning).
 *                          Test Plan §4.4's own literal value is 600000 (10 minutes).
 *   LOAD_BASELINE_CHARS    baseline document size, default 50000 (Test Plan §4.4's own value
 *                          — this is WORKLOAD SHAPE, never reduced, per explicit instruction).
 *   LOAD_CHARS_PER_SEC     per-editor typing rate, default 5 (Test Plan §4.4's own value).
 *   LOAD_OUTPUT_JSON       path to write the raw results JSON, default
 *                          "load-sweep-results.json" in the current working directory.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { startLoadHarness, type LoadLevelResult } from "./loadHarness.js";

function parseLevels(): number[] {
  const raw = process.env.LOAD_LEVELS ?? "2,4,8,16,32";
  return raw.split(",").map((s) => Number.parseInt(s.trim(), 10));
}

export async function runLoadSweep(): Promise<void> {
  const levels = parseLevels();
  const editDurationMs = Number.parseInt(process.env.LOAD_EDIT_DURATION_MS ?? "45000", 10);
  const baselineChars = Number.parseInt(process.env.LOAD_BASELINE_CHARS ?? "50000", 10);
  const charsPerSecond = Number.parseInt(process.env.LOAD_CHARS_PER_SEC ?? "5", 10);
  const outputJsonPath = process.env.LOAD_OUTPUT_JSON ?? "load-sweep-results.json";

  console.log(
    `M7 load sweep starting: levels=[${levels.join(",")}], editDurationMs=${editDurationMs}, ` +
      `baselineChars=${baselineChars}, charsPerSecond=${charsPerSecond}`,
  );

  const documentId = randomUUID();
  const harness = await startLoadHarness(documentId);
  await harness.ensureCoordinator();

  console.log(`Building ${baselineChars}-character baseline document via real Engine.localInsert()...`);
  const baselineStartedAtMs = Date.now();
  const { elapsedMs: baselineBuildMs } = harness.buildBaselineDocument(baselineChars);
  console.log(
    `Baseline built: ${baselineBuildMs}ms (wall ${Date.now() - baselineStartedAtMs}ms) for ${baselineChars} characters.`,
  );

  const results: Array<LoadLevelResult & { readonly baselineBuildMs: number }> = [];

  for (const editorCount of levels) {
    const viewerCount = editorCount * 3;
    const totalClients = editorCount + viewerCount;
    console.log(
      `\n--- Level: ${editorCount} editors + ${viewerCount} viewers (${totalClients} total clients) ---`,
    );
    const levelStartedAtMs = Date.now();
    const result = await harness.runLevel({
      editorCount,
      viewerCount,
      durationMs: editDurationMs,
      charsPerSecondPerEditor: charsPerSecond,
    });
    console.log(`Level completed in ${Date.now() - levelStartedAtMs}ms wall time.`);
    console.log(
      `  M4 latency (ms): p50=${result.latencyP50Ms.toFixed(1)} p95=${result.latencyP95Ms.toFixed(1)} ` +
        `p99=${result.latencyP99Ms.toFixed(1)} (n=${result.latencySampleCount})`,
    );
    console.log(
      `  time-to-synced (ms): p50=${result.timeToSyncedP50Ms.toFixed(0)} max=${result.timeToSyncedMaxMs.toFixed(0)}`,
    );
    console.log(
      `  CPU (ms): user=${result.processCpuUserMs.toFixed(0)} system=${result.processCpuSystemMs.toFixed(0)} | ` +
        `heapUsedDelta=${(result.heapUsedDeltaBytes / 1024 / 1024).toFixed(2)}MB`,
    );
    console.log(
      `  document: totalElements=${result.documentTotalElements} tombstones=${result.documentTombstones}`,
    );
    console.log(
      `  ops/s fanout=${result.opsBroadcastPerSecond.toFixed(1)} egress=${(result.egressBytesPerSecond / 1024).toFixed(1)}KB/s`,
    );
    if (result.clockOffsetEstimate) {
      console.log(
        `  clock offset: offsetMs=${result.clockOffsetEstimate.offsetMs.toFixed(2)} ` +
          `residualUncertaintyMs=${result.clockOffsetEstimate.residualUncertaintyMs.toFixed(3)} ` +
          `(< 10ms required: ${result.clockOffsetEstimate.residualUncertaintyMs < 10 ? "PASS" : "FAIL"})`,
      );
    } else {
      console.log("  clock offset: no samples collected (level duration too short for a PING/PONG round trip)");
    }
    results.push({ ...result, baselineBuildMs });
  }

  await harness.close();

  writeFileSync(
    outputJsonPath,
    JSON.stringify({ documentId, baselineChars, editDurationMs, charsPerSecond, results }, null, 2),
  );
  console.log(`\nWrote raw results to ${outputJsonPath}`);
}
