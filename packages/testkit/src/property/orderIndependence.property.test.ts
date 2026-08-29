import { describe, it } from "vitest";
import fc from "fast-check";
import { buildEngine, generateOpStream, mulberry32, randomLinearization } from "./support.js";

/**
 * PROP-3 — order independence (Test Plan §2.5, Engine Spec §6). Two
 * independent causality-respecting linearizations of the SAME set of
 * operations must converge to the same document. The operation set comes
 * from two mutually-independent replicas' local histories (each an
 * internally-chained sequence, but never referencing the other), so the
 * combined dependency graph has real concurrency — a single linear chain
 * would only ever admit one valid order, which would make this test
 * vacuous.
 */
describe("PROP-3 — order independence of causally-valid linearizations", () => {
  it("two different valid linearizations of the same operation set converge", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (streamSeed, countA, countB, linSeed1, linSeed2) => {
          const streamRand = mulberry32(streamSeed);
          const ops = [
            ...generateOpStream(streamRand, 101, countA),
            ...generateOpStream(streamRand, 202, countB),
          ];

          const linearization1 = randomLinearization(ops, mulberry32(linSeed1));
          const linearization2 = randomLinearization(ops, mulberry32(linSeed2));

          const engine1 = buildEngine(1, linearization1);
          const engine2 = buildEngine(2, linearization2);

          return (
            engine1.text() === engine2.text() &&
            engine1.stats().totalElements === engine2.stats().totalElements &&
            engine1.pending.length === 0 &&
            engine2.pending.length === 0
          );
        },
      ),
      { numRuns: 10_000 },
    );
  });
});
