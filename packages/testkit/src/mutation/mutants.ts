/**
 * The mutants (Test Plan §2.8), applied one at a time to a temporary
 * copy of packages/engine/src — never to the real source on disk. Each
 * `find` string is matched EXACTLY against the current source content;
 * loadMutantEngine.ts throws if it doesn't find exactly one occurrence,
 * so a mutant can never silently become a no-op if the source it targets
 * is refactored later.
 *
 * *** FUGUE PORT RE-DERIVATION (2026-09-05) — READ BEFORE TRUSTING THIS FILE'S OWN SHAPE ***
 * The original ten patches were supplied by the user directly from Test Plan §2.8, transcribed
 * verbatim against the Case A/B/C YATA-family source that existed at the time — NOT derived or
 * guessed. As of the Fugue port (CLAUDE.md's "Fugue port" entry), `engine.ts`'s own placement
 * algorithm was replaced OUTRIGHT — there is no scan, no window, no `leftIndex`/`rightIndex`,
 * no `compareRank` inside `integrate()` at all anymore (placement is now a single, O(1)-ish
 * decision in `fugueTree.ts`'s `decidePlacement`/`attach`, given an already-resolved
 * `parent`/`side`). Eight of the ten mutants translate directly (their target invariant and
 * mechanism are independent of HOW placement is decided — clock, readiness, delete
 * attribution, tombstoning, idempotence, draining, and the sibling-rank tie-break all still
 * exist in recognizably the same shape). TWO — `M2_no_right_bound` and `M3_no_case_c` — do
 * NOT: both specifically targeted the retired scan's own two-sided-window bookkeeping (a
 * "right bound" to ignore, a "Case C" scan-termination branch to blunt), and Fugue's algorithm
 * has no analogous mechanism to sabotage in the same way — there is no "right bound" (Fugue
 * needs only ONE causal reference per insert, `parent`) and no "scan" at all (placement is a
 * single lookup, not an iterative window walk). Rather than invent replacement patches under
 * this file's own authority — the header comment above is explicit that these patches are
 * "not derived or guessed" but SUPPLIED — M2 and M3 are LEFT OUT of `MUTANTS` below, not
 * force-fit to a mechanism that no longer exists. This is a real, disclosed reduction from
 * ten mutants to eight, reported honestly in `docs/mutation-matrix.md`'s own generated output
 * rather than silently absorbed. Restoring a tenth-and-ninth mutant meaningfully requires two
 * NEW, Fugue-native patches sourced the same way the original ten were (a real decision about
 * which Fugue-specific defect class is worth targeting, supplied deliberately) — not something
 * this file should decide unilaterally.
 */

export interface MutantDefinition {
  readonly id: string;
  /** File the patch applies to, relative to packages/engine/src. */
  readonly file: "engine.ts" | "fugueTree.ts";
  readonly description: string;
  readonly violatedInvariant: string;
  readonly find: string;
  readonly replace: string;
}

