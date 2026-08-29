import { describe, it } from "vitest";
import fc from "fast-check";
import {
  buildEngine,
  generateOpStream,
  isOrderPreservingSubsequence,
  mulberry32,
  randomLinearization,
} from "./support.js";

/**
 * PROP-4 — partial-knowledge subsequence (Test Plan §2.5, Engine Spec
 * §6). A causally-closed subset of operations produces a document whose
 * VISIBLE content is a subsequence, in identical relative order, of the
 * fully-informed document. A PREFIX of any valid topological order is,
 * by definition, causally closed — every operation's dependencies were
 * already satisfied when it was chosen, so they necessarily appear
 * earlier in the same order — which is what makes `linearization.slice(0,
 * k)` a legitimate "partial knowledge" replica for any k, not just a
 * convenient shortcut.
 */
describe("PROP-4 — a causally-closed subset is an order-preserving subsequence", () => {
  it("any prefix of a valid linearization renders as a subsequence of the full document", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        (streamSeed, countA, countB, linSeed, fraction) => {
          const streamRand = mulberry32(streamSeed);
          const ops = [
            ...generateOpStream(streamRand, 101, countA),
            ...generateOpStream(streamRand, 202, countB),
          ];

          const full = randomLinearization(ops, mulberry32(linSeed));
          const prefixLength = Math.floor(fraction * full.length);
          const partial = full.slice(0, prefixLength);

          const fullEngine = buildEngine(1, full);
          const partialEngine = buildEngine(2, partial);

          return isOrderPreservingSubsequence(partialEngine.visible(), fullEngine.nodes);
        },
      ),
      { numRuns: 10_000 },
    );
  });
});
