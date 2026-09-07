// Fuzz / mutation / network-fault / load harnesses.
//
// Phase 2 built the randomized-interleaving convergence harness (Test Plan
// §2.2) BEFORE the integration algorithm exists (Phase 3), so the
// algorithm is written against a working oracle from its first line
// rather than a harness that tests whatever the algorithm happens to do.

export const TESTKIT_PACKAGE_NAME = "@collab-editor/testkit";

export * from "./fuzz/index.js";
export {
  startFaultRelay,
  type FaultRelay,
  type FaultRelayOptions,
} from "./faultrelay/faultRelay.js";
