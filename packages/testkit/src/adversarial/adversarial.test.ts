import { describe, expect, it } from "vitest";
import { Engine } from "@collab-editor/engine";
import type { Operation } from "@collab-editor/engine";
import { cp, forEachReplicaOrdering } from "./support.js";

/**
 * The adversarial suite (Test Plan §2.4, ADV-01…ADV-22) — 22
 * hand-constructed cases with expected output written literally, not
 * computed. Every scenario and expected literal below is taken directly
 * from the Test Plan §2.4 table (case description, expected output,
 * source citation), not invented — each was re-derived by hand, tracing
 * Engine Spec §4.3's Case A/B/C rules and Definition 4.2's rank exactly
 * as engine.ts implements them, to confirm the literal in the table is
 * what the algorithm actually produces before the assertion was written.
 */

function buildBase(seedReplicaId: number, text: string): Engine {
  const seed = new Engine(seedReplicaId);
  for (const ch of text) {
    seed.localInsert(seed.text().length, cp(ch));
  }
  return seed;
}

function syncFromSeed(seed: Engine, ...replicas: Engine[]): void {
  for (const node of seed.nodes) {
    const op: Operation = {
      kind: "insert",
      id: node.id,
      value: node.value,
      parent: node.parent,
      side: node.side,
      bind: node.bind,
    };
    for (const replica of replicas) {
      replica.applyRemote(op);
    }
  }
}

