/**
 * The ten mutants (Test Plan §2.8), applied one at a time to a temporary
 * copy of packages/engine/src — never to the real source on disk. Each
 * `find` string is matched EXACTLY against the current engine.ts content;
 * loadMutantEngine.ts throws if it doesn't find exactly one occurrence,
 * so a mutant can never silently become a no-op if the source it targets
 * is refactored later.
 *
 * Patches supplied by the user directly from Test Plan §2.8 — these are
 * not derived or guessed; they are transcribed verbatim against the
 * actual source this repo contains (Phases 1 and 3).
 */

export interface MutantDefinition {
  readonly id: string;
  /** File the patch applies to, relative to packages/engine/src. */
  readonly file: "engine.ts";
  readonly description: string;
  readonly violatedInvariant: string;
  readonly find: string;
  readonly replace: string;
}

export const MUTANTS: readonly MutantDefinition[] = [
  {
    id: "M1_rank_by_counter",
    file: "engine.ts",
    description:
      "Disambiguator orders by Lamport counter instead of replica id — " +
      "two different replicas can coincidentally mint the same counter, " +
      "making the tie-break genuinely ambiguous (not just 'differently correct').",
    violatedInvariant:
      "I1 (identifier uniqueness is per-replica; counters alone are not globally unique) / Definition 4.2",
    find: "return [n.bind ? 0 : 1, n.id.r];",
    replace: "return [n.bind ? 0 : 1, n.id.c];",
  },
  {
    id: "M2_no_right_bound",
    file: "engine.ts",
    description:
      "Integration scan ignores originRight — reverts to the pre-fix prototype behavior " +
      "where the scan window is always [originLeft, end-of-document).",
    violatedInvariant: "I4 (origin presence at integration time) / I6 (scan-window determinism)",
    // Phase 19: `this.nodes.length` (an O(N) flat-array read) became `this.index.size`
    // (the PositionIndex's O(1) augmented count) — same target, new text.
    find:
      "    const rightIndex =\n" +
      "      node.originRight === null ? this.index.size : this.indexOfOrigin(node.originRight);",
    replace: "    const rightIndex = this.index.size;",
  },
  {
    id: "M3_no_case_c",
    file: "engine.ts",
    description:
      "Case C does not break; the scan runs past outer-region nodes instead of stopping.",
    violatedInvariant: "I6 (scan-window determinism) — Engine Spec §6.2 sub-case iii-d",
    // Anchored on just the closing lines rather than the whole Case C
    // comment block, so this patch survives comment-only edits to the
    // (fairly long) canary explanation above the `break` — only the
    // control-flow shape here is what M3 actually needs to change. Phase 19:
    // the final placement call became `this.index.insertAt(...)` (was
    // `this.nodes.splice(...)`) — same anchor, new trailing text.
    find: "          }\n          break;\n        }\n      }\n    }\n\n    this.index.insertAt(destIndex, node);",
    replace:
      "          }\n          // MUTANT M3_no_case_c: break removed — scan continues past the outer region.\n        }\n      }\n    }\n\n    this.index.insertAt(destIndex, node);",
  },
  {
    id: "M4_no_binding",
    file: "engine.ts",
    description:
      "Rank drops the binding component — a combining mark no longer sorts nearer its base.",
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
    // Phase 19: `node.deleted = true` (a direct field write) became `this.index.setDeleted(node,
    // true)` (the sole place that field is now written — see engine.ts's own comment there); the
    // physical-removal mutation itself now targets `this.index` too — `this.nodes` is a
    // GETTER as of Phase 19 (a fresh in-order traversal each call), so splicing IT would splice a
    // throwaway array and silently become a no-op, which would falsify this mutant's whole intent
    // (it must ACTUALLY remove the node from the live structure to violate I5).
    find:
      "    this.index.setDeleted(node, true);\n" +
      "    if (node.deletedBy === null || compareIds(op.id, node.deletedBy) > 0) {\n" +
      "      node.deletedBy = op.id;\n" +
      "    }\n" +
      "  }\n" +
      "\n" +
      "  /**\n" +
      "   * Structural inverse of applyDelete",
    replace:
      "    this.index.setDeleted(node, true);\n" +
      "    this.index.splice(this.index.indexOf(node), 1); // MUTANT M6_physical_delete\n" +
      "    if (node.deletedBy === null || compareIds(op.id, node.deletedBy) > 0) {\n" +
      "      node.deletedBy = op.id;\n" +
      "    }\n" +
      "  }\n" +
      "\n" +
      "  /**\n" +
      "   * Structural inverse of applyDelete",
  },
  {
    id: "M7_no_right_readiness",
    file: "engine.ts",
    description: "Readiness checks only originLeft, not originRight, before integrating an insert.",
    violatedInvariant: "I4 (origin presence at integration time) — Engine Spec §4.2",
    find:
      '    if (op.kind === "insert") {\n' +
      "      return this.isOriginPresent(op.originLeft) && this.isOriginPresent(op.originRight);\n" +
      "    }",
    replace:
      '    if (op.kind === "insert") {\n      return this.isOriginPresent(op.originLeft);\n    }',
  },
  {
    id: "M8_no_idempotence",
    file: "engine.ts",
    description:
      "The already-applied check is removed — a duplicate insert integrates a second time.",
    violatedInvariant: "I1 (identifier uniqueness) — Engine Spec §6.3",
    find:
      "  applyRemote(op: Operation): { readonly buffered: boolean } {\n" +
      "    if (this.applied.has(serializeId(op.id))) {\n" +
      "      return { buffered: false };\n" +
      "    }\n" +
      "    if (this.ready(op)) {",
    replace:
      "  applyRemote(op: Operation): { readonly buffered: boolean } {\n    if (this.ready(op)) {",
  },
  {
    id: "M9_delete_first_wins",
    file: "engine.ts",
    description: "deletedBy keeps the FIRST deletion instead of the causally latest.",
    violatedInvariant: "I7 (deletion attribution monotonicity) — Engine Spec §4.5 line 3",
    // Phase 19: same underlying source change as M6 above (`node.deleted = true` became
    // `this.index.setDeleted(node, true)`) — this mutant's OWN semantic is unchanged
    // (attribution logic, not tombstone visibility), so the replace text still calls
    // `this.index.setDeleted(node, true)` UNCHANGED (keeping the index's augmented
    // visibleCount bookkeeping correct — a stale count would be an unrelated confound, not
    // what I7's check is meant to catch) and only mutates the `deletedBy` attribution rule.
    find:
      "    this.index.setDeleted(node, true);\n" +
      "    if (node.deletedBy === null || compareIds(op.id, node.deletedBy) > 0) {\n" +
      "      node.deletedBy = op.id;\n" +
      "    }\n" +
      "  }\n" +
      "\n" +
      "  /**\n" +
      "   * Structural inverse of applyDelete",
    replace:
      "    const alreadyDeleted = node.deleted; // MUTANT M9_delete_first_wins\n" +
      "    this.index.setDeleted(node, true);\n" +
      "    if (!alreadyDeleted) {\n" +
      "      node.deletedBy = op.id;\n" +
      "    }\n" +
      "  }\n" +
      "\n" +
      "  /**\n" +
      "   * Structural inverse of applyDelete",
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
