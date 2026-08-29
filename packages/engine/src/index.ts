// OBSEQ convergence engine — placeholder entry point.
//
// This package must remain pure for the lifetime of the project: no DOM, no
// network, no storage, no wall clock. That boundary is enforced two
// independent ways — see eslint.config.js (packages/engine override) and
// scripts/check-engine-purity.mjs — because a single enforcement mechanism
// can be silently disabled without anyone noticing.
//
// No feature code exists yet. The engine itself (identifiers, INTEGRATE,
// invariants I0-I9) is built starting Phase 1.

export const ENGINE_PACKAGE_NAME = "@collab-editor/engine";