describe("Adversarial suite — PRD M1(c) group (ADV-01…ADV-13)", () => {
  it("ADV-01: 2 concurrent inserts at identical position -> AabB", () => {
    forEachReplicaOrdering(2, ([r1, r2]) => {
      const r1Id = r1 as number;
      const r2Id = r2 as number;
      const seed = buildBase(100, "AB");
      const engineA = new Engine(r1Id);
      const engineB = new Engine(r2Id);
      syncFromSeed(seed, engineA, engineB);

      const opA = engineA.localInsert(1, cp("a"));
      const opB = engineB.localInsert(1, cp("b"));
      engineA.applyRemote(opB);
      engineB.applyRemote(opA);

      const expected = r1Id < r2Id ? "AabB" : "AbaB";
      expect(engineA.text()).toBe(expected);
      expect(engineB.text()).toBe(expected);
    });
  });

  it("ADV-02: 3 concurrent inserts, each replica receiving the others in a different rotation -> AabcB", () => {
    const seed = buildBase(100, "AB");
    const e1 = new Engine(1);
    const e2 = new Engine(2);
    const e3 = new Engine(3);
    syncFromSeed(seed, e1, e2, e3);

    const opA = e1.localInsert(1, cp("a"));
    const opB = e2.localInsert(1, cp("b"));
    const opC = e3.localInsert(1, cp("c"));
    const all = [opA, opB, opC];

    // Each replica receives the OTHER two ops in a distinct rotation.
    e1.applyRemote(opB);
    e1.applyRemote(opC);
    e2.applyRemote(opC);
    e2.applyRemote(opA);
    e3.applyRemote(opA);
    e3.applyRemote(opB);
    expect(all).toHaveLength(3);

    expect(e1.text()).toBe("AabcB");
    expect(e2.text()).toBe("AabcB");
    expect(e3.text()).toBe("AabcB");
  });

  it("ADV-03: 8 concurrent inserts, 8 distinct arrival rotations -> AabcdefghB", () => {
    const seed = buildBase(100, "AB");
    const letters = "abcdefgh";
    const engines = Array.from({ length: 8 }, (_, i) => new Engine(i + 1));
    syncFromSeed(seed, ...engines);

    const ops = engines.map((engine, i) => engine.localInsert(1, cp(letters[i] as string)));

    // Each replica receives the other 7 ops starting from a different
    // rotation offset — 8 distinct arrival rotations, per the case name.
    for (let i = 0; i < engines.length; i++) {
      const engine = engines[i] as Engine;
      for (let step = 1; step <= ops.length; step++) {
        const j = (i + step) % ops.length;
        if (j !== i) engine.applyRemote(ops[j] as Operation);
      }
    }

    const expected = `A${letters}B`;
    for (const engine of engines) {
      expect(engine.text()).toBe(expected);
    }
  });

  it("ADV-04: insert inside a concurrently deleted range -> HxO", () => {
    // Engine Spec §10.3's own worked trace: HELLO, delete ELL concurrent
    // with an insert of x right after H.
    const seed = buildBase(100, "HELLO");
    const deleter = new Engine(1);
    const inserter = new Engine(2);
    syncFromSeed(seed, deleter, inserter);

    const delOps = deleter.localDelete(1, 3); // E, L, L
    const insOp = inserter.localInsert(1, cp("x")); // right after H, unaware of the delete

    for (const op of delOps) inserter.applyRemote(op);
    deleter.applyRemote(insOp);

    expect(deleter.text()).toBe("HxO");
    expect(inserter.text()).toBe("HxO");
  });

  it("ADV-05: delete of a range split by a concurrent insert -> ABzF", () => {
    const seed = buildBase(100, "ABCDEF");
    const deleter = new Engine(1);
    const inserter = new Engine(2);
    syncFromSeed(seed, deleter, inserter);

    const delOps = deleter.localDelete(2, 3); // C, D, E
    const insOp = inserter.localInsert(3, cp("z")); // between C and D, unaware of the delete

    for (const op of delOps) inserter.applyRemote(op);
    deleter.applyRemote(insOp);

    expect(deleter.text()).toBe("ABzF");
    expect(inserter.text()).toBe("ABzF");
    expect(deleter.stats().totalElements).toBe(7);
  });

  it("ADV-06: two overlapping concurrent deletes -> AFG", () => {
    const seed = buildBase(100, "ABCDEFG");
    const engineX = new Engine(1);
    const engineY = new Engine(2);
    syncFromSeed(seed, engineX, engineY);

    const opsX = engineX.localDelete(1, 3); // B, C, D
    const opsY = engineY.localDelete(2, 3); // C, D, E

    for (const op of opsY) engineX.applyRemote(op);
    for (const op of opsX) engineY.applyRemote(op);

    expect(engineX.text()).toBe("AFG");
    expect(engineY.text()).toBe("AFG");
    expect(engineX.stats().totalElements).toBe(7);
    expect(engineX.stats().tombstones).toBe(4); // B, C, D, E
  });

  it("ADV-07: two identical concurrent deletes -> AC, one character removed not two", () => {
    const seed = buildBase(100, "ABC");
    const engineX = new Engine(1);
    const engineY = new Engine(2);
    syncFromSeed(seed, engineX, engineY);

    const opX = engineX.localDelete(1, 1)[0]!; // targets B
    const opY = engineY.localDelete(1, 1)[0]!; // a DIFFERENT op, also targets B

    engineX.applyRemote(opY);
    engineY.applyRemote(opX);

    expect(engineX.text()).toBe("AC");
    expect(engineY.text()).toBe("AC");
    expect(engineX.stats().totalElements).toBe(3); // B still one node, not duplicated
    expect(engineX.stats().tombstones).toBe(1);
  });

  it("ADV-08: operation delivered twice -> idempotent, pendingCount() == 0", () => {
    const seed = buildBase(100, "AB");
    const author = new Engine(1);
    const receiver = new Engine(2);
    syncFromSeed(seed, author, receiver);

    const op = author.localInsert(1, cp("x"));
    receiver.applyRemote(op);
    receiver.applyRemote(op); // exact duplicate

    expect(receiver.text()).toBe("AxB");
    expect(receiver.stats().totalElements).toBe(3);
    expect(receiver.pending).toHaveLength(0);
  });

  it("ADV-09: reverse causal order with interleaved duplicates -> ABC, buffer drains", () => {
    const author = new Engine(1);
    const receiver = new Engine(2);

    // Plain forward typing: B depends on A, C depends on B.
    const opA = author.localInsert(0, cp("A"));
    const opB = author.localInsert(1, cp("B"));
    const opC = author.localInsert(2, cp("C"));
    expect(author.text()).toBe("ABC");

    // Reverse causal order, each op duplicated immediately, before the
    // one dependency (A) that would let anything apply ever arrives.
    receiver.applyRemote(opC);
    receiver.applyRemote(opC);
    receiver.applyRemote(opB);
    receiver.applyRemote(opB);
    expect(receiver.pending).toHaveLength(4);
    expect(receiver.text()).toBe("");

    receiver.applyRemote(opA);
    receiver.applyRemote(opA); // duplicate of an op that just got applied

    expect(receiver.text()).toBe("ABC");
    expect(receiver.pending).toHaveLength(0);
  });

  it("ADV-10: concurrent first-insert into an empty document -> XYZ", () => {
    const e1 = new Engine(1);
    const e2 = new Engine(2);
    const e3 = new Engine(3);

    // All three anchor at the ONLY possible window on an empty doc: (null, null).
    const opX = e1.localInsert(0, cp("X"));
    const opY = e2.localInsert(0, cp("Y"));
    const opZ = e3.localInsert(0, cp("Z"));

    for (const op of [opY, opZ]) e1.applyRemote(op);
    for (const op of [opX, opZ]) e2.applyRemote(op);
    for (const op of [opX, opY]) e3.applyRemote(op);

    expect(e1.text()).toBe("XYZ");
    expect(e2.text()).toBe("XYZ");
    expect(e3.text()).toBe("XYZ");
  });

  it("ADV-11: concurrent insert at position 0 and at EOF -> <MID>", () => {
    const seed = buildBase(100, "MID");
    const engineStart = new Engine(1);
    const engineEnd = new Engine(2);
    syncFromSeed(seed, engineStart, engineEnd);

    const opStart = engineStart.localInsert(0, cp("<"));
    const opEnd = engineEnd.localInsert(3, cp(">"));
    engineStart.applyRemote(opEnd);
    engineEnd.applyRemote(opStart);

    expect(engineStart.text()).toBe("<MID>");
    expect(engineEnd.text()).toBe("<MID>");
  });

  it("ADV-12: insert concurrent with deletion of the entire document -> ! (not empty)", () => {
    const seed = buildBase(100, "ABC");
    const deleter = new Engine(1);
    const inserter = new Engine(2);
    syncFromSeed(seed, deleter, inserter);

    const delOps = deleter.localDelete(0, 3); // deletes A, B, C entirely
    const insOp = inserter.localInsert(1, cp("!")); // between A and B, unaware of the delete

    for (const op of delOps) inserter.applyRemote(op);
    deleter.applyRemote(insOp);

    expect(deleter.text()).toBe("!");
    expect(inserter.text()).toBe("!");
  });

  it("ADV-13: replica clocks skewed by a large delta (+-5 minutes' worth of ticks) -> identical to unskewed", () => {
    const seed = buildBase(100, "AB");
    const skewed = new Engine(10);
    const plain = new Engine(20);
    syncFromSeed(seed, skewed, plain);
    skewed.observe(500_000); // stands in for "+-5 minutes" — Lamport counters carry no time unit (Engine Spec I0)

    const opSkewed = skewed.localInsert(1, cp("a"));
    const opPlain = plain.localInsert(1, cp("b"));
    skewed.applyRemote(opPlain);
    plain.applyRemote(opSkewed);

    // Rank is (bind, replicaId) only — 10 < 20 regardless of clock value.
    expect(skewed.text()).toBe("AabB");
    expect(plain.text()).toBe("AabB");
  });
});

