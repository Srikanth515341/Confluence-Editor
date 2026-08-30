import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isInsideSurrogatePair, scalarToUtf16, utf16ToScalar } from "./unicodeOffsets.js";

const FIXTURES: ReadonlyArray<readonly [name: string, text: string]> = [
  ["pure ASCII", "hello world"],
  ["BMP with diacritics", "héllo wörld"],
  ["one astral char", "hello 👋 world"],
  ["ZWJ family emoji", "👨‍👩‍👧‍👦 family"],
  ["regional indicator flags", "🇫🇷🇯🇵 flags"],
  ["Devanagari with matras", "मैं हिन्दी बोलता हूँ"],
  ["Hangul", "한글 조합"],
];

describe("scalarToUtf16 / utf16ToScalar — round-trip over every DOM-01 fixture (API Spec §7.2.2)", () => {
  for (const [name, text] of FIXTURES) {
    it(`round-trips every scalar offset in "${name}"`, () => {
      const scalarLen = Array.from(text).length;
      for (let s = 0; s <= scalarLen; s++) {
        const utf16 = scalarToUtf16(text, s);
        expect(utf16ToScalar(text, utf16)).toBe(s);
      }
    });
  }

  it("scalar offset diverges from naive String.length/UTF-16 offset past the astral character — the exact bug this module exists to avoid", () => {
    // "hello 👋 world": scalars are h,e,l,l,o,' ',👋,' ',w,o,r,l,d (13 scalars).
    // 👋 is scalar index 6 but occupies TWO UTF-16 code units, so every scalar index after it is
    // one less than its naive (wrong) UTF-16-as-scalar-count equivalent would suggest.
    const text = "hello 👋 world";
    expect(scalarToUtf16(text, 6)).toBe(6); // 👋 itself starts at UTF-16 index 6 — still aligned
    expect(scalarToUtf16(text, 7)).toBe(8); // the space right after 👋: scalar 7, but UTF-16 index 8
    expect(scalarToUtf16(text, 7)).not.toBe(7); // proves scalar offset !== UTF-16 offset past the emoji
  });

  it("throws (never silently returns a wrong answer) for an offset past the end", () => {
    expect(() => scalarToUtf16("abc", 4)).toThrow(RangeError);
    expect(() => utf16ToScalar("abc", 4)).toThrow(RangeError);
  });

  it("rejects a UTF-16 offset that splits a surrogate pair", () => {
    const text = "👋"; // U+1F44B, a single scalar, two UTF-16 code units
    expect(() => utf16ToScalar(text, 1)).toThrow(RangeError);
    expect(utf16ToScalar(text, 0)).toBe(0);
    expect(utf16ToScalar(text, 2)).toBe(1);
  });

  it("round-trips 5,000 generated (string, scalar offset) pairs (property test)", () => {
    const textAndOffsetArb = fc
      .string()
      .chain((text) => fc.tuple(fc.constant(text), fc.nat({ max: Array.from(text).length })));
    fc.assert(
      fc.property(textAndOffsetArb, ([text, s]) => {
        const utf16 = scalarToUtf16(text, s);
        return utf16ToScalar(text, utf16) === s;
      }),
      { numRuns: 5_000 },
    );
  });
});

describe("isInsideSurrogatePair", () => {
  it("is true only strictly between a surrogate pair's two halves", () => {
    const text = "a👋b"; // 'a', high surrogate, low surrogate, 'b'
    expect(isInsideSurrogatePair(text, 0)).toBe(false); // before 'a'
    expect(isInsideSurrogatePair(text, 1)).toBe(false); // between 'a' and the pair — valid boundary
    expect(isInsideSurrogatePair(text, 2)).toBe(true); // between the two surrogate halves — INVALID
    expect(isInsideSurrogatePair(text, 3)).toBe(false); // between the pair and 'b' — valid boundary
    expect(isInsideSurrogatePair(text, 4)).toBe(false); // after 'b'
  });

  it("is false for an offset at either end of the string", () => {
    expect(isInsideSurrogatePair("👋", 0)).toBe(false);
    expect(isInsideSurrogatePair("👋", 2)).toBe(false);
  });

  it("is false for ordinary BMP text", () => {
    expect(isInsideSurrogatePair("hello", 3)).toBe(false);
  });
});
