import { describe, expect, it } from "vitest";
import { Engine } from "@collab-editor/engine";

/**
 * Test Plan §7.1, DOM-01's third assertion: "an insert at v lands at
 * exactly v in engine.materialize()". This needs a real Engine instance
 * seeded with the fixture string, using the Phase 3 engine directly — not
 * just testing the mapping functions in isolation (this phase's own DoD
 * text). No DOM at all: this is purely about "visible index" meaning the
 * same thing (a SCALAR count) on both sides — the DOM mapping functions
 * (positionMapping.ts, exercised in e2e/*.spec.ts) and the engine's own
 * `localInsert(visibleIndex, ...)` (Engine Spec, Phase 3).
 *
 * `engine.materialize()` in the Test Plan text refers to the engine's
 * materialized-document concept (Engine Spec Definition 2.4); the actual
 * method on `Engine` is `.text()` (named that way since Phase 1) — same
 * thing, this file just uses the real method name.
 */
const DOM01_FIXTURES: ReadonlyArray<readonly [name: string, text: string]> = [
  ["pure ASCII", "hello world"],
  ["BMP with diacritics", "héllo wörld"],
  ["one astral char", "hello 👋 world"],
  ["ZWJ family emoji", "👨‍👩‍👧‍👦 family"],
  ["regional indicator flags", "🇫🇷🇯🇵 flags"],
  ["Devanagari with matras", "मैं हिन्दी बोलता हूँ"],
  ["Hangul", "한글 조합"],
];

/** A marker scalar guaranteed not to appear in any fixture above, so its landing position is unambiguous. */
const MARKER_CODE_POINT = 0x2603; // ☃ SNOWMAN

function seedEngine(text: string): Engine {
  const engine = new Engine(1);
  const scalars = Array.from(text, (ch) => ch.codePointAt(0)!);
  for (let i = 0; i < scalars.length; i++) {
    engine.localInsert(i, scalars[i]!);
  }
  return engine;
}

describe("DOM-01: an insert at visible index v lands at exactly v in engine.text() (scalar-indexed)", () => {
  for (const [name, text] of DOM01_FIXTURES) {
    it(`holds for every interior position in "${name}"`, () => {
      const scalarLen = Array.from(text).length;
      for (let v = 0; v <= scalarLen; v++) {
        const engine = seedEngine(text);
        engine.localInsert(v, MARKER_CODE_POINT);

        const resultScalars = Array.from(engine.text());
        expect(resultScalars).toHaveLength(scalarLen + 1);
        expect(resultScalars[v]).toBe(String.fromCodePoint(MARKER_CODE_POINT));

        // And the rest of the document is exactly the original fixture, split around the marker —
        // proving this isn't a coincidental match (e.g. two adjacent scalars both equal to the marker).
        const before = resultScalars.slice(0, v).join("");
        const after = resultScalars.slice(v + 1).join("");
        expect(before + after).toBe(text);
      }
    });
  }
});
