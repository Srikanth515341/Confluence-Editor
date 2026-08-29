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

describe("Engine — empty state (Phase 1 baseline)", () => {
  it("reports an empty visible sequence, empty text, and zeroed stats", () => {
    const engine = new Engine(1);
    expect(engine.visible()).toEqual([]);
    expect(engine.text()).toBe("");
    expect(engine.stats()).toEqual({ totalElements: 0, tombstones: 0, visibleLength: 0 });
  });
});

function cp(ch: string): number {
  const c = ch.codePointAt(0);
  if (c === undefined) {
    throw new Error(`empty string passed to cp()`);
  }
  return c;
}

function typeString(engine: Engine, s: string): void {
  for (const ch of s) {
    engine.localInsert(engine.text().length, cp(ch));
  }
}

describe("Engine — origin-bounded integration (Engine Spec §4.3, worked traces §10.1–§10.8)", () => {
  it("§10.1: concurrent inserts at the same position converge to AabB, both orders", () => {
    // Shared base "AB", built once and relayed to both replicas so they start identically.
    const seed = new Engine(1);
    const opA = seed.localInsert(0, cp("A"));
    const opB = seed.localInsert(1, cp("B"));

    const replicaLow = new Engine(10);
    const replicaHigh = new Engine(20);
    for (const op of [opA, opB]) {
      replicaLow.applyRemote(op);
      replicaHigh.applyRemote(op);
    }
    expect(replicaLow.text()).toBe("AB");
    expect(replicaHigh.text()).toBe("AB");

    // Both concurrently insert at visible index 1 (between A and B).
    const opLow = replicaLow.localInsert(1, cp("a"));
    const opHigh = replicaHigh.localInsert(1, cp("b"));

    replicaLow.applyRemote(opHigh);
    replicaHigh.applyRemote(opLow);

    expect(replicaLow.text()).toBe("AabB");
    expect(replicaHigh.text()).toBe("AabB");
    expect(replicaLow.pending).toHaveLength(0);
    expect(replicaHigh.pending).toHaveLength(0);
  });

  it("§10.3: concurrent delete of ELL and insert of x on HELLO converge to HxO", () => {
    const seed = new Engine(1);
    const inserts = [...("HELLO")].map((ch, i) => seed.localInsert(i, cp(ch)));

    const deleter = new Engine(10);
    const inserter = new Engine(20);
    for (const op of inserts) {
      deleter.applyRemote(op);
      inserter.applyRemote(op);
    }
    expect(deleter.text()).toBe("HELLO");
    expect(inserter.text()).toBe("HELLO");

    // Concurrently: deleter removes "ELL" (visible indices 1..3); inserter types
    // 'x' right after H, seeing only the pre-delete "HELLO".
    const deleteOps = deleter.localDelete(1, 3);
    const insertOp = inserter.localInsert(1, cp("x"));

    for (const op of deleteOps) inserter.applyRemote(op);
    deleter.applyRemote(insertOp);

    expect(deleter.text()).toBe("HxO");
    expect(inserter.text()).toBe("HxO");
    expect(deleter.pending).toHaveLength(0);
    expect(inserter.pending).toHaveLength(0);
  });

  it("§10.7: backward typing by two replicas produces contiguous runs, never interleaved", () => {
    const seed = new Engine(1);
    const opX = seed.localInsert(0, cp("X"));

    // replicaLow has the smaller replica id, so its run sorts first (Engine
    // Spec Definition 4.2 rank tie-break) — this is what fixes "cbazyx" as
    // the expected order rather than either being arbitrary.
    const replicaLow = new Engine(10);
    const replicaHigh = new Engine(20);
    replicaLow.applyRemote(opX);
    replicaHigh.applyRemote(opX);

    // Each replica types backward: every new character is inserted at
    // visible index 0, immediately before whatever it just typed.
    const lowOps = ["a", "b", "c"].map((ch) => replicaLow.localInsert(0, cp(ch)));
    const highOps = ["x", "y", "z"].map((ch) => replicaHigh.localInsert(0, cp(ch)));

    expect(replicaLow.text()).toBe("cba" + "X");
    expect(replicaHigh.text()).toBe("zyx" + "X");

    for (const op of highOps) replicaLow.applyRemote(op);
    for (const op of lowOps) replicaHigh.applyRemote(op);

    // Case A line 13's originRight equality test is exactly what keeps these
    // two runs contiguous — without it this converges to "zcybxa" instead.
    expect(replicaLow.text()).toBe("cbazyxX");
    expect(replicaHigh.text()).toBe("cbazyxX");
    expect(replicaLow.pending).toHaveLength(0);
    expect(replicaHigh.pending).toHaveLength(0);
  });

  it("§10.5: reverse-causal delivery with duplicates still converges and drains to zero pending", () => {
    const seed = new Engine(1);
    const opX = seed.localInsert(0, cp("X"));

    const author = new Engine(10);
    const receiver = new Engine(20);
    author.applyRemote(opX);
    receiver.applyRemote(opX);

    const ops = ["a", "b", "c"].map((ch) => author.localInsert(0, cp(ch)));
    expect(author.text()).toBe("cbaX");

    // Deliver strictly in REVERSE causal order (c, then b, then a), each
    // duplicated once, interleaved with the duplicate of the one before it —
    // every op is causally unready on first delivery except the last.
    const reversed = [...ops].reverse();
    for (const op of reversed) {
      receiver.applyRemote(op); // first delivery — likely buffered
      receiver.applyRemote(op); // duplicate — must be a no-op either way
    }

    expect(receiver.text()).toBe("cbaX");
    expect(receiver.pending).toHaveLength(0);
    expect(receiver.stats().totalElements).toBe(author.stats().totalElements);
  });

  it("typeString/localDelete round-trip stays structurally sound for a longer run", () => {
    const engine = new Engine(1);
    typeString(engine, "the quick brown fox");
    expect(engine.text()).toBe("the quick brown fox");
    engine.localDelete(4, 6); // remove "quick "
    expect(engine.text()).toBe("the brown fox");
    expect(engine.stats().tombstones).toBe(6);
    expect(engine.pending).toHaveLength(0);
  });
});
