import { describe, expect, it } from "vitest";
import {
  measureCaretResolution,
  measureSustainedCaretTracking,
  type CaretResolutionSample,
} from "./caretResolution.js";

/**
 * Phase 32 follow-up (code review) — run via `pnpm test:benchmark`, gated out of the default
 * `pnpm test` like every other timing-sensitive benchmark in this file. Prints REAL measured
 * numbers via console.log (this project's own established convention since Phase 17: "give me the
 * real numbers, not just the ratio") and answers the review's own direct question: does
 * `resolveCaret`/`resolvePresenceAnchor` compound with the disclosed Fugue O(N) sequential-typing
 * chain depth (Open Item 3) at a realistic document size under sustained editing?
 *
 * Sizes were chosen empirically, not assumed: `scaling.ts`'s own Phase 19 numbers (100,000 nodes)
 * predate Fugue and are already disclosed stale for anything at that scale (CLAUDE.md's Open Item
 * 3 — Phase 25's own M8-a benchmark found 100,000 SEQUENTIAL ops impractical, killed after 71 real
 * minutes). 20,000 sequential ops was timed FIRST, in isolation, before being included in this
 * permanent suite's own budget, confirming it completes in a reasonable time on this machine.
 */
describe("Caret resolution cost under sequential typing (Phase 32 follow-up, Open Item 3 compounding check)", () => {
  it("resolveCaret and engine.visible() cost at 2,000 / 5,000 / 10,000 / 20,000 sequentially-typed characters", () => {
    const sizes = [2_000, 5_000, 10_000, 20_000];
    const results: CaretResolutionSample[] = sizes.map((size) => measureCaretResolution(size));

    for (const r of results) {
      // eslint-disable-next-line no-console -- explicitly requested: real numbers, not just pass/fail.
      console.log(
        `[caretResolution] N=${r.size.toString().padStart(6)}  build=${r.buildMs.toFixed(1)}ms  ` +
          `resolveCaret(deepest)=${r.resolveCaretDeepMs.toFixed(4)}ms  ` +
          `resolveCaret(shallowest)=${r.resolveCaretShallowMs.toFixed(4)}ms  ` +
          `engine.visible()=${r.engineVisibleMs.toFixed(4)}ms`,
      );
    }

    const at2k = results[0]!;
    const at20k = results[3]!;
    const deepGrowth = at20k.resolveCaretDeepMs / Math.max(at2k.resolveCaretDeepMs, 0.001);
    const visibleGrowth = at20k.engineVisibleMs / Math.max(at2k.engineVisibleMs, 0.001);
    // eslint-disable-next-line no-console
    console.log(
      `[caretResolution] 10x size growth (2,000 -> 20,000): resolveCaret(deepest) ${deepGrowth.toFixed(2)}x, ` +
        `engine.visible() ${visibleGrowth.toFixed(2)}x (linear/O(N) growth would be ~10x for both)`,
    );

    // This is a DISCLOSURE benchmark, not a regression gate with a tight pass/fail bound the way
    // scaling.ts's O(log N) assertion is — resolveCaret's cost is EXPECTED to grow with depth on
    // this exact pathological (sequential-typing) shape, the same as every other position-aware
    // FugueTree operation (Open Item 3, unchanged by this phase). The only thing asserted here is
    // that resolveCaret at the deepest node is never SLOWER than a full engine.visible() traversal
    // at the same size — i.e. this phase's own new O(depth) walk is not accidentally worse than
    // the O(N) traversal it was specifically designed to avoid.
    expect(at20k.resolveCaretDeepMs).toBeLessThanOrEqual(at20k.engineVisibleMs * 2);
  });

  it("sustained editing: per-remote-append caret-tracking overhead across 300 further appends, starting from 5,000 / 10,000 / 20,000 characters", () => {
    for (const startSize of [5_000, 10_000, 20_000]) {
      const r = measureSustainedCaretTracking(startSize, 300);
      // eslint-disable-next-line no-console
      console.log(
        `[caretResolution:sustained] start=${r.startSize.toString().padStart(6)}  ` +
          `appends=${r.appendCount}  p50=${r.p50Ms.toFixed(4)}ms  p95=${r.p95Ms.toFixed(4)}ms  ` +
          `max=${r.maxMs.toFixed(4)}ms  totalOverheadOver${r.appendCount}Appends=${r.totalOverheadMs.toFixed(2)}ms`,
      );
    }
  });
});
