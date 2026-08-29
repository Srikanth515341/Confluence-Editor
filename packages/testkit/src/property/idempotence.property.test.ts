import { describe, it } from "vitest";
import fc from "fast-check";
import { Engine } from "@collab-editor/engine";
import { buildEngine, fullStateDescriptor, generateOpStream, mulberry32 } from "./support.js";

/**
 * PROP-2 — idempotence (Test Plan §2.5, Engine Spec §6.3). Re-delivering
 * an already-applied operation must be a complete no-op. Asserted on FULL
 * state — text, structure length, and every node's deleted flag — not
 * text alone, because a duplicate delete that (incorrectly) tombstoned a
 * second, unrelated node could still leave the rendered text unchanged
 * while corrupting structure (the same class of bug Test Plan §2.8's
 * `pendingCount` separation exists to catch for drains).
 */
describe("PROP-2 — idempotence of re-delivered operations", () => {
  it("delivering every operation twice produces identical full state to delivering it once", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.integer({ min: 1, max: 40 }),
        (seed, opCount) => {
          const ops = generateOpStream(mulberry32(seed), 1, opCount);

          const once = buildEngine(2, ops);

          const twice = new Engine(3);
          for (const op of ops) {
            twice.applyRemote(op);
            twice.applyRemote(op); // the duplicate — must change nothing
          }

          return (
            once.text() === twice.text() &&
            once.stats().totalElements === twice.stats().totalElements &&
            JSON.stringify(fullStateDescriptor(once)) === JSON.stringify(fullStateDescriptor(twice))
          );
        },
      ),
      { numRuns: 10_000 },
    );
  });
});
