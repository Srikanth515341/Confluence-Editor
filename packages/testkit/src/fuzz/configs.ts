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
}

const DEFAULTS = {
  opsPerRoundMin: 1,
  opsPerRoundMax: 4,
  insertWeight: 0.7,
  clockSkew: false,
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

export const ALL_CONFIGS: readonly TrialConfig[] = [
  C1_BASELINE,
  C2_COLLISION,
  C3_DELETE_HEAVY,
  C4_DEEP,
  C5_WIDE,
  C6_SKEW,
];