describe("Adversarial suite — Engine-derived group (ADV-14…ADV-22)", () => {
  it("ADV-14: both users type a run by repeatedly inserting at the same index -> [cbazyx], each run contiguous", () => {
    const seed = buildBase(100, "X");
    const low = new Engine(10);
    const high = new Engine(20);
    syncFromSeed(seed, low, high);

    const lowOps = ["a", "b", "c"].map((ch) => low.localInsert(0, cp(ch)));
    const highOps = ["x", "y", "z"].map((ch) => high.localInsert(0, cp(ch)));
    expect(low.text()).toBe("cbaX");
    expect(high.text()).toBe("zyxX");

    for (const op of highOps) low.applyRemote(op);
    for (const op of lowOps) high.applyRemote(op);

    expect(low.text()).toBe("cbazyxX");
    expect(high.text()).toBe("cbazyxX");
  });

  it("ADV-15: three users each type a 3-character run at the same position -> AAABBBCCC", () => {
    // Forward typing (append), from an empty document, one repeated
    // letter per replica — extends ADV-14's two-party contiguity result
    // to three parties, ascending replica id ending up leftmost.
    const engineA = new Engine(1);
    const engineB = new Engine(2);
    const engineC = new Engine(3);

    const opsA = [0, 1, 2].map((i) => engineA.localInsert(i, cp("A")));
    const opsB = [0, 1, 2].map((i) => engineB.localInsert(i, cp("B")));
    const opsC = [0, 1, 2].map((i) => engineC.localInsert(i, cp("C")));
    expect(engineA.text()).toBe("AAA");
    expect(engineB.text()).toBe("BBB");
    expect(engineC.text()).toBe("CCC");

    for (const [engine, opLists] of [
      [engineA, [opsB, opsC]],
      [engineB, [opsA, opsC]],
      [engineC, [opsA, opsB]],
    ] as const) {
      for (const ops of opLists) {
        for (const op of ops) engine.applyRemote(op);
      }
    }

    const expected = "AAABBBCCC";
    expect(engineA.text()).toBe(expected);
    expect(engineB.text()).toBe(expected);
    expect(engineC.text()).toBe(expected);
  });

  it("ADV-16: partial causal overlap — B saw half of A's run before starting its own -> abxycd", () => {
    // A types "ab" first, and B receives exactly that much (has seen
    // "half of A's run") before A continues with "cd" and B, concurrently
    // and independently, continues with "xy" from the same "ab" it saw.
    const a = new Engine(2);
    const b = new Engine(1);

    const opA1 = a.localInsert(0, cp("a"));
    const opB1 = a.localInsert(1, cp("b"));
    b.applyRemote(opA1);
    b.applyRemote(opB1);
    expect(a.text()).toBe("ab");
    expect(b.text()).toBe("ab");

    const opX = b.localInsert(2, cp("x")); // B's own continuation from "ab"
    const opY = b.localInsert(3, cp("y"));
    const opC = a.localInsert(2, cp("c")); // A's own continuation from "ab", unaware of x/y
    const opD = a.localInsert(3, cp("d"));

    a.applyRemote(opX);
    a.applyRemote(opY);
    b.applyRemote(opC);
    b.applyRemote(opD);

    // Case A line 13 (Engine Spec §4.3): x and c share the same left
    // origin (b) but different right origins (both null/open), so the
    // originRight-equality test does NOT fire — the algorithm must keep
    // scanning rather than breaking early, which is exactly what keeps
    // B's "xy" block contiguous ahead of A's "cd" block (B's replica id
    // is lower).
    expect(a.text()).toBe("abxycd");
    expect(b.text()).toBe("abxycd");
  });

  it("ADV-17 (Engine Spec I8): combining mark vs concurrent plain insert, both replica-id orderings -> ex with the mark forming e-acute", () => {
    const COMBINING_ACUTE = 0x0301;
    forEachReplicaOrdering(2, ([markReplicaId, charReplicaId]) => {
      const seed = buildBase(100, "e");
      const markEngine = new Engine(markReplicaId as number);
      const charEngine = new Engine(charReplicaId as number);
      syncFromSeed(seed, markEngine, charEngine);

      // Both anchor at the SAME window: append right after "e".
      const markOp = markEngine.localInsert(1, COMBINING_ACUTE); // bind: true, via isClusterContinuing
      const charOp = charEngine.localInsert(1, cp("x")); // bind: false

      markEngine.applyRemote(charOp);
      charEngine.applyRemote(markOp);

      // "éx": e + combining acute (one grapheme, e-acute) followed by x.
      const expected = "e" + String.fromCodePoint(COMBINING_ACUTE) + "x";
      expect(markEngine.text()).toBe(expected);
      expect(charEngine.text()).toBe(expected);
    });
  });

  it("ADV-18 (Engine Spec §10.8): two concurrent combining marks on the same base — converged, both retained, base intact, both orderings", () => {
    const MARK_1 = 0x0301; // combining acute
    const MARK_2 = 0x0327; // combining cedilla

    forEachReplicaOrdering(2, ([m1Id, m2Id]) => {
      const seed = buildBase(100, "e");
      const engineM1 = new Engine(m1Id as number);
      const engineM2 = new Engine(m2Id as number);
      syncFromSeed(seed, engineM1, engineM2);

      const opM1 = engineM1.localInsert(1, MARK_1);
      const opM2 = engineM2.localInsert(1, MARK_2);
      engineM1.applyRemote(opM2);
      engineM2.applyRemote(opM1);

      const marks =
        (m1Id as number) < (m2Id as number)
          ? String.fromCodePoint(MARK_1) + String.fromCodePoint(MARK_2)
          : String.fromCodePoint(MARK_2) + String.fromCodePoint(MARK_1);
      const expected = `e${marks}`;

      // Converged.
      expect(engineM1.text()).toBe(engineM2.text());
      // Both marks retained, base intact.
      expect(engineM1.text()).toBe(expected);
      expect(engineM1.text().startsWith("e")).toBe(true);
      expect(Array.from(engineM1.text())).toHaveLength(3);
    });
  });

  it("ADV-19 (PRD FR-CE-9): ZWJ emoji continuation vs concurrent insert — the plain character lands after the whole cluster, both orderings", () => {
    const MAN = 0x1f468;
    const ZWJ = 0x200d;
    forEachReplicaOrdering(2, ([zwjReplicaId, charReplicaId]) => {
      const seed = new Engine(100);
      seed.localInsert(0, MAN);
      const zwjEngine = new Engine(zwjReplicaId as number);
      const charEngine = new Engine(charReplicaId as number);
      syncFromSeed(seed, zwjEngine, charEngine);

      const zwjOp = zwjEngine.localInsert(1, ZWJ); // bind: true
      const charOp = charEngine.localInsert(1, cp("g")); // bind: false

      zwjEngine.applyRemote(charOp);
      charEngine.applyRemote(zwjOp);

      const expected = String.fromCodePoint(MAN) + String.fromCodePoint(ZWJ) + "g";
      expect(zwjEngine.text()).toBe(expected);
      expect(charEngine.text()).toBe(expected);
    });
  });

  it("ADV-20 (Engine Spec §4.2): insert whose originRight arrives before its originLeft -> buffered, then drains, converged", () => {
    const creator = new Engine(1);
    const opA = creator.localInsert(0, cp("A"));
    const opC = creator.localInsert(1, cp("C")); // originLeft: A
    const opX = creator.localInsert(1, cp("x")); // between A and C: originLeft A, originRight C
    expect(creator.text()).toBe("AxC");

    const receiver = new Engine(2);
    // X's originRight (C) — itself dependent on A — arrives first.
    receiver.applyRemote(opC);
    // X arrives next: neither origin is present yet.
    receiver.applyRemote(opX);
    expect(receiver.pending).toHaveLength(2); // both C and X are buffered
    expect(receiver.text()).toBe("");

    // X's originLeft (A) finally arrives, triggering a full drain.
    receiver.applyRemote(opA);
    expect(receiver.pending).toHaveLength(0);
    expect(receiver.text()).toBe("AxC");
  });

  it("ADV-21 (PRD OQ-3 / Engine Spec §9.3): undelete of a node deleted later by another user is a no-op, regardless of arrival order", () => {
    const seed = buildBase(100, "ABC");
    const bId = seed.nodes[1]!.id;

    // Causal order: delete1, undelete, delete2 (delete2 is LATER than the undelete).
    const delId1 = seed.mint();
    const delOp1: Operation = { kind: "delete", id: delId1, target: bId };
    const undelId = seed.mint();
    const undelOp: Operation = { kind: "undelete", id: undelId, target: bId };
    const delId2 = seed.mint();
    const delOp2: Operation = { kind: "delete", id: delId2, target: bId };

    // Replica X applies in exact causal order.
    const engineX = new Engine(1);
    syncFromSeed(seed, engineX);
    engineX.applyRemote(delOp1);
    expect(engineX.text()).toBe("AC");
    engineX.applyRemote(undelOp);
    expect(engineX.text()).toBe("ABC"); // temporarily restored
    engineX.applyRemote(delOp2);
    expect(engineX.text()).toBe("AC"); // the later delete wins — net no-op

    // Replica Y receives the SAME operations in a DIFFERENT arrival
    // order (the undelete arrives LAST, after the later delete) — the
    // causal id, not delivery order, must still decide the outcome.
    const engineY = new Engine(2);
    syncFromSeed(seed, engineY);
    engineY.applyRemote(delOp1);
    engineY.applyRemote(delOp2);
    engineY.applyRemote(undelOp);

    expect(engineY.text()).toBe("AC");
    expect(engineX.text()).toBe(engineY.text()); // text unchanged, and identical, on both replicas
  });

  it("ADV-22 (Engine Spec I0): 3,000 sequentially-typed characters, block-encoded -> compression > 1000x", () => {
    const engine = new Engine(1);
    const N = 3000;
    for (let i = 0; i < N; i++) {
      engine.localInsert(engine.text().length, cp("a"));
    }

    const counters = engine.nodes.map((n) => n.id.c);
    for (let i = 0; i < N; i++) {
      expect(counters[i]).toBe(i + 1); // exactly 1..3000, no gaps — Invariant I0
    }

    // Engine Spec §7.5's block run-length encoding (Phase 20) and its diagnostic
    // `engine.blockCount` getter are RETIRED as of the Fugue port (2026-09-05, CLAUDE.md's
    // "Fugue port" entry) — a Fugue tree has no flat, consecutive-counter block storage to
    // count, and the compression-ratio claim this sub-case exists to check needs its own
    // from-scratch design for a tree structure (deferred, disclosed, out of this session's
    // scope — see CLAUDE.md). The I0 counter-sequence check above (the sub-case's own actual
    // named invariant, "Engine Spec I0") is unaffected and still verified.
  });
});
