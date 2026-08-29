import type { Identifier } from "./identifier.js";

/**
 * Engine Spec §4.1. No operation carries a numeric index — every position
 * is expressed relative to stable identifiers (originLeft/originRight for
 * an insert, `target` for a delete/undelete), which is what makes an
 * operation meaningful regardless of how many concurrent edits landed
 * before it arrives (PRD FR-CE-1).
 */
export interface InsertOperation {
  readonly kind: "insert";
  readonly id: Identifier;
  readonly value: number;
  readonly originLeft: Identifier | null;
  readonly originRight: Identifier | null;
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
