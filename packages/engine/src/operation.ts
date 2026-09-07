import type { Identifier } from "./identifier.js";

/**
 * Engine Spec §4.1. No operation carries a numeric index — every position
 * is expressed relative to stable identifiers (`parent`/`side` for an
 * insert, `target` for a delete/undelete), which is what makes an
 * operation meaningful regardless of how many concurrent edits landed
 * before it arrives (PRD FR-CE-1).
 *
 * As of the Fugue port (2026-09-05): `parent`/`side` replace the prior
 * `originLeft`/`originRight` pair. This is a REQUIRED shape change, not a
 * stylistic one — see CLAUDE.md's "Fugue port" entry for the full
 * reasoning, but in short: a receiver cannot safely re-derive Fugue's own
 * `parent`/`side` decision independently from `originLeft` alone using its
 * own local view (two replicas with different partial knowledge of
 * concurrent inserts could derive different placements for the same
 * operation, and since a Fugue node's tree attachment is permanent once
 * set, that would cause silent, permanent divergence — exactly the
 * mechanism this port exists to close). `parent`/`side` must therefore be
 * decided ONCE, by the minting replica, and carried on the operation
 * itself, the same way Fugue's own real wire format does.
 */
export interface InsertOperation {
  readonly kind: "insert";
  readonly id: Identifier;
  readonly value: number;
  /** The node this insert attaches to — Fugue's single causal-dependency reference. `null` only for a node attached directly under the tree's own root (document-empty case). */
  readonly parent: Identifier | null;
  /** Which side of `parent` this node attaches to — see `Node.side`'s own doc comment. */
  readonly side: "L" | "R";
  readonly bind: boolean;
}

/** Engine Spec §4.1/§4.5. `id` is the delete's own identifier — used by the causally-latest `deletedBy` rule. */
export interface DeleteOperation {
  readonly kind: "delete";
  readonly id: Identifier;
  readonly target: Identifier;
}

/**
 * Engine Spec §4.1. Structural inverse of Delete. Full resurrection
 * semantics (interaction with redo history, Engine Spec §9.3) are Phase 36
 * — this phase defines only the type and its causal-readiness/apply shape.
 */
export interface UndeleteOperation {
  readonly kind: "undelete";
  readonly id: Identifier;
  readonly target: Identifier;
}

export type Operation = InsertOperation | DeleteOperation | UndeleteOperation;
