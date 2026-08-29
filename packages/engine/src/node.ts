import type { Identifier } from "./identifier.js";

/**
 * One atomic unit of document content (Engine Spec Definition 2.1 / §2.2).
 *
 * Immutable-identity: id, value, originLeft, originRight, and bind never
 * change after creation (Invariant I2). Only deleted/deletedBy may change,
 * and only via tombstoning — a node is never physically removed from the
 * structure while it might still be referenced as an origin (Invariant I5,
 * worked trace Engine Spec §10.3). Physical removal happens only through
 * garbage collection (Phase 21), under causal-stability conditions.
 */
export interface Node {
  /** Globally unique, totally ordered identity (Engine Spec §3, Invariant I1). */
  readonly id: Identifier;

  /** The Unicode scalar value (code point) this node carries — Engine Spec §2.3. */
  readonly value: number;

  /** Identifier of the node immediately left of this one at insertion time. `null` = ⊥ (document start). */
  readonly originLeft: Identifier | null;

  /** Identifier of the node immediately right of this one at insertion time. `null` = ⊥ (document end). */
  readonly originRight: Identifier | null;

  /**
   * True iff `value` is a cluster-continuation scalar (a combining mark, ZWJ,
   * variation selector, or similar — Engine Spec Definition 2.5). Governs
   * the disambiguator's tie-break (Engine Spec §4.4, Invariant I8) so a
   * concurrent insert can never split a grapheme cluster.
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
