import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { generateConcurrentPair, mergeBothOrders, type PairingType } from "./support.js";

/**
 * PROP-5 — clock-skew invariance (Test Plan §2.5, Engine Spec §10.8 C9,
 * PRD FR-CE-2). The converged result of two concurrent operations must
 * not depend on the arbitrary Lamport counter each replica started from —
 * ordering derives entirely from origin anchors and the rank tie-break
 * (Engine Spec Definition 4.2), never from a counter's absolute
 * magnitude. Checked by comparing a skewed run against the same scenario
 * with zero skew, rather than only checking that the skewed run merges
 * with itself — the latter would also pass for an engine that ordered by
 * counter magnitude, as long as it did so consistently.
 */
const PAIRINGS: readonly PairingType[] = ["insIns", "insDel", "delIns", "delDel"];

describe("PROP-5 — clock-skew invariance", () => {
  it("pre-skewing either replica's clock by an arbitrary large delta does not change the converged result", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 8, unit: fc.constantFrom(..."abcdefghij".split("")) }),
        fc.constantFrom(...PAIRINGS),
        fc.nat({ max: 20 }),
        fc.nat({ max: 20 }),
        fc.integer({ min: 0x61, max: 0x7a }),
        fc.integer({ min: 0x61, max: 0x7a }),
        fc.boolean(),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (base, pairing, posA, posB, valueA, valueB, sameOrigin, skewA, skewB) => {
          const unskewed = mergeBothOrders(
            generateConcurrentPair(base, pairing, posA, posB, valueA, valueB, sameOrigin),
          );
          const skewed = mergeBothOrders(
            generateConcurrentPair(
              base,
              pairing,
              posA,
              posB,
              valueA,
              valueB,
              sameOrigin,
              skewA,
              skewB,
            ),
          );

          return (
            skewed.textForward === unskewed.textForward &&
            skewed.structureLengthForward === unskewed.structureLengthForward &&
            skewed.textForward === skewed.textReverse
          );
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

/**
 * The companion source-level check (Test Plan §2.5's "plus a source-level
 * grep assertion," Engine Spec §10.8 C9): packages/engine must never read
 * a wall clock. Deliberately a SECOND, independent implementation of this
 * grep from scripts/check-engine-purity.mjs — same principle as this
 * project's ESLint-rule-plus-grep-script purity enforcement (PRD NG-3):
 * two independently-written checks agreeing is real evidence; one script
 * silently going stale is not caught by re-running the same script.
 */
describe("Engine Spec §10.8 C9 — no wall-clock reads in packages/engine (independent grep)", () => {
  it("contains no Date.now, new Date, performance.now, or getTime", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, dirname, extname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const here = dirname(fileURLToPath(import.meta.url));
    const engineSrc = join(here, "..", "..", "..", "engine", "src");

    const FORBIDDEN: RegExp[] = [
      /\bDate\.now\s*\(/,
      /\bnew Date\s*\(/,
      /\bperformance\.now\s*\(/,
      /\.getTime\s*\(/,
    ];

    function walk(dir: string): string[] {
      let files: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          files = files.concat(walk(full));
        } else if ([".ts", ".tsx"].includes(extname(full))) {
          files.push(full);
        }
      }
      return files;
    }

    const offenders: string[] = [];
    for (const file of walk(engineSrc)) {
      const text = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) {
          offenders.push(`${file}: matches ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
