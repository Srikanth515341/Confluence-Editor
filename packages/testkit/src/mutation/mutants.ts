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
      "Case C never breaks — even when `other` does NOT outrank `node`, the scan keeps " +
      "running past it instead of stopping there.",
    // Engine Spec §6.2 sub-case iii-d correction (R0008, 2026-09-02): Case C now performs a
    // real rank check (the fix for the bug this correction addresses) instead of an
    // unconditional break. M3's own intent is unchanged in spirit — "the scan fails to stop
    // where it should" — but its anchor and violated-invariant citation both had to move:
    // the OLD anchor text (an unconditional `break` immediately following a throw) no longer
    // exists; the `break` M3 now needs to remove/neutralize is the one in Case C's `else`
    // branch (taken when `other` does NOT outrank `node` — the case where stopping is
    // correct). The old citation ("Engine Spec §6.2 sub-case iii-d") is RETIRED, not
    // reused — that claim is now known incorrect and is no longer what this scan-window
    // logic asserts; I6 (scan-window determinism) is what M3 actually violates.
    violatedInvariant: "I6 (scan-window determinism)",
    find:
      "          if (compareRank(other, node) < 0) {\n" +
      "            destIndex = i + 1;\n" +
      "            conflicting.clear();\n" +
      "          } else {\n" +
      "            break;\n" +
      "          }\n" +
      "        }",
    replace:
      "          if (compareRank(other, node) < 0) {\n" +
      "            destIndex = i + 1;\n" +
      "            conflicting.clear();\n" +
      "          } else {\n" +
      "            // MUTANT M3_no_case_c: break removed — scan continues past the outer region.\n" +
      "          }\n" +
      "        }",
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
    // Phase 20: applyDelete's body was rewritten around block storage — the tombstone write is
    // now `this.index.setDeleted(op.target, true, newDeletedBy)` (identifier-keyed, deletedBy
    // computed and passed in one call, not a separate `node.deleted = true` field write). The
    // physical-removal mutation now targets `this.index.splice`/`this.index.indexOf` directly
    // (both identifier/position-based as of Phase 20) — `this.nodes` remains a GETTER (a fresh
    // in-order traversal each call, unchanged since Phase 19), so splicing IT would splice a
    // throwaway array and silently become a no-op, which would falsify this mutant's whole intent
    // (it must ACTUALLY remove the node from the live structure to violate I5).
    find:
      "    const newDeletedBy =\n" +
      "      node.deletedBy === null || compareIds(op.id, node.deletedBy) > 0 ? op.id : node.deletedBy;\n" +
      "    this.index.setDeleted(op.target, true, newDeletedBy);\n" +
      "  }\n" +
      "\n" +
      "  /**\n" +
      "   * Structural inverse of applyDelete",
    replace:
      "    const newDeletedBy =\n" +
      "      node.deletedBy === null || compareIds(op.id, node.deletedBy) > 0 ? op.id : node.deletedBy;\n" +
      "    this.index.setDeleted(op.target, true, newDeletedBy);\n" +
      "    const pos = this.index.indexOf(op.target); // MUTANT M6_physical_delete\n" +
      "    if (pos !== undefined) {\n" +
      "      this.index.splice(pos, 1);\n" +
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
    // Phase 20: applyDelete now computes `newDeletedBy` as its OWN local expression, passed
    // into `this.index.setDeleted` in one call (rather than a separate `node.deletedBy = op.id`
    // field write afterward, Phase 3-19's shape). This mutant's semantic is unchanged
    // (attribution logic, not tombstone visibility) — the replace text targets ONLY that
    // computation, keeping `this.index.setDeleted(op.target, true, newDeletedBy)` itself
    // otherwise identical so the index's own visibleCount bookkeeping stays correct (a stale
    // count would be an unrelated confound, not what I7's check is meant to catch).
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
