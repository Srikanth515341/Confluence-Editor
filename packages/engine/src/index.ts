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
export type { ClockEvent, CollectOptions, CollectResult, EngineStats } from "./engine.js";
export { assertInvariants, InvariantViolation } from "./invariants.js";
export type { AssertInvariantsOptions } from "./invariants.js";
// Block encoding (Engine Spec §7.5, Phase 20) — exported for
// @collab-editor/protocol's SNAPSHOT body encoder, which needs to group a
// flat, already-decoded Node[] sequence into the same maximal runs the
// live engine's own PositionIndex forms internally, for wire compression.
// `canFollowInBlock` is the only piece that operates on plain decoded
// Node[]; the rest are exported so a consumer that already HAS blocks
// (there currently is none outside packages/engine itself) isn't forced
// to reinvent them.
export type { Block } from "./block.js";
export { canFollowInBlock, decodeBlock, decodeNodeAt } from "./block.js";
