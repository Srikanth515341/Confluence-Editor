import { describe, expect, it } from "vitest";
import { compareIds } from "./identifier.js";
import { Engine } from "./engine.js";

describe("Engine — identifier generation (Engine Spec §3.2, Invariant I0)", () => {
  it("mint() produces strictly consecutive counters across 10,000 calls", () => {
    const engine = new Engine(1);
    const counters = Array.from({ length: 10_000 }, () => engine.mint().c);
    expect(counters).toEqual(Array.from({ length: 10_000 }, (_, i) => i + 1));
  });

  it("observe(999) then mint() returns counter 1000, not 1001", () => {
    // This is the exact shape of the Engine Spec §3.4 defect: a routine that
    // both observes and ticks in one step would double-advance here and
    // return 1001. mint() and observe() must stay independent.
    const engine = new Engine(1);
    engine.observe(999);
    expect(engine.currentClock).toBe(999);

    const minted = engine.mint();
    expect(minted.c).toBe(1000);
  });

  it("observe() never mints and never decreases the clock", () => {
    const engine = new Engine(1);
    engine.mint(); // clock -> 1
    engine.observe(0);
    expect(engine.currentClock).toBe(1);

    engine.observe(5);
    expect(engine.currentClock).toBe(5);
  });

  it("two engines with different replicaId minting the same counter produce distinct, comparable identifiers", () => {
    const engineA = new Engine(1);
    const engineB = new Engine(2);

    const idA = engineA.mint();
    const idB = engineB.mint();

    expect(idA.c).toBe(idB.c); // both mint their first identifier: counter 1
    expect(idA.r).not.toBe(idB.r);
    expect(compareIds(idA, idB)).not.toBe(0);
  });
});

describe("Engine — empty state (before Phase 3's integrate() exists)", () => {
  it("reports an empty visible sequence, empty text, and zeroed stats", () => {
    const engine = new Engine(1);
    expect(engine.visible()).toEqual([]);
    expect(engine.text()).toBe("");
    expect(engine.stats()).toEqual({ totalElements: 0, tombstones: 0, visibleLength: 0 });
  });
});
