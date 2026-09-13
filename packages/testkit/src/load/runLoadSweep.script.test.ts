import { describe, it } from "vitest";
import { runLoadSweep } from "./runLoadSweep.js";

/**
 * The M7 load sweep's actual entry point — run via Vitest, not bare `tsx`/`node`, per
 * `runLoadSweep.ts`'s own doc comment (the `jsonwebtoken` CJS/ESM interop issue, same class
 * of fix as CLAUDE.md's Phase 37 account). Invoked as `pnpm load:sweep`
 * (`vitest.load.config.ts` includes only this one file). Real duration is controlled
 * entirely by the `LOAD_LEVELS`/`LOAD_EDIT_DURATION_MS`/etc. environment variables described
 * in `runLoadSweep.ts` — this test's own 24-hour timeout is a ceiling, never the intended
 * run length, so the SAME command serves both the reduced-pass validation run and the full,
 * literal Test Plan §4.4 10-minute-per-level sweep.
 */
describe("M7 load sweep (Phase 38, Test Plan §4.4 PERF-M7)", () => {
  it("runs the configured sweep and writes results to disk", async () => {
    await runLoadSweep();
  }, 24 * 60 * 60 * 1000);
});
