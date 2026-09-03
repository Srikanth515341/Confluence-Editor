/**
 * Harness configuration for one trial (Test Plan §2.2). Each named export
 * below exists because it stresses a DIFFERENT clause of the (eventual)
 * integration algorithm — see the per-config comments.
 */
export interface TrialConfig {
  readonly name: string;
  readonly minReplicas: number;
  readonly maxReplicas: number;
  readonly rounds: number;
  readonly opsPerRoundMin: number;
  readonly opsPerRoundMax: number;
  /** Test Plan §2.2: 70% insert / 30% delete (no formatting operations exist yet). */
  readonly insertWeight: number;
  /**
   * Collision bias, in visible-index positions. A UNIFORM draw over the
   * whole document wastes the fuzz budget on the case that already works
   * (Test Plan §2.2) — width 1 means "every edit at the same position."
   */
  readonly hotRegionWidth: number;
  /** Duplicate-delivery rate. Test Plan §2.2: a consequence of correct retry behaviour, not a network defect. */
  readonly duplicateRate: number;
  /** C6 only: pre-skew each replica's Lamport clock before generating any operations. */
  readonly clockSkew: boolean;
  /**
   * `"deferred-shuffled"` (C1-C6, the original design): every operation for the WHOLE trial
   * is generated first — each replica building its own document purely from its own local
   * state, never seeing any other replica's nodes — and only delivered afterward, via one
   * global Fisher-Yates shuffle. `"immediate"` (C7 only): each operation is broadcast to
   * every other replica the instant it's minted, before the next operation is generated —
   * the ordinary shape of real, live multi-user editing (a replica typing WHILE seeing
   * peers' very-recent edits). These are NOT equivalent for correctness purposes: R0008
   * (2026-09-02) found that deferred-shuffled delivery makes it structurally IMPOSSIBLE for
   * an operation to ever anchor to a peer's node (no replica has seen any peer's node until
   * generation is entirely done), which is exactly the precondition Engine Spec §6.2
   * sub-case iii-d's flaw needed — C1-C6 could never reach that bug class, at any seed
   * count, no matter how large. See CLAUDE.md's "Engine Spec §6.2 sub-case iii-d
   * correction" entry and C7_IMMEDIATE_DELIVERY below.
   */
  readonly deliveryMode: "deferred-shuffled" | "immediate";
}

const DEFAULTS = {
  opsPerRoundMin: 1,
  opsPerRoundMax: 4,
  insertWeight: 0.7,
  clockSkew: false,
  deliveryMode: "deferred-shuffled",
} as const;

/** General baseline: moderate collision, moderate duplication. */
export const C1_BASELINE: TrialConfig = {
  ...DEFAULTS,
  name: "C1-baseline",
  minReplicas: 2,
  maxReplicas: 5,
  rounds: 12,
  hotRegionWidth: 4,
  duplicateRate: 0.05,
};

/** Maximum collision: every edit lands at the same position. Stresses Engine Spec §4.3 Case A. */
export const C2_COLLISION: TrialConfig = {
  ...DEFAULTS,
  name: "C2-collision",
  minReplicas: 2,
  maxReplicas: 5,
  rounds: 14,
  hotRegionWidth: 1,
  duplicateRate: 0.05,
};

/** Heavy deletion + high duplication: stresses tombstone anchoring (Invariant I5) and idempotence. */
export const C3_DELETE_HEAVY: TrialConfig = {
  ...DEFAULTS,
  name: "C3-delete-heavy",
  minReplicas: 5,
  maxReplicas: 5,
  rounds: 14,
  hotRegionWidth: 2,
  duplicateRate: 0.2,
};

/** Long causal chains over few replicas: stresses Case B nesting (Engine Spec §4.3). */
export const C4_DEEP: TrialConfig = {
  ...DEFAULTS,
  name: "C4-deep",
  minReplicas: 3,
  maxReplicas: 3,
  rounds: 25,
  hotRegionWidth: 3,
  duplicateRate: 0.05,
};

/** PRD A-4's maximum designed concurrency (8 editors). */
export const C5_WIDE: TrialConfig = {
  ...DEFAULTS,
  name: "C5-wide",
  minReplicas: 8,
  maxReplicas: 8,
  rounds: 12,
  hotRegionWidth: 2,
  duplicateRate: 0.1,
};

/** Replica clocks pre-advanced by a large delta — ordering must be unaffected (PRD FR-CE-2). */
export const C6_SKEW: TrialConfig = {
  ...DEFAULTS,
  name: "C6-skew",
  minReplicas: 4,
  maxReplicas: 4,
  rounds: 15,
  hotRegionWidth: 2,
  duplicateRate: 0.05,
  clockSkew: true,
};

/**
 * Immediate-delivery variant of C1's own shape (Engine Spec §6.2 sub-case iii-d correction,
 * R0008, 2026-09-02). Same replica count/rounds/hot-region width/insert-weight as
 * C1_BASELINE — the ONLY axis changed is `deliveryMode`. This is not an optional stress
 * config: it is the ONLY configuration in this file capable of reaching the Case C rank-
 * violation bug class fixed by that correction (empirically confirmed: C1-C6 combined,
 * tens of thousands of seeds across this project's history, never reached it even once;
 * an immediate-delivery variant of C1's own shape alone reached it in >80% of seeds before
 * the fix). Every future change to `integrate()` must be checked against this config, not
 * only C1-C6.
 */
export const C7_IMMEDIATE_DELIVERY: TrialConfig = {
  ...DEFAULTS,
  name: "C7-immediate-delivery",
  minReplicas: 2,
  maxReplicas: 5,
  rounds: 12,
  hotRegionWidth: 4,
  duplicateRate: 0.05,
  deliveryMode: "immediate",
};

export const ALL_CONFIGS: readonly TrialConfig[] = [
  C1_BASELINE,
  C2_COLLISION,
  C3_DELETE_HEAVY,
  C4_DEEP,
  C5_WIDE,
  C6_SKEW,
  C7_IMMEDIATE_DELIVERY,
];
