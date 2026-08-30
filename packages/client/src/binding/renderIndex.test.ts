import { describe, expect, it } from "vitest";
import { findRunForVis, totalVisibleLength, type RenderRun } from "./renderIndex.js";

// findRunForVis/totalVisibleLength only ever read `startVis`/`scalarLen` — a fake, DOM-free
// `textNode` is fine here and keeps this file runnable under plain Node, no jsdom needed.
function run(startVis: number, scalarLen: number): RenderRun {
  return { textNode: {} as Text, startVis, scalarLen, utf16Len: scalarLen };
}

describe("totalVisibleLength", () => {
  it("is 0 for an empty index", () => {
    expect(totalVisibleLength([])).toBe(0);
  });

  it("is the last run's startVis + scalarLen", () => {
    const index = [run(0, 5), run(5, 3), run(8, 10)];
    expect(totalVisibleLength(index)).toBe(18);
  });
});

describe("findRunForVis — binary search over renderIndex", () => {
  const index = [run(0, 5), run(5, 3), run(8, 10)]; // total length 18

  it("returns null for an empty index", () => {
    expect(findRunForVis([], 0)).toBeNull();
  });

  it("finds the run containing an interior position", () => {
    expect(findRunForVis(index, 0)?.runIndex).toBe(0);
    expect(findRunForVis(index, 4)?.runIndex).toBe(0);
    expect(findRunForVis(index, 6)?.runIndex).toBe(1);
    expect(findRunForVis(index, 8)?.runIndex).toBe(2); // exact boundary — prefers the LATER run
    expect(findRunForVis(index, 17)?.runIndex).toBe(2);
  });

  it("at the very end of the document, resolves to the end of the LAST run (no later run to prefer)", () => {
    const found = findRunForVis(index, 18);
    expect(found?.runIndex).toBe(2);
    expect(found?.run.startVis).toBe(8);
  });

  it("returns null for a position beyond the whole index", () => {
    expect(findRunForVis(index, 19)).toBeNull();
  });

  it("works correctly for a single-run index", () => {
    const single = [run(0, 5)];
    expect(findRunForVis(single, 0)?.runIndex).toBe(0);
    expect(findRunForVis(single, 5)?.runIndex).toBe(0);
  });
});
