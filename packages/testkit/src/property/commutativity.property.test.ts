import { describe, it } from "vitest";
import fc from "fast-check";
import { generateConcurrentPair, mergeBothOrders, type PairingType } from "./support.js";

/**
 * PROP-1 — commutativity (Test Plan §2.5, Engine Spec §6.2). Two
 * concurrently-generated operations, applied in either order, must
 * produce identical text AND identical structure length. The generator
 * covers all four operation-type pairings, with "insIns" biased toward
 * both replicas inserting at the identical visible position — the exact
 * case Case A's tie-break (Engine Spec §4.3) exists to resolve.
 */
const PAIRINGS: readonly PairingType[] = ["insIns", "insDel", "delIns", "delDel"];

describe("PROP-1 — commutativity of concurrent operation pairs", () => {
  it("applying {opA, opB} in either order converges to the same text and structure length", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 8, unit: fc.constantFrom(..."abcdefghij".split("")) }),
        fc.constantFrom(...PAIRINGS),
        fc.nat({ max: 20 }),
        fc.nat({ max: 20 }),
        fc.integer({ min: 0x61, max: 0x7a }),
        fc.integer({ min: 0x61, max: 0x7a }),
        fc.oneof(
          { weight: 6, arbitrary: fc.constant(true) },
          { weight: 1, arbitrary: fc.constant(false) },
        ),
        (base, pairing, posA, posB, valueA, valueB, sameOriginRoll) => {
          // "biased toward identical origins": ~86% of insIns cases collapse to the same position.
          const sameOrigin = pairing === "insIns" && sameOriginRoll;
          const pair = generateConcurrentPair(
            base,
            pairing,
            posA,
            posB,
            valueA,
            valueB,
            sameOrigin,
          );
          const outcome = mergeBothOrders(pair);

          return (
            outcome.textForward === outcome.textReverse &&
            outcome.structureLengthForward === outcome.structureLengthReverse
          );
        },
      ),
      { numRuns: 10_000 },
    );
  });
});
