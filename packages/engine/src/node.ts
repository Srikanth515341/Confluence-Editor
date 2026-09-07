import type { Identifier } from "./identifier.js";

/**
 * One atomic unit of document content (Engine Spec Definition 2.1 / §2.2).
 *
 * As of the Fugue port (2026-09-05, see CLAUDE.md's "Fugue port" entry —
 * replacing the YATA-family `integrate()` after FOUR distinct convergence
 * defects, R0008/R0009/R0010/R0011, were found across this project's own
 * hand-derived scan, the real published YATA algorithm, AND production
 * Yjs's own shipped code), a node's position is a fixed tree attachment —
 * `parent` + `side` — decided ONCE at creation and NEVER recomputed,
 * replacing the prior `originLeft`/`originRight` pair a scan window used
 * to re-resolve on every `integrate()` call (the exact mechanism R0010/
 * R0011 exploited: two nodes never directly compared could end up in
 * opposite relative order on different replicas). `parent` is the SAME
 * kind of causal-dependency reference `originLeft` was (a node this
 * insert cannot integrate without), but there is only ONE per insert now,
 * not two — Fugue's own correctness proof does not need a second,
 * separately-tracked right-boundary reference at all.
 *
 * Immutable-identity: id, value, parent, side, and bind never change after
 * creation (Invariant I2). Only deleted/deletedBy may change, and only via
 * tombstoning — a node is never physically removed from the structure
 * while it might still be a PARENT of some other node (Invariant I5's own
 * Fugue-era restatement: a node cannot be physically removed while it is
 * the `parent` of any node that isn't ALSO being removed — see
 * `Engine.collect()`'s own doc comment). Physical removal happens only
 * through garbage collection (Phase 21), under causal-stability conditions.
 */
export interface Node {
  /** Globally unique, totally ordered identity (Engine Spec §3, Invariant I1). */
  readonly id: Identifier;

  /** The Unicode scalar value (code point) this node carries — Engine Spec §2.3. */
  readonly value: number;

  /**
   * The node this one attached to at insertion time — Fugue's own single
   * causal-dependency reference, replacing `originLeft`/`originRight`.
   * `null` only for a node attached directly under the tree's own root
   * sentinel (never a real, externally-visible node) — meaning "no
   * dependency beyond the document's own existence."
   */
  readonly parent: Identifier | null;

  /**
   * Which side of `parent` this node attached to (Fugue's own
   * `createBetween` rule): `"R"` if this node became `parent`'s right
   * child (the ordinary case — nothing yet sits between `parent` and
   * whatever was previously its right neighbor), `"L"` if `parent` already
   * had a right child and this node instead became the LEFT child of the
   * leftmost descendant of that existing right child (Fugue's own
   * `createBetween` Case 2). In-order tree traversal (left children, then
   * self, then right children, each side in its own deterministic sibling
   * order) is what defines the total order — see `Engine`'s own internal
   * tree class for the full traversal.
   */
  readonly side: "L" | "R";

  /**
   * True iff `value` is a cluster-continuation scalar (a combining mark, ZWJ,
   * variation selector, or similar — Engine Spec Definition 2.5). Governs
   * the sibling-order tie-break among nodes attached to the SAME parent on
   * the SAME side (Engine Spec §4.4, Invariant I8) so a concurrent insert
   * can never split a grapheme cluster — Fugue's own reference algorithm
   * ties siblings purely by sender/replica id; bind-then-replica is this
   * project's own required domain-specific substitution for that rule,
   * the same category of adaptation `compareRank` was for the retired
   * YATA port (see `Engine`'s own tree class for the exact comparator and
   * its RFC NQ-2/I8 hand-trace).
   */
  readonly bind: boolean;

  /** Tombstone flag. `true` means this node is excluded from vis(S) (Definition 2.3). */
  deleted: boolean;

  /**
   * Attribution of the causally LATEST deletion of this node, as a
   * (counter, replica) pair — `null` iff `deleted` is `false`. Required to
   * resolve undo's resurrection question (Engine Spec §9.3 / PRD OQ-3):
   * whichever deletion is causally latest wins, determined by the same
   * total order as identifiers (Invariant I7).
   */
  deletedBy: Identifier | null;
}
