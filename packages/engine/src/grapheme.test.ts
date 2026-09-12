import { describe, expect, it } from "vitest";
import { isClusterContinuing } from "./grapheme.js";

// Phase 35 (GRA-03, Test Plan §7.4): "Eight lines of code that gate Invariant I8; a
// miscategorization is caught by nothing except a test aimed directly at it." The original
// 8-test fixture (Phase 1) below is kept unchanged; this phase adds three things beyond it,
// each catching a DIFFERENT class of miscategorization the original single-example-per-category
// coverage could not:
//   1. Boundary-EXACT tests at every numeric range this classifier hardcodes (variation
//      selectors, their supplement plane, and regional indicators) — a single interior sample
//      (e.g. only U+FE0F) cannot catch an off-by-one at the range's own edge.
//   2. Negative-control NEAR-MISSES — real Unicode characters that a naive reader (or a future
//      editor of this file) could plausibly mistake for a cluster-continuing category, verifying
//      the classifier does NOT over-fire on them.
//   3. An INDEPENDENT cross-check against `Intl.Segmenter` (Node's own ICU-backed Unicode
//      segmentation, a completely different implementation with no shared code or logic with the
//      regex-based classifier under test) — the same "don't let a check share a bug with the code
//      it verifies" discipline this project has used since Phase 4's property suites and Phase
//      33's independent BigInt colour-hash oracle. `Intl.Segmenter` is a plain ECMAScript
//      Intl API (not DOM, not a wall-clock, not network I/O) — using it here as a TEST-ONLY oracle
//      does not violate engine purity (packages/engine's own source imports nothing from it;
//      only this test file, itself scanned by `check-engine-purity.mjs`, calls it, and the
//      forbidden-pattern list has no rule against it).

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

  describe("Phase 35 — boundary-exact range tests (an interior sample cannot catch an off-by-one at the edge)", () => {
    it.each([
      ["variation selector range start (U+FE00)", 0xfe00, true],
      ["variation selector range end (U+FE0F)", 0xfe0f, true],
      ["one BELOW the variation selector range (U+FDFF)", 0xfdff, false],
      ["one ABOVE the variation selector range (U+FE10)", 0xfe10, false],
      ["variation selector SUPPLEMENT range start (U+E0100)", 0xe0100, true],
      ["variation selector SUPPLEMENT range end (U+E01EF)", 0xe01ef, true],
      ["one BELOW the supplement range (U+E00FF)", 0xe00ff, false],
      ["one ABOVE the supplement range (U+E01F0)", 0xe01f0, false],
      ["regional indicator range start, 'A' (U+1F1E6)", 0x1f1e6, true],
      ["regional indicator range end, 'Z' (U+1F1FF)", 0x1f1ff, true],
      ["one BELOW the regional indicator range (U+1F1E5)", 0x1f1e5, false],
      [
        "one ABOVE the regional indicator range, start of Enclosed Ideographic Supplement (U+1F200)",
        0x1f200,
        false,
      ],
    ])("%s -> %s", (_label, cp, expected) => {
      expect(isClusterContinuing(cp)).toBe(expected);
    });
  });

  describe("Phase 35 — broader multi-script fixtures (each Unicode general category this classifier hardcodes, exercised beyond the single Latin/Devanagari example above)", () => {
    it.each([
      ["Arabic fathatan (U+064B, Mn — non-spacing mark)", 0x064b, true],
      ["Hebrew point sheva (U+05B0, Mn — non-spacing mark)", 0x05b0, true],
      ["Thai mai han-akat (U+0E31, Mn — non-spacing mark)", 0x0e31, true],
      ["combining enclosing circle (U+20DD, Me — enclosing mark)", 0x20dd, true],
      ["Bengali vowel sign AA (U+09BE, Mc — spacing combining mark)", 0x09be, true],
    ])("%s continues a cluster", (_label, cp) => {
      expect(isClusterContinuing(cp)).toBe(true);
    });
  });

  describe("Phase 35 — negative-control near-misses (real Unicode characters easily mistaken for a cluster-continuing category)", () => {
    it.each([
      [
        "acute accent (U+00B4, Sk — a spacing SYMBOL, not a combining MARK, despite looking identical to U+0301)",
        0x00b4,
      ],
      ["modifier letter acute accent (U+02CA, Lm — a modifier LETTER, not a mark)", 0x02ca],
      [
        "right single quotation mark / typographic apostrophe (U+2019, Po — ordinary punctuation, not a mark)",
        0x2019,
      ],
      [
        "zero-width SPACE (U+200B, Cf — a format control, NOT Grapheme_Extend, unlike its near-neighbour ZWJ U+200D)",
        0x200b,
      ],
      [
        "Hangul filler (U+3164, Lo — an ordinary letter-category character, sanity control in a non-Latin script)",
        0x3164,
      ],
    ])("%s does NOT continue a cluster", (_label, cp) => {
      expect(isClusterContinuing(cp)).toBe(false);
    });
  });

  describe("Phase 35 — independent cross-check against Intl.Segmenter (a completely separate, ICU-backed implementation)", () => {
    /**
     * For each fixture, `precedingBase` is the SPECIFIC character `isClusterContinuing`'s own
     * real caller (`Engine.localInsert`'s tie-break, Engine Spec §4.4) would actually see this
     * codepoint appended after — for every ordinary case that's an unrelated Latin letter ("e"),
     * but for a REGIONAL INDICATOR it must be a DIFFERENT regional indicator: UAX #29's real
     * pairing rule (GB12/GB13) only merges two regional indicators into one cluster when one
     * DIRECTLY FOLLOWS another — a regional indicator following an unrelated base ("e" + a lone
     * flag half) is genuinely a two-cluster sequence under real Unicode segmentation, even though
     * `isClusterContinuing` itself returns `true` for EVERY regional indicator unconditionally
     * (a deliberate, harmless, context-free over-approximation — `bind` only affects tie-break
     * ORDERING among concurrently-competing siblings at the same anchor, never what text
     * renders, so treating an isolated regional indicator as "possibly continuing a flag" costs
     * nothing when it turns out not to be one). Testing against the REALISTIC preceding
     * character for each category is what makes this cross-check meaningful rather than a
     * false-alarm generator — it mirrors what `Engine.localInsert` is actually asked at the one
     * call site that matters (Test Plan GRA-01's own "regional-indicator flag pair" fixture is
     * exactly "a second regional indicator immediately after a first").
     */
    const fixtures: ReadonlyArray<{
      readonly label: string;
      readonly precedingBase: string;
      readonly codePoint: number;
      readonly expectedContinuing: boolean;
    }> = [
      { label: "combining acute", precedingBase: "e", codePoint: 0x0301, expectedContinuing: true },
      {
        label: "zero-width joiner",
        precedingBase: "\u{1F468}",
        codePoint: 0x200d,
        expectedContinuing: true,
      },
      {
        label: "variation selector-16",
        precedingBase: "❤",
        codePoint: 0xfe0f,
        expectedContinuing: true,
      },
      {
        label: "variation selector-17 (U+E0100, first of the supplementary-plane IVD selectors)",
        precedingBase: "e",
        codePoint: 0xe0100,
        expectedContinuing: true,
      },
      {
        label: "regional indicator (following ANOTHER regional indicator — the real pairing rule)",
        precedingBase: "\u{1F1FA}", // 'U' half of the US flag
        codePoint: 0x1f1f8, // 'S' half
        expectedContinuing: true,
      },
      {
        label: "Devanagari vowel sign I after a consonant",
        precedingBase: "क",
        codePoint: 0x093f,
        expectedContinuing: true,
      },
      {
        label: "Arabic fathatan after a base letter",
        precedingBase: "ب",
        codePoint: 0x064b,
        expectedContinuing: true,
      },
      {
        label: "combining enclosing circle after a base letter",
        precedingBase: "e",
        codePoint: 0x20dd,
        expectedContinuing: true,
      },
      {
        label: "ordinary 'a' after 'e'",
        precedingBase: "e",
        codePoint: 0x0061,
        expectedContinuing: false,
      },
      {
        label: "acute accent SYMBOL (near-miss) after 'e'",
        precedingBase: "e",
        codePoint: 0x00b4,
        expectedContinuing: false,
      },
      {
        label: "zero-width space (near-miss) after 'e'",
        precedingBase: "e",
        codePoint: 0x200b,
        expectedContinuing: false,
      },
      // A LONE regional indicator following an UNRELATED base is deliberately NOT included here
      // — see the dedicated "DISCLOSED, KNOWN gap" test immediately below this block for why a
      // generic cross-check would falsely flag that specific combination.
    ];

    it.each(fixtures)(
      "$label: isClusterContinuing($codePoint) agrees with Intl.Segmenter on '$precedingBase' + the candidate scalar",
      ({ precedingBase, codePoint, expectedContinuing }) => {
        expect(isClusterContinuing(codePoint)).toBe(expectedContinuing);

        const candidate = String.fromCodePoint(codePoint);
        const combined = precedingBase + candidate;
        const segmentCount = Array.from(
          new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(combined),
        ).length;
        // ONE segment means Intl.Segmenter treats the candidate as continuing `precedingBase`'s
        // own cluster; TWO means it starts a fresh one. This must agree with isClusterContinuing's
        // own verdict for every fixture above, or the classifier and the real Unicode-segmentation
        // authority disagree about a case that actually matters.
        expect(segmentCount).toBe(expectedContinuing ? 1 : 2);
      },
    );

    it("DISCLOSED, KNOWN gap: a lone regional indicator following an UNRELATED character does not itself form one cluster under real Unicode segmentation, even though isClusterContinuing(regionalIndicator) is unconditionally true", () => {
      const lone = 0x1f1eb; // regional indicator symbol letter F, on its own
      expect(isClusterContinuing(lone)).toBe(true);
      const combined = "e" + String.fromCodePoint(lone);
      const segmentCount = Array.from(
        new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(combined),
      ).length;
      expect(segmentCount).toBe(2); // Intl.Segmenter correctly reports TWO clusters here
      // The classifier's own `true` in this specific scenario is a deliberate, context-free
      // over-approximation (Engine Spec Definition 2.5 has no notion of "was the PRECEDING
      // character also a regional indicator" — `isClusterContinuing` takes only the ONE candidate
      // codepoint, never its neighbour). This is harmless for correctness: `bind` only affects
      // sibling tie-break ORDER among nodes anchored at the same window (Engine Spec §4.4), never
      // what text is stored or rendered — an isolated regional indicator still renders as itself
      // regardless of `bind`'s value. It only matters when there genuinely IS a preceding
      // regional indicator to continue, which is the fixture immediately above this one.
    });
  });
});
