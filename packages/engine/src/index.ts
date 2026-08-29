// OBSEQ convergence engine — public surface.
//
// Purity boundary: nothing in this package may import the DOM, network,
// storage, or a wall clock. Enforced two independent ways — see
// eslint.config.js (packages/engine override) and
// scripts/check-engine-purity.mjs — per PRD NG-3, RFC §4.4, Engine Spec §5
// (I0, C9).

export type { Identifier } from "./identifier.js";
export { compareIds } from "./identifier.js";
export type { Node } from "./node.js";
export type { Operation } from "./operation.js";
export { isClusterContinuing } from "./grapheme.js";
export { Engine } from "./engine.js";
export type { EngineStats } from "./engine.js";
