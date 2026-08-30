import { describe, expect, it } from "vitest";
import {
  clusterAfter,
  clusterBefore,
  lineStartBefore,
  wordAfter,
  wordBefore,
} from "./graphemeSegmentation.js";

// Test Plan §7.1 GRA-02's own fixture set (shared in spirit with DOM01_FIXTURES,
// e2e/fixtures.ts) — combining marks, ZWJ emoji, regional indicators, Devanagari.
const GRA02_FIXTURES: ReadonlyArray<readonly [name: string, text: string]> = [
  ["combining acute accent", "café"], // "café" via base 'e' + combining acute (5 scalars)
  ["ZWJ family emoji", "a👨‍👩‍👧‍👦"], // family emoji is 7 scalars: 👨 ZWJ 👩 ZWJ 👧 ZWJ 👦, at the very end
  ["regional indicator flag", "a🇫🇷"], // flag is 2 scalars (two regional indicators), at the very end
  ["Devanagari with matra", "अमैं"], // trailing "मैं" = म + ै (matra) + ं (anusvara), a multi-scalar cluster
];

describe("clusterBefore / clusterAfter — GRA-02 (Test Plan §7.1)", () => {
  for (const [name, text] of GRA02_FIXTURES) {
    it(`${name}: clusterBefore(end) removes the WHOLE trailing cluster, not one code point`, () => {
      const span = clusterBefore(text, text.length);
      expect(span).not.toBeNull();
      // The cluster consumes strictly more than the last UTF-16 code unit whenever the trailing
      // cluster genuinely spans multiple scalars/code units — GRA-02's entire point.
      expect(span!.utf16End).toBe(text.length);
      expect(span!.utf16Start).toBeLessThan(text.length - 1);
      expect(text.slice(span!.utf16Start, span!.utf16End)).toBe(span!.text);
    });
  }

  it("family ZWJ emoji: backspace removes all 7 scalars in one delete (this phase's DoD fixture)", () => {
    const family = "👨‍👩‍👧‍👦";
    const text = `x${family}`;
    const span = clusterBefore(text, text.length);
    expect(span).not.toBeNull();
    expect(span!.utf16Start).toBe(1); // right after the leading 'x'
    expect(Array.from(span!.text).length).toBe(7); // 👨 ZWJ 👩 ZWJ 👧 ZWJ 👦 — 7 Unicode scalar values
  });

  it("clusterBefore at offset 0 returns null (nothing precedes the start)", () => {
    expect(clusterBefore("abc", 0)).toBeNull();
  });

  it("clusterAfter at the end of the text returns null", () => {
    expect(clusterAfter("abc", 3)).toBeNull();
  });

  it("clusterAfter mirrors clusterBefore for a leading cluster", () => {
    const family = "👨‍👩‍👧‍👦";
    const text = `${family}y`;
    const span = clusterAfter(text, 0);
    expect(span).not.toBeNull();
    expect(span!.utf16End).toBe(family.length);
    expect(Array.from(span!.text).length).toBe(7);
  });

  it("plain ASCII: a cluster is exactly one code point either direction", () => {
    expect(clusterBefore("abc", 3)).toEqual({ utf16Start: 2, utf16End: 3, text: "c" });
    expect(clusterAfter("abc", 0)).toEqual({ utf16Start: 0, utf16End: 1, text: "a" });
  });
});

describe("wordBefore / wordAfter — API Spec §7.4.2 (Intl.Segmenter('word'), not a regex)", () => {
  it("deletes back to the start of the immediately preceding word", () => {
    const text = "hello world";
    const span = wordBefore(text, text.length);
    expect(span).not.toBeNull();
    expect(span!.text).toBe("world");
  });

  it("skips trailing whitespace, then deletes the word before it", () => {
    const text = "hello world   ";
    const span = wordBefore(text, text.length);
    expect(span).not.toBeNull();
    expect(span!.text).toBe("world   ");
  });

  it("wordAfter deletes the following word", () => {
    const text = "hello world";
    const span = wordAfter(text, 0);
    expect(span).not.toBeNull();
    expect(span!.text).toBe("hello");
  });

  it("wordBefore/After at the document boundary return null", () => {
    expect(wordBefore("hello", 0)).toBeNull();
    expect(wordAfter("hello", 5)).toBeNull();
  });
});

describe("lineStartBefore — API Spec §7.4.2 (deleteSoftLineBackward/deleteHardLineBackward, this flat-text phase)", () => {
  it("returns 0 when there is no preceding newline", () => {
    expect(lineStartBefore("hello world", 5)).toBe(0);
  });

  it("returns the offset right after the nearest preceding newline", () => {
    const text = "first\nsecond\nthird";
    expect(lineStartBefore(text, text.length)).toBe(13); // right after the second '\n'
  });
});
