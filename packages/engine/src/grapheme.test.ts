import { describe, expect, it } from "vitest";
import { isClusterContinuing } from "./grapheme.js";

describe("isClusterContinuing — API Spec §7.4.4 / Engine Spec Definition 2.5, Invariant I8", () => {
  it("combining acute (U+0301) continues a cluster", () => {
    expect(isClusterContinuing(0x0301)).toBe(true);
  });

  it("zero-width joiner (U+200D) continues a cluster", () => {
    expect(isClusterContinuing(0x200d)).toBe(true);
  });

  it("variation selector (U+FE0F) continues a cluster", () => {
    expect(isClusterContinuing(0xfe0f)).toBe(true);
  });

  it("regional indicator symbol letter F (U+1F1EB, half of a flag pair) continues a cluster", () => {
    expect(isClusterContinuing(0x1f1eb)).toBe(true);
  });

  it("Devanagari vowel sign I (U+093F, a spacing combining mark) continues a cluster", () => {
    expect(isClusterContinuing(0x093f)).toBe(true);
  });

  it.each([
    ["'a' (U+0061)", 0x0061],
    ["space (U+0020)", 0x0020],
    ["digit '1' (U+0031)", 0x0031],
    ["grinning face emoji base (U+1F600)", 0x1f600],
  ])("ordinary character %s does NOT continue a cluster", (_label, cp) => {
    expect(isClusterContinuing(cp)).toBe(false);
  });
});
