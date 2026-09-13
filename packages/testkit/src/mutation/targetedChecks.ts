import type { EngineLike, LoadedEngineModule } from "./loadMutantEngine.js";

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
        parent: node.parent,
        side: node.side,
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
        parent: node.parent,
        side: node.side,
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

  // Fugue port (2026-09-05) re-derivation: the retired M7_no_right_readiness mutant tested
  // readiness against the retired originRight dependency specifically — Fugue has exactly
  // ONE causal dependency per insert (`parent`), so the direct analogue is simply "an insert
  // whose parent has never been applied must buffer, never integrate against a nonexistent
  // origin" (Engine Spec §4.2/Definition 4.1, Fugue-era single-reference restatement).
  record(results, "readiness: an insert whose parent is missing must buffer, not apply", () => {
    const receiver = new Engine(1);
    const phantomId = { c: 999, r: 999 }; // never applied anywhere
    const result = receiver.applyRemote({
      kind: "insert",
      id: { c: 1, r: 1 },
      value: cp("x"),
      parent: phantomId,
      side: "R",
      bind: false,
    });
    if (!result.buffered) {
      throw new Error("insert with a missing parent applied immediately instead of buffering");
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
        parent: node.parent,
        side: node.side,
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

  // Catches M9_delete_first_wins. CORRECTED (Phase 36, 2026-09-13): the ORIGINAL version of
  // this check minted BOTH deletes AND the undelete from the SAME shared replica, relying on a
  // CAUSAL-ORDER comparison between the undelete's own id and node.deletedBy (an undelete
  // "older than the causally-latest delete must be a no-op"). That was only ever a valid test
  // of the Phase-3-era placeholder rule for Engine Spec §9.3/PRD OQ-3 — the REAL, now-specified
  // Engine Spec §4.6 rule is a plain REPLICA-EQUALITY check ("if n.deletedBy.replica = op.by"),
  // never a causal-order comparison against the undelete's own identifier. Hand-traced during
  // Phase 36: under the real rule, the original single-replica construction would no longer
  // discriminate this mutant at all (an undelete from the SAME replica that authored BOTH
  // deletes always matches `deletedBy.r`, whichever delete's attribution — first or
  // latest — happens to be current, since both deletes share that one replica).
  //
  // Corrected to use two GENUINELY DIFFERENT replicas for the two competing deletes, matching
  // this project's own real per-user-undo model (an Undelete is only ever minted by the SAME
  // replica invoking undo of ITS OWN delete — Engine Spec §9.1's `by: replicaId`). What now
  // discriminates the mutant: an undelete from the FIRST deleter's own replica (X) must FAIL
  // under CORRECT attribution (the causally-latest delete is Y's, a different replica) but
  // WRONGLY SUCCEED under "first wins" (which keeps X's own attribution regardless of Y's later
  // delete) — see `tests/regression/R0014`'s CLAUDE.md cross-reference and the identical fix
  // applied to `adversarial.test.ts`'s own ADV-21 for the full account of this correction.
  record(
    results,
    "deletedBy is the causally-latest delete's OWN REPLICA, not the first, across two deletes from different replicas",
    () => {
      const seed = new Engine(100);
      seed.localInsert(0, cp("A"));
      seed.localInsert(1, cp("B"));
      seed.localInsert(2, cp("C"));
      const bId = seed.nodes[1]!.id;

      function relayInsertsInto(engine: EngineLike): void {
        for (const node of seed.nodes) {
          engine.applyRemote({
            kind: "insert",
            id: node.id,
            value: node.value,
            parent: node.parent,
            side: node.side,
            bind: node.bind,
          });
        }
      }

      const engineX = new Engine(10); // X — deletes FIRST (in wall-clock terms), concurrently with Y
      const engineY = new Engine(20); // Y — deletes SECOND; a counter tie is broken by replica id (20 > 10), so Y's delete is causally LATER
      relayInsertsInto(engineX);
      relayInsertsInto(engineY);
      const delOpX = engineX.localDelete(1, 1)[0]!;
      const delOpY = engineY.localDelete(1, 1)[0]!;

      const receiver = new Engine(1);
      relayInsertsInto(receiver);
      receiver.applyRemote(delOpX); // first delete applied
      receiver.applyRemote(delOpY); // second, causally-later delete applied — correct engine: deletedBy becomes Y's
      // An undelete FROM X (the FIRST deleter's own replica) must be a NO-OP under correct
      // attribution (deletedBy is Y's, not X's) — but would WRONGLY SUCCEED under M9's "first
      // wins" mutation (which keeps deletedBy = X's own delete regardless of Y's later one).
      receiver.applyRemote({ kind: "undelete", id: { c: 9999, r: 10 }, target: bId });
      assertEqual(
        receiver.text(),
        "AC",
        "an undelete from the replica whose delete was NOT the causally-latest one must be a no-op",
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
          parent: node.parent,
          side: node.side,
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
