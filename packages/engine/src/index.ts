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
// Block encoding (Engine Spec §7.5, Phase 20) and PositionIndex (Phase 19) are RETIRED as of
// the Fugue port (2026-09-05, CLAUDE.md's "Fugue port" entry) — both were built around the
// flat, consecutive-counter, originLeft/originRight-chained structure the retired YATA-family
// scan produced, which a Fugue tree does not have. `@collab-editor/protocol`'s own
// `snapshotBody.ts` (SNAPSHOT wire encoding) still imports the retired `Block`/
// `canFollowInBlock`/`decodeBlock` exports — this is a KNOWN, DISCLOSED, OUT-OF-SESSION-SCOPE
// break (see CLAUDE.md): a real block-run-length-equivalent compression scheme for a Fugue
// tree needs its own from-scratch design, not an adaptation of the retired one, and is
// deferred to whichever future phase migrates the wire protocol itself to Fugue's own
// `(id, value, parent, side)` operation shape.
