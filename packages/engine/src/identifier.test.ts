import { describe, expect, it } from "vitest";
import { compareIds, type Identifier } from "./identifier.js";

/**
 * Seeded PRNG (mulberry32) so a failing case is reproducible from its seed
 * rather than flaking between runs — the same technique the design spike
 * used for the fuzz harness (RFC §2.1), kept local here rather than pulled
 * in as a dependency this early.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomId(rand: () => number): Identifier {
  return { c: Math.floor(rand() * 1000), r: Math.floor(rand() * 10) };
}

describe("compareIds — strict total order (Engine Spec Definition 3.2)", () => {
  it("is irreflexive: compareIds(a, a) === 0 for 1000 generated identifiers", () => {
    const rand = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const a = randomId(rand);
      expect(compareIds(a, a)).toBe(0);
    }
  });

  it("is total and antisymmetric over 1000 generated pairs: sign(a,b) === -sign(b,a)", () => {
    const rand = mulberry32(2);
    for (let i = 0; i < 1000; i++) {
      const a = randomId(rand);
      const b = randomId(rand);
      const ab = compareIds(a, b);
      const ba = compareIds(b, a);
      expect(Math.sign(ab)).toBe(-Math.sign(ba));
    }
  });

  it("is transitive over 1000 generated triples", () => {
    const rand = mulberry32(3);
    for (let i = 0; i < 1000; i++) {
      const a = randomId(rand);
      const b = randomId(rand);
      const c = randomId(rand);
      const ab = compareIds(a, b);
      const bc = compareIds(b, c);
      const ac = compareIds(a, c);
      if (ab <= 0 && bc <= 0) {
        expect(ac).toBeLessThanOrEqual(0);
      }
      if (ab >= 0 && bc >= 0) {
        expect(ac).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("orders by counter first, then by replica id on a counter tie", () => {
    expect(compareIds({ c: 1, r: 5 }, { c: 2, r: 1 })).toBeLessThan(0);
    expect(compareIds({ c: 3, r: 2 }, { c: 3, r: 1 })).toBeGreaterThan(0);
  });
});