export const MUTANTS: readonly MutantDefinition[] = [
  {
    id: "M1_rank_by_counter",
    file: "fugueTree.ts",
    description:
      "Sibling-order disambiguator orders by Lamport counter instead of replica id — " +
      "two different replicas can coincidentally mint the same counter, " +
      "making the tie-break genuinely ambiguous (not just 'differently correct'). " +
      "Fugue port (2026-09-05): re-anchored from engine.ts's retired `rank()` to " +
      "fugueTree.ts's `siblingRank()`, the direct successor holding the identical " +
      "[bind?0:1, replicaId] tuple — same mechanism, same violated invariant, new home.",
    violatedInvariant:
      "I1 (identifier uniqueness is per-replica; counters alone are not globally unique) / Definition 4.2",
    find: "return [n.bind ? 0 : 1, n.id.r];",
    replace: "return [n.bind ? 0 : 1, n.id.c];",
  },
  {
    id: "M4_no_binding",
    file: "fugueTree.ts",
    description:
      "Sibling-order rank drops the binding component — a combining mark no longer sorts " +
      "nearer its base. Fugue port: re-anchored from engine.ts's retired `rank()` to " +
      "fugueTree.ts's `siblingRank()` (same note as M1_rank_by_counter above).",
    violatedInvariant: "I8 (grapheme cluster contiguity)",
    find: "return [n.bind ? 0 : 1, n.id.r];",
    replace: "return [1, n.id.r];",
  },
  {
    id: "M5_double_tick",
    file: "engine.ts",
    description:
      "observe() also increments the clock — the exact defect Engine Spec §3.4 documents " +
      "(a prior real bug), reintroduced deliberately here.",
    violatedInvariant: "I0 (clock advances exactly once per minted identifier)",
    find:
      "  observe(remoteCounter: number): void {\n" +
      "    this.clock = Math.max(this.clock, remoteCounter);\n" +
      '    this.clockEvents.push({ kind: "observe", remoteCounter });\n' +
      "  }",
    replace:
      "  observe(remoteCounter: number): void {\n" +
      "    this.clock = Math.max(this.clock, remoteCounter) + 1;\n" +
      '    this.clockEvents.push({ kind: "observe", remoteCounter });\n' +
      "  }",
  },
  {
    id: "M6_physical_delete",
    file: "engine.ts",
    description: "Delete removes the node from S instead of tombstoning it.",
    violatedInvariant: "I5 (tombstone retention)",
    // Fugue port: applyDelete's own tombstone write is now `this.tree.setDeleted(...)`
    // (FugueTree, not the retired PositionIndex). Physical removal now targets
    // `FugueTree.remove(id)` directly (this project's own new, real GC primitive, Phase 21 —
    // NOT a reused test-only mechanism), which actually unlinks the node from the live tree —
    // `this.nodes` remains a GETTER (a fresh in-order traversal each call), so this mutation
    // must call into the tree itself, never operate on a throwaway array copy.
    find:
      "    const newDeletedBy =\n" +
      "      node.deletedBy === null || compareIds(op.id, node.deletedBy) > 0 ? op.id : node.deletedBy;\n" +
      "    this.tree.setDeleted(op.target, true, newDeletedBy);\n" +
      "  }\n" +
      "\n" +
      "  /**\n" +
      "   * Structural inverse of applyDelete",
    replace:
      "    const newDeletedBy =\n" +
      "      node.deletedBy === null || compareIds(op.id, node.deletedBy) > 0 ? op.id : node.deletedBy;\n" +
      "    this.tree.setDeleted(op.target, true, newDeletedBy);\n" +
      "    try { this.tree.remove(op.target); } catch { /* MUTANT M6_physical_delete: best-effort */ }\n" +
      "  }\n" +
      "\n" +
      "  /**\n" +
      "   * Structural inverse of applyDelete",
  },
  {
    id: "M7_no_readiness_check",
    file: "engine.ts",
    description:
      "Readiness for an insert always returns true, never actually checking whether its " +
      "`parent` is present. Fugue port re-derivation: the retired M7_no_right_readiness " +
      "mutant specifically dropped the originRight HALF of a two-part readiness check; " +
      "Fugue's own ready() has only ONE causal dependency (`parent`) to begin with (a real " +
      "simplification the port itself introduced, not something this mutant works around), " +
      "so the direct analogue is dropping that ONE check entirely rather than one of two.",
    violatedInvariant: "I4 (origin presence at integration time) — Engine Spec §4.2",
    find:
      '    if (op.kind === "insert") {\n' +
      "      return this.isOriginPresent(op.parent);\n" +
      "    }",
    replace: '    if (op.kind === "insert") {\n      return true;\n    }',
  },
  {
    id: "M8_no_idempotence",
    file: "engine.ts",
    description:
      "The already-applied check is removed — a duplicate insert integrates a second time.",
    violatedInvariant: "I1 (identifier uniqueness) — Engine Spec §6.3",
    find:
      "    if (this.applied.has(serializeId(op.id))) {\n" +
      "      return { buffered: false };\n" +
      "    }\n" +
      "    if (this.ready(op)) {",
    replace: "    if (this.ready(op)) {",
  },
  {
    id: "M9_delete_first_wins",
    file: "engine.ts",
    description: "deletedBy keeps the FIRST deletion instead of the causally latest.",
    violatedInvariant: "I7 (deletion attribution monotonicity) — Engine Spec §4.5 line 3",
    find:
      "    const newDeletedBy =\n" +
      "      node.deletedBy === null || compareIds(op.id, node.deletedBy) > 0 ? op.id : node.deletedBy;",
    replace:
      "    const newDeletedBy = node.deletedBy === null ? op.id : node.deletedBy; // MUTANT M9_delete_first_wins",
  },
  {
    id: "M10_no_drain",
    file: "engine.ts",
    description: "The pending buffer is drained only once, not to a fixpoint.",
    violatedInvariant: "I9 (pending buffer drains at quiescence) — Engine Spec §4.2 Rule 4.2",
    find: "    let progressed = true;\n    while (progressed) {",
    replace: "    let progressed = true;\n    for (let pass = 0; pass < 1; pass++) {",
  },
];
