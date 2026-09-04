import { describe, expect, it } from "vitest";
import { compareIds } from "./identifier.js";
import { Engine } from "./engine.js";
import { assertInvariants } from "./invariants.js";
import type { DeleteOperation } from "./operation.js";

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

describe("Engine — collect() garbage collection (Phase 21, Engine Spec §7.3/§7.4/§7.7)", () => {
  const DEFAULT_HORIZON = { maxAgeMs: 5 * 60 * 1000, maxOpsPerReplica: 200 };

  /** Deletes `target` on `engine`, attaching GC context (seq/atMs) exactly as the server's
   * coordinator engine would via `applyRemote`'s optional third argument — `localDelete()`
   * itself never attaches context, matching every real client engine. */
  function deleteWithContext(
    engine: Engine,
    target: { id: { c: number; r: number } },
    seq: bigint,
    atMs: number,
    deleterId: { c: number; r: number } = { c: seq === 0n ? 1 : Number(seq) + 1000, r: 99 },
  ): void {
    const op: DeleteOperation = { kind: "delete", id: deleterId, target: target.id };
    engine.applyRemote(op, { seq, atMs });
  }

  it("condition 1: a LIVE node is never collectible regardless of frontier/age", () => {
    const engine = new Engine(1);
    engine.localInsert(0, cp("A"));
    const before = engine.stats().totalElements;
    const result = engine.collect(1_000_000n, { nowMs: 10_000_000, ...DEFAULT_HORIZON });
    expect(result.collectedCount).toBe(0);
    expect(engine.stats().totalElements).toBe(before);
  });

  it("condition 2: a deleted node is not collectible until its delete is causally stable (seq <= frontier)", () => {
    const engine = new Engine(1);
    const insA = engine.localInsert(0, cp("A"));
    const target = { id: insA.id };
    deleteWithContext(engine, target, 50n, 0);

    // Frontier hasn't reached the delete's own seq (50) yet.
    let result = engine.collect(49n, { nowMs: 10_000_000, ...DEFAULT_HORIZON });
    expect(result.collectedCount).toBe(0);
    expect(engine.stats().totalElements).toBe(1);

    // Frontier now covers it, AND the horizon has passed (age-based).
    result = engine.collect(50n, { nowMs: 10_000_000, ...DEFAULT_HORIZON });
    expect(result.collectedCount).toBe(1);
    expect(engine.stats().totalElements).toBe(0);
  });

  it("condition 4 (age half): not collectible until maxAgeMs has elapsed since the delete's atMs", () => {
    const engine = new Engine(1);
    const insA = engine.localInsert(0, cp("A"));
    deleteWithContext(engine, { id: insA.id }, 1n, 1_000);

    let result = engine.collect(1n, { nowMs: 1_000 + 4 * 60 * 1000, ...DEFAULT_HORIZON }); // +4min
    expect(result.collectedCount).toBe(0);

    result = engine.collect(1n, { nowMs: 1_000 + 5 * 60 * 1000, ...DEFAULT_HORIZON }); // +5min exactly
    expect(result.collectedCount).toBe(1);
  });

  it("condition 4 (op-count half): collectible once the deleting replica has minted maxOpsPerReplica further operations, even if still within maxAgeMs", () => {
    const engine = new Engine(1);
    const insA = engine.localInsert(0, cp("A"));
    const deleterReplica = 99;
    deleteWithContext(engine, { id: insA.id }, 1n, 0, { c: 1, r: deleterReplica });

    // Not aged out (nowMs unchanged from delete time) and not enough further ops yet.
    for (let i = 0; i < 150; i++) {
      engine.applyRemote({
        kind: "insert",
        id: { c: 2 + i, r: deleterReplica },
        value: cp("x"),
        originLeft: null,
        originRight: null,
        bind: false,
      });
    }
    let result = engine.collect(1n, { nowMs: 0, maxAgeMs: 5 * 60 * 1000, maxOpsPerReplica: 200 });
    expect(result.collectedCount).toBe(0);

    // Cross the 200-further-ops threshold (deleterId's own counter is 1; 200 more lands at 201).
    for (let i = 150; i < 200; i++) {
      engine.applyRemote({
        kind: "insert",
        id: { c: 2 + i, r: deleterReplica },
        value: cp("x"),
        originLeft: null,
        originRight: null,
        bind: false,
      });
    }
    result = engine.collect(1n, { nowMs: 0, maxAgeMs: 5 * 60 * 1000, maxOpsPerReplica: 200 });
    expect(result.collectedCount).toBe(1);
  });

  it("no delete-context (plain applyRemote/localDelete, every existing caller) is NEVER collectible, no matter the frontier/horizon", () => {
    const engine = new Engine(1);
    engine.localInsert(0, cp("A"));
    engine.localDelete(0, 1); // no context — the ordinary client-side path
    const result = engine.collect(1_000_000_000n, { nowMs: 1_000_000_000, maxAgeMs: 0, maxOpsPerReplica: 0 });
    expect(result.collectedCount).toBe(0);
    expect(engine.stats().totalElements).toBe(1);
  });

  it("condition 3 + fixpoint: a deleted node anchored by a LIVE node is protected, and protection cascades through a chain of deleted nodes", () => {
    // A(live) -- B(deleted,collectible) -- C(deleted,collectible) -- D(deleted,collectible) -- E(live, anchors D)
    const engine = new Engine(1);
    const opA = { id: { c: 1, r: 1 } };
    engine.applyRemote({ kind: "insert", id: opA.id, value: cp("A"), originLeft: null, originRight: null, bind: false });
    const opB = { id: { c: 2, r: 1 } };
    engine.applyRemote({ kind: "insert", id: opB.id, value: cp("B"), originLeft: opA.id, originRight: null, bind: false });
    const opC = { id: { c: 3, r: 1 } };
    engine.applyRemote({ kind: "insert", id: opC.id, value: cp("C"), originLeft: opB.id, originRight: null, bind: false });
    const opD = { id: { c: 4, r: 1 } };
    engine.applyRemote({ kind: "insert", id: opD.id, value: cp("D"), originLeft: opC.id, originRight: null, bind: false });
    const opE = { id: { c: 5, r: 1 } };
    engine.applyRemote({ kind: "insert", id: opE.id, value: cp("E"), originLeft: opD.id, originRight: null, bind: false });

    deleteWithContext(engine, opB, 10n, 0, { c: 100, r: 2 });
    deleteWithContext(engine, opC, 11n, 0, { c: 101, r: 2 });
    deleteWithContext(engine, opD, 12n, 0, { c: 102, r: 2 });
    // E stays live -- it anchors D via originLeft, so D must survive, which in turn protects
    // C (D's own originLeft), which in turn protects B (C's own originLeft) -- pure cascade.

    const result = engine.collect(1_000n, { nowMs: 1_000_000, maxAgeMs: 0, maxOpsPerReplica: 0 });
    expect(result.collectedCount).toBe(0);
    expect(engine.text()).toBe("AE"); // unaffected -- GC never touches visible text
    expect(engine.stats().totalElements).toBe(5); // nothing physically removed
  });

  it("condition 3 + fixpoint: once the anchoring live node is ALSO deleted (and stable/aged), the whole chain becomes collectible together", () => {
    const engine = new Engine(1);
    const opA = { id: { c: 1, r: 1 } };
    engine.applyRemote({ kind: "insert", id: opA.id, value: cp("A"), originLeft: null, originRight: null, bind: false });
    const opB = { id: { c: 2, r: 1 } };
    engine.applyRemote({ kind: "insert", id: opB.id, value: cp("B"), originLeft: opA.id, originRight: null, bind: false });
    const opC = { id: { c: 3, r: 1 } };
    engine.applyRemote({ kind: "insert", id: opC.id, value: cp("C"), originLeft: opB.id, originRight: null, bind: false });

    deleteWithContext(engine, opB, 10n, 0, { c: 100, r: 2 });
    deleteWithContext(engine, opC, 11n, 0, { c: 101, r: 2 });

    const result = engine.collect(1_000n, { nowMs: 1_000_000, maxAgeMs: 0, maxOpsPerReplica: 0 });
    expect(result.collectedCount).toBe(2);
    expect(engine.text()).toBe("A");
    expect(engine.stats().totalElements).toBe(1); // only A remains
    // I4 holds trivially now -- A has no origins at all (both null).
    expect(() => assertInvariants(engine, { afterCollect: true })).not.toThrow();
  });

  it("collect() never changes visible text, and I4/afterCollect-I5 hold across many randomized delete/collect cycles (exhaustive, per Test Plan M8-c's own emphasis)", () => {
    function mulberry32(seed: number): () => number {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    for (let trial = 0; trial < 200; trial++) {
      const rng = mulberry32(trial);
      const engine = new Engine(1);
      let seq = 0n;
      const nowMs = 10_000_000;

      // Build a document, deleting roughly half of it WITH context (a realistic mixed
      // live/tombstoned structure), then collect at a random frontier/horizon and verify
      // invariants on EVERY single collect() call, not just the last one.
      const opCount = 30 + Math.floor(rng() * 40);
      for (let i = 0; i < opCount; i++) {
        const visLen = engine.stats().visibleLength;
        const pos = Math.floor(rng() * (visLen + 1));
        engine.localInsert(pos, 97 + Math.floor(rng() * 26));
      }
      // Delete roughly half the visible characters, one at a time, WITH GC context.
      const deleteCount = Math.floor(engine.stats().visibleLength / 2);
      for (let i = 0; i < deleteCount; i++) {
        const visLen = engine.stats().visibleLength;
        if (visLen === 0) break;
        const pos = Math.floor(rng() * visLen);
        const node = engine.nodes.filter((n) => !n.deleted)[pos]!;
        seq += 1n;
        deleteWithContext(engine, { id: node.id }, seq, Math.floor(rng() * nowMs), {
          c: 10_000 + i,
          r: 2,
        });
      }

      const textBefore = engine.text();
      // Sweep across several random (frontier, horizon) combinations against the SAME engine,
      // asserting invariants after EVERY collect() call.
      for (let round = 0; round < 5; round++) {
        const frontier = BigInt(Math.floor(rng() * Number(seq + 5n)));
        const maxAgeMs = Math.floor(rng() * nowMs);
        const maxOpsPerReplica = Math.floor(rng() * 300);
        engine.collect(frontier, { nowMs, maxAgeMs, maxOpsPerReplica });
        expect(engine.text()).toBe(textBefore); // GC must never change visible content
        expect(() => assertInvariants(engine, { afterCollect: true })).not.toThrow();
      }
    }
  });

  describe("collect() wall-clock safety cap — logic/correctness only (no real timing here: Engine Spec C9 forbids a wall-clock read anywhere in packages/engine/src, test files included — the REAL-time measurement proving '214ms not 853,000ms' lives in packages/testkit/src/benchmark/gcSafetyCap.bench.test.ts, the same split Phase 19's scaling benchmark already established for the identical reason)", () => {
    /** A deterministic, monotonically-increasing FAKE clock — never reads a real wall clock,
     * so this whole describe block stays fully reproducible (this project's own standing
     * preference, matching the seeded-PRNG fuzz harness) while still exercising the cap's
     * real trigger logic: each call advances by `incrementMs`, so `budgetMs` is crossed after
     * a known, exact number of calls (`collect()` calls `clock()` once per completed pass). */
    function fakeClock(incrementMs: number): () => number {
      let t = 0;
      return () => {
        t += incrementMs;
        return t;
      };
    }

    /** Builds the EXACT pathological shape that measured 853s uncapped (real timing,
     * packages/testkit's own benchmark): `count` sequential append-chain characters
     * (originLeft chains to the immediate predecessor, matching real sequential typing), the
     * first `deleteCount` of them tombstoned with real GC context — an UNRESOLVED anchor
     * chain, since the still-live character right after the deleted prefix permanently
     * references the last deleted one. Pure in-process engine construction (no DB), so this
     * runs in well under a second even though it reproduces the same shape that took 853s to
     * (correctly) find nothing collectible in, uncapped. */
    function buildPathologicalChain(
      count: number,
      deleteCount: number,
    ): { readonly engine: Engine; readonly nowMs: number } {
      const engine = new Engine(1);
      let prevId: { c: number; r: number } | null = null;
      const ids: Array<{ c: number; r: number }> = [];
      for (let i = 0; i < count; i++) {
        const id = { c: i + 1, r: 1 };
        engine.applyRemote({
          kind: "insert",
          id,
          value: 97 + (i % 26),
          originLeft: prevId,
          originRight: null,
          bind: false,
        });
        ids.push(id);
        prevId = id;
      }
      const nowMs = 10_000_000;
      for (let i = 0; i < deleteCount; i++) {
        const target = ids[i]!;
        const delId = { c: count + i + 1, r: 2 };
        engine.applyRemote(
          { kind: "delete", id: delId, target },
          { seq: BigInt(count + i + 1), atMs: 0 },
        );
      }
      return { engine, nowMs };
    }

    it("a capped sweep over the pathological 10,000-deep/90,000-node chain stops early, collects nothing, and never violates I4/I5", () => {
      const { engine, nowMs } = buildPathologicalChain(90_000, 10_000);
      expect(engine.stats().tombstones).toBe(10_000);

      // A fake clock that crosses a 150ms budget after exactly 2 simulated passes (100ms) --
      // deterministic proof the loop actually stops early (this chain needs ~10,000 passes to
      // naturally converge), without needing a real wall-clock read to demonstrate it.
      const result = engine.collect(
        BigInt(100_000), // frontier well past every delete's seq — fully causally stable
        { nowMs, maxAgeMs: 0, maxOpsPerReplica: 0, budgetMs: 150, clock: fakeClock(100) },
      );

      expect(result.incomplete).toBe(true);
      // CORRECTNESS: an incomplete sweep collects NOTHING (see CollectOptions.budgetMs's own
      // doc comment for the real bug this guards against -- an earlier version of this cap
      // collected whatever was left in `collectible` at cutoff, which is UNSAFE).
      expect(result.collectedCount).toBe(0);
      expect(engine.stats().tombstones).toBe(10_000); // nothing physically removed
      expect(() => assertInvariants(engine, { afterCollect: true })).not.toThrow();
    });

    it("HONEST result, not a hoped-for one: repeated capped cycles on the SAME unresolved chain make ZERO cumulative progress — this is a real, documented limitation of the safety cap alone, not solved by this phase", () => {
      // This chain needs far more cascade depth (10,000 passes) than a small budget can ever
      // reach in one call. Because an incomplete sweep is REQUIRED to collect nothing (the
      // correctness fix above), and each call restarts the fixpoint from scratch with no
      // memory of prior attempts, repeating this several times does NOT converge
      // incrementally -- it repeats the identical bounded work and gives up at the identical
      // point, forever. Verified directly rather than assumed -- a FRESH fake clock each
      // cycle (matching a fresh real wall-clock reading each real GC cycle would take).
      const { engine, nowMs } = buildPathologicalChain(90_000, 10_000);
      const collectedCounts: number[] = [];
      const incompleteFlags: boolean[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        const result = engine.collect(BigInt(100_000), {
          nowMs,
          maxAgeMs: 0,
          maxOpsPerReplica: 0,
          budgetMs: 150,
          clock: fakeClock(100),
        });
        collectedCounts.push(result.collectedCount);
        incompleteFlags.push(result.incomplete);
      }
      expect(collectedCounts).toEqual([0, 0, 0]); // NOT [0, something, more] -- genuinely stuck
      expect(incompleteFlags).toEqual([true, true, true]);
      expect(engine.stats().tombstones).toBe(10_000); // unchanged across all 3 cycles
    });

    it("a genuinely collectible case (delete from the END, no live successor to block it) still collects normally under the SAME budget — the cap only bites deep, unresolved cascades, not ordinary GC", () => {
      // Deleting the LAST 10 characters of a 1,000-char chain is NOT blocked (nothing was ever
      // inserted after them to anchor to them) -- resolves in one pass, trivially inside even
      // a tight budget. Confirms the cap doesn't regress the common, actually-productive case.
      const engine = new Engine(1);
      let prevId: { c: number; r: number } | null = null;
      const ids: Array<{ c: number; r: number }> = [];
      for (let i = 0; i < 1000; i++) {
        const id = { c: i + 1, r: 1 };
        engine.applyRemote({
          kind: "insert",
          id,
          value: 97 + (i % 26),
          originLeft: prevId,
          originRight: null,
          bind: false,
        });
        ids.push(id);
        prevId = id;
      }
      for (let i = 0; i < 10; i++) {
        const target = ids[999 - i]!; // delete from the end backward
        engine.applyRemote(
          { kind: "delete", id: { c: 2000 + i, r: 2 }, target },
          { seq: BigInt(2000 + i), atMs: 0 },
        );
      }
      expect(engine.stats().tombstones).toBe(10);

      const result = engine.collect(BigInt(3000), {
        nowMs: 10_000_000,
        maxAgeMs: 0,
        maxOpsPerReplica: 0,
        budgetMs: 150,
        clock: fakeClock(100),
      });
      expect(result.incomplete).toBe(false);
      expect(result.collectedCount).toBe(10); // genuinely, fully collected -- the cap never got in the way
      expect(engine.stats().tombstones).toBe(0);
    });
  });
});

describe("Engine — hasIdentifier() / rejectPending() (Phase 24, Engine Spec §7.6 Rule 7.2)", () => {
  it("hasIdentifier() is true for a live node and false for one that was never applied", () => {
    const engine = new Engine(1);
    const id = { c: 1, r: 1 };
    engine.applyRemote({ kind: "insert", id, value: 97, originLeft: null, originRight: null, bind: false });
    expect(engine.hasIdentifier(id)).toBe(true);
    expect(engine.hasIdentifier({ c: 999, r: 999 })).toBe(false);
  });

  it("hasIdentifier() is false for a node collect() has physically removed", () => {
    const engine = new Engine(1);
    const id = { c: 1, r: 1 };
    engine.applyRemote({ kind: "insert", id, value: 97, originLeft: null, originRight: null, bind: false });
    engine.applyRemote(
      { kind: "delete", id: { c: 2, r: 2 }, target: id },
      { seq: 1n, atMs: 0 },
    );
    expect(engine.hasIdentifier(id)).toBe(true); // tombstoned, but still structurally present
    engine.collect(10n, { nowMs: 10_000, maxAgeMs: 0, maxOpsPerReplica: 0 });
    expect(engine.hasIdentifier(id)).toBe(false); // physically gone
  });

  it("rejectPending() removes a matching operation from pending and returns true", () => {
    const engine = new Engine(1);
    // Anchored to an id this engine has never seen -- buffers into pending (Engine Spec §4.2).
    const stuck = {
      kind: "insert" as const,
      id: { c: 1, r: 2 },
      value: 97,
      originLeft: { c: 1, r: 99 },
      originRight: null,
      bind: false,
    };
    engine.applyRemote(stuck);
    expect(engine.pending).toHaveLength(1);
    expect(engine.rejectPending(stuck.id)).toBe(true);
    expect(engine.pending).toHaveLength(0);
  });

  it("rejectPending() returns false, and touches nothing, for an id not currently pending", () => {
    const engine = new Engine(1);
    expect(engine.rejectPending({ c: 1, r: 2 })).toBe(false);
    expect(engine.pending).toHaveLength(0);
  });

  it("rejectPending() matches by the OPERATION's own id, never the target it references -- two different pending deletes of the same target are independently evictable", () => {
    const engine = new Engine(1);
    const target = { c: 1, r: 99 }; // never applied -- both deletes below stay pending
    const del1 = { kind: "delete" as const, id: { c: 1, r: 2 }, target };
    const del2 = { kind: "delete" as const, id: { c: 1, r: 3 }, target };
    engine.applyRemote(del1);
    engine.applyRemote(del2);
    expect(engine.pending).toHaveLength(2);
    expect(engine.rejectPending(del1.id)).toBe(true);
    expect(engine.pending).toHaveLength(1);
    expect(engine.pending[0]).toBe(del2);
  });
});
