// @vitest-environment jsdom
//
// DomWriter's mount/insert/delete logic is ordinary DOM tree manipulation
// (Text nodes, childNodes, parentNode) — jsdom implements this reliably.
// It's specifically real Selection/Range QUIRKS (Test Plan §7.1's DOM-01/
// DOM-03) that jsdom can't be trusted for, which is why those live in
// e2e/*.spec.ts against real Chromium/WebKit instead (see that directory's
// own comment). This file never touches Selection/Range.

import { beforeEach, describe, expect, it } from "vitest";
import { RUN_MAX_SCALARS } from "./renderIndex.js";
import { DomWriter } from "./domWriter.js";

let root: HTMLDivElement;
let writer: DomWriter;

beforeEach(() => {
  root = document.createElement("div");
  writer = new DomWriter();
});

describe("DomWriter.mount", () => {
  it("builds one run for text under the 512-scalar cap", () => {
    writer.mount(root, "hello world");
    expect(writer.index).toHaveLength(1);
    expect(writer.materializedText()).toBe("hello world");
    expect(root.textContent).toBe("hello world");
  });

  it("chunks text longer than 512 scalars into multiple runs", () => {
    const text = "a".repeat(1200); // -> 512 + 512 + 176
    writer.mount(root, text);
    expect(writer.index).toHaveLength(3);
    expect(writer.index[0]!.scalarLen).toBe(512);
    expect(writer.index[1]!.scalarLen).toBe(512);
    expect(writer.index[2]!.scalarLen).toBe(176);
    expect(writer.materializedText()).toBe(text);
  });

  it("does not insert a synthetic <br> for an empty document — leaves the real browser's own behavior observable", () => {
    writer.mount(root, "");
    expect(writer.index).toHaveLength(0);
    expect(root.childNodes).toHaveLength(0);
  });

  it("a run boundary splits on SCALAR count, not UTF-16 length, for astral text", () => {
    const text = "👋".repeat(600); // 600 scalars, but 1200 UTF-16 code units
    writer.mount(root, text);
    expect(writer.index[0]!.scalarLen).toBe(512);
    expect(writer.index[0]!.utf16Len).toBe(1024); // 512 * 2 UTF-16 units per astral scalar
    expect(writer.index[1]!.scalarLen).toBe(88);
  });
});

describe("DomWriter.insertText", () => {
  it("inserts within a single run and shifts nothing (only one run exists)", () => {
    writer.mount(root, "hello world");
    writer.insertText(5, ",");
    expect(writer.materializedText()).toBe("hello, world");
  });

  it("shifts subsequent runs' startVis after an insert", () => {
    writer.mount(root, "a".repeat(600)); // 2 runs: 512 + 88
    // Held by REFERENCE, not array index: inserting "XYZ" at 0 grows run0 to 515 scalars,
    // over the 512 cap, so it splits into two runs — the original second run (88 "a"s) ends up
    // at index 2, not index 1, after the split. The object itself is what must shift correctly.
    const secondRun = writer.index[1]!;
    const before = secondRun.startVis;
    writer.insertText(0, "XYZ");
    expect(secondRun.startVis).toBe(before + 3);
    expect(writer.materializedText()).toBe("XYZ" + "a".repeat(600));
  });

  it("splits a run that grows past 512 scalars", () => {
    writer.mount(root, "a".repeat(510));
    expect(writer.index).toHaveLength(1);
    writer.insertText(510, "abcdef"); // 510 + 6 = 516 > 512
    expect(writer.index).toHaveLength(2);
    expect(writer.index[0]!.scalarLen).toBe(512);
    expect(writer.index[1]!.scalarLen).toBe(4);
    expect(writer.materializedText()).toBe("a".repeat(510) + "abcdef");
  });

  it("inserts into an empty document", () => {
    writer.mount(root, "");
    writer.insertText(0, "hello");
    expect(writer.materializedText()).toBe("hello");
    expect(writer.index).toHaveLength(1);
  });

  it("handles an astral character correctly (scalarLen 1, utf16Len 2)", () => {
    writer.mount(root, "ab");
    writer.insertText(1, "👋");
    expect(writer.materializedText()).toBe("a👋b");
    expect(writer.index[0]!.scalarLen).toBe(3);
    expect(writer.index[0]!.utf16Len).toBe(4);
  });

  it("rejects an out-of-range offset", () => {
    writer.mount(root, "abc");
    expect(() => writer.insertText(10, "x")).toThrow(RangeError);
  });
});

