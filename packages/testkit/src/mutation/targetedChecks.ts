import type { LoadedEngineModule } from "./loadMutantEngine.js";

/**
 * A deliberately small, hand-picked subset of the adversarial (Phase 5)
 * and property (Phase 4) suites, re-implemented against the dynamically
 * loaded `LoadedEngineModule` interface rather than the statically
 * imported `@collab-editor/engine` those suites use directly — a mutant
 * run needs a Engine class built from mutated, freshly-transpiled
 * source, which the static import can never provide. This is NOT the
 * full 22+5 cases; it is chosen specifically so every one of the ten
 * mutants has at least one direct catcher here, matching Test Plan
 * §2.8's framing of "killed by their targeted suite."
 */

export interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

function cp(ch: string): number {
  return ch.codePointAt(0) as number;
}

function record(results: CheckResult[], name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({ name, passed: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function runTargetedChecks(mod: LoadedEngineModule): CheckResult[] {
  const results: CheckResult[] = [];
  const { Engine } = mod;

  // Catches M4_no_binding: a combining mark on the HIGHER-numbered
  // replica must still sort adjacent to its base (Engine Spec §10.8).
  record(results, "ADV-17: combining mark on higher replica id stays adjacent to base", () => {
    const seed = new Engine(100);
    seed.localInsert(0, cp("e"));
    const markEngine = new Engine(2); // higher id — the ordering M4 actually breaks
    const charEngine = new Engine(1);
    for (const node of seed.nodes) {
      const op = {
        kind: "insert",
        id: node.id,
        value: node.value,
        originLeft: node.originLeft,
        originRight: node.originRight,
        bind: node.bind,
      };
      markEngine.applyRemote(op);
      charEngine.applyRemote(op);
    }
    const markOp = markEngine.localInsert(1, 0x0301, true);
    const charOp = charEngine.localInsert(1, cp("x"), false);
    markEngine.applyRemote(charOp);
    charEngine.applyRemote(markOp);
    const expected = "e" + String.fromCodePoint(0x0301) + "x";
    assertEqual(markEngine.text(), expected, "combining mark position");
    assertEqual(charEngine.text(), expected, "combining mark position (charEngine)");
  });

  // Catches M2_no_right_bound. This needs more than Engine Spec §10.3's
  // HxO trace: that scenario turns out to be immune to M2 (destIndex
  // never gets pushed past the correct originRight there, because
  // nothing beyond it ever "wins" a Case A comparison against the new
  // node). What actually exposes an unbounded scan window is base
  // content with a SMALLER replica id than the concurrent insert
  // competing for the same window: under M2 the scan runs all the way
  // to the document's end instead of stopping at originRight, so it
  // keeps comparing the new node against base nodes it should never see
  // — and if those base nodes "win" (smaller rank), destIndex keeps
  // advancing past every one of them, past the correct originRight
  // entirely, cascading the insert all the way to the end of the
  // document.
  record(results, "unbounded scan: an insert must never drift past its own originRight", () => {
    const seed = new Engine(0); // smaller id than either competing replica below — deliberately so its nodes "win" ties
    for (const ch of "ABCD") seed.localInsert(seed.text().length, cp(ch));

    const replicaX = new Engine(1);
    const replicaY = new Engine(2);
    for (const node of seed.nodes) {
      const op = {
        kind: "insert",
        id: node.id,
        value: node.value,
        originLeft: node.originLeft,
        originRight: node.originRight,
        bind: node.bind,
      };
      replicaX.applyRemote(op);
      replicaY.applyRemote(op);
    }
    // Both concurrently insert into the SAME window [A, B).
    replicaX.localInsert(1, cp("p")); // originLeft: A, originRight: B
    const opQ = replicaY.localInsert(1, cp("q")); // originLeft: A, originRight: B
    replicaX.applyRemote(opQ);
    assertEqual(
      replicaX.text(),
      "ApqBCD",
      "q must land strictly between A and B, never drift past B/C/D",
    );
  });

  // Catches M5_double_tick directly: assertInvariants' I0 check
  // independently replays clock semantics and compares to the actual
  // clock — invisible to convergence checking (see mutantAdapter.ts's
  // docstring for why), but this check inspects the clock value itself.
  record(results, "I0: observe() merges via max, never increments on its own", () => {
    const engine = new Engine(1);
    engine.mint(); // clock -> 1
    engine.observe(5); // must become exactly 5, not 6
    mod.assertInvariants(engine);
  });

  // Catches M6_physical_delete: a deleted node must remain in the
  // structure (tombstoned), never physically removed (Invariant I5).
  record(results, "ADV-12-style: delete tombstones, never physically removes", () => {
    const engine = new Engine(1);
    engine.localInsert(0, cp("A"));
    engine.localInsert(1, cp("B"));
    engine.localInsert(2, cp("C"));
    engine.localDelete(1, 1); // delete B
    assertEqual(engine.stats().totalElements, 3, "totalElements after delete");
    assertEqual(engine.text(), "AC", "text after delete");
  });

  // Catches M7_no_right_readiness: an insert with a missing originRight
  // must buffer, never integrate against a nonexistent origin.
  record(results, "readiness: an insert with a missing originRight must buffer, not apply", () => {
    const seed = new Engine(100);
    seed.localInsert(0, cp("A"));
    const aId = seed.nodes[0]!.id;
    const receiver = new Engine(1);
    receiver.applyRemote({
      kind: "insert",
      id: aId,
      value: cp("A"),
      originLeft: null,
      originRight: null,
      bind: false,
    });
    const phantomId = { c: 999, r: 999 }; // never applied anywhere
    const result = receiver.applyRemote({
      kind: "insert",
      id: { c: 1, r: 1 },
      value: cp("x"),
      originLeft: aId,
      originRight: phantomId,
      bind: false,
    });
    if (!result.buffered) {
      throw new Error("insert with a missing originRight applied immediately instead of buffering");
    }
    assertEqual(receiver.pending.length, 1, "pending count");
  });

  // Catches M8_no_idempotence: re-delivering the same insert must be a no-op.
  record(results, "ADV-08: duplicate delivery of the same insert is a no-op", () => {
    const seed = new Engine(100);
    seed.localInsert(0, cp("A"));
    seed.localInsert(1, cp("B"));
    const author = new Engine(1);
    const receiver = new Engine(2);
    for (const node of seed.nodes) {
      const op = {
        kind: "insert",
        id: node.id,
        value: node.value,
        originLeft: node.originLeft,
        originRight: node.originRight,
        bind: node.bind,
      };
      author.applyRemote(op);
      receiver.applyRemote(op);
    }
    const op = author.localInsert(1, cp("x"));
    receiver.applyRemote(op);
    receiver.applyRemote(op); // exact duplicate
    assertEqual(receiver.text(), "AxB", "text after duplicate delivery");
    assertEqual(receiver.stats().totalElements, 3, "structure after duplicate delivery");
  });

  // Catches M9_delete_first_wins. Interleaving an undelete between the
  // delete and a later re-delete (as ADV-21 does) does NOT distinguish
  // this mutant: applyDelete's snapshot of "already deleted" is taken
  // fresh each time, so a delete that arrives right after an undelete
  // still correctly updates attribution either way. What actually
  // exposes "first wins" is TWO deletes with no undelete between them,
  // followed by an undelete whose id sits BETWEEN the two deletes'
  // ids: correct attribution (causally-latest, the second delete) makes
  // that undelete fail (it isn't the latest); "first wins" attribution
  // (the first delete) makes it wrongly succeed.
  record(
    results,
    "deletedBy is the causally-latest delete, not the first, across two deletes with no undelete between them",
    () => {
      const seed = new Engine(100);
      seed.localInsert(0, cp("A"));
      seed.localInsert(1, cp("B"));
      seed.localInsert(2, cp("C"));
      const bId = seed.nodes[1]!.id;

      const delId1 = seed.mint(); // first delete
      const undelId = seed.mint(); // causally BETWEEN the two deletes
      const delId2 = seed.mint(); // second delete — causally latest of the two

      const engine = new Engine(1);
      for (const node of seed.nodes) {
        const op = {
          kind: "insert",
          id: node.id,
          value: node.value,
          originLeft: node.originLeft,
          originRight: node.originRight,
          bind: node.bind,
        };
        engine.applyRemote(op);
      }
      engine.applyRemote({ kind: "delete", id: delId1, target: bId });
      engine.applyRemote({ kind: "delete", id: delId2, target: bId }); // no undelete between the two deletes
      engine.applyRemote({ kind: "undelete", id: undelId, target: bId }); // older than delId2 — must fail
      assertEqual(
        engine.text(),
        "AC",
        "an undelete older than the causally-latest delete must be a no-op",
      );
    },
  );

  // Catches M10_no_drain: pending must drain to a FIXPOINT, not just one pass.
  record(results, "ADV-09-style: pending drains to a fixpoint across a 3-deep causal chain", () => {
    const author = new Engine(1);
    const receiver = new Engine(2);
    const opA = author.localInsert(0, cp("A"));
    const opB = author.localInsert(1, cp("B"));
    const opC = author.localInsert(2, cp("C"));
    // Deliver in REVERSE causal order — a single drain pass only
    // resolves one level of the chain; a fixpoint resolves all three.
    receiver.applyRemote(opC);
    receiver.applyRemote(opB);
    receiver.applyRemote(opA);
    assertEqual(receiver.text(), "ABC", "text after reverse-order delivery");
    assertEqual(receiver.pending.length, 0, "pending after reverse-order delivery");
  });

  // Catches M1_rank_by_counter and M3_no_case_c indirectly, and serves
  // as a general sanity check: the exact §10.7 backward-typing trace.
  record(
    results,
    "ADV-14 (Engine Spec §10.7): backward typing produces contiguous runs (cbazyxX)",
    () => {
      const seed = new Engine(100);
      seed.localInsert(0, cp("X"));
      const low = new Engine(10);
      const high = new Engine(20);
      for (const node of seed.nodes) {
        const op = {
          kind: "insert",
          id: node.id,
          value: node.value,
          originLeft: node.originLeft,
          originRight: node.originRight,
          bind: node.bind,
        };
        low.applyRemote(op);
        high.applyRemote(op);
      }
      const lowOps = ["a", "b", "c"].map((ch) => low.localInsert(0, cp(ch)));
      const highOps = ["x", "y", "z"].map((ch) => high.localInsert(0, cp(ch)));
      for (const op of highOps) low.applyRemote(op);
      for (const op of lowOps) high.applyRemote(op);
      assertEqual(low.text(), "cbazyxX", "low replica text");
      assertEqual(high.text(), "cbazyxX", "high replica text");
    },
  );

  return results;
}
