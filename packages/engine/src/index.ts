// OBSEQ convergence engine — public surface.
//
// Purity boundary: nothing in this package may import the DOM, network,
// storage, or a wall clock. Enforced two independent ways — see
// eslint.config.js (packages/engine override) and
// scripts/check-engine-purity.mjs — per PRD NG-3, RFC §4.4, Engine Spec §5
// (I0, C9).

export type { Identifier } from "./identifier.js";
export { compareIds, serializeId } from "./identifier.js";
export type { Node } from "./node.js";
export type {
  DeleteOperation,
  InsertOperation,
  Operation,
  UndeleteOperation,
} from "./operation.js";
export { isClusterContinuing } from "./grapheme.js";
export { Engine } from "./engine.js";
export type { ClockEvent, EngineStats } from "./engine.js";
export { assertInvariants, InvariantViolation } from "./invariants.js";
export type { AssertInvariantsOptions } from "./invariants.js";