describe("DomWriter.deleteRange", () => {
  it("deletes within a single run", () => {
    writer.mount(root, "hello world");
    writer.deleteRange(5, 6); // remove " world"
    expect(writer.materializedText()).toBe("hello");
  });

  it("removes a run entirely once it's emptied, and renumbers later runs", () => {
    writer.mount(root, "a".repeat(600)); // 512 + 88
    writer.deleteRange(512, 88); // delete exactly the second run's content
    expect(writer.index).toHaveLength(1);
    expect(writer.materializedText()).toBe("a".repeat(512));
  });

  it("deletes across a run boundary, spanning two runs", () => {
    writer.mount(root, "a".repeat(600));
    writer.deleteRange(510, 6); // 2 scalars from run 0's tail, 4 from run 1's head
    expect(writer.materializedText()).toBe("a".repeat(594));
    expect(totalScalarLen(writer)).toBe(594);
  });

  it("deleting the whole document leaves an empty index", () => {
    writer.mount(root, "hello");
    writer.deleteRange(0, 5);
    expect(writer.index).toHaveLength(0);
    expect(writer.materializedText()).toBe("");
  });

  it("rejects a range extending past the document", () => {
    writer.mount(root, "abc");
    expect(() => writer.deleteRange(1, 10)).toThrow(RangeError);
  });
});

describe("DomWriter's dev-build assertion (Scope-IN)", () => {
  it("passes silently after every well-formed patch", () => {
    writer.mount(root, "hello");
    expect(() => writer.insertText(5, " world")).not.toThrow();
    expect(() => writer.deleteRange(0, 6)).not.toThrow();
  });

  it("fires when concat(renderIndex text) doesn't match the given oracle text", () => {
    writer.mount(root, "hello");
    expect(() => writer.assertConsistent("goodbye")).toThrow(/consistency assertion failed/);
  });

  it("fires when renderIndex is deliberately corrupted (wrong scalarLen)", () => {
    writer.mount(root, "hello world");
    // Deliberately corrupt the bookkeeping without touching the actual DOM text node —
    // this is exactly the class of bug the assertion exists to catch (Scope-IN's DoD item).
    (writer.index[0] as { scalarLen: number }).scalarLen = 999;
    expect(() => writer.assertConsistent()).toThrow(/scalarLen/);
  });

  it("fires when renderIndex is deliberately corrupted (wrong startVis)", () => {
    writer.mount(root, "a".repeat(600));
    (writer.index[1] as { startVis: number }).startVis = 999;
    expect(() => writer.assertConsistent()).toThrow(/startVis/);
  });

  it("fires when renderIndex is deliberately corrupted (wrong utf16Len)", () => {
    writer.mount(root, "hello");
    (writer.index[0] as { utf16Len: number }).utf16Len = 999;
    expect(() => writer.assertConsistent()).toThrow(/utf16Len/);
  });

  it("does not fire when assertionsEnabled is false, even on real corruption", () => {
    writer.mount(root, "hello");
    writer.assertionsEnabled = false;
    (writer.index[0] as { scalarLen: number }).scalarLen = 999;
    expect(() => writer.assertConsistent()).not.toThrow();
  });
});

function totalScalarLen(w: DomWriter): number {
  return w.index.reduce((sum, r) => sum + r.scalarLen, 0);
}

// Sanity: RUN_MAX_SCALARS is the constant this whole file's chunking-boundary tests assume.
describe("RUN_MAX_SCALARS", () => {
  it("is 512, per Scope-IN", () => {
    expect(RUN_MAX_SCALARS).toBe(512);
  });
});
