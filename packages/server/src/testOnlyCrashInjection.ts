// Phase 25 (Test Plan DUR-03) — test-only crash-injection registry.
//
// The phase brief's own reference text names 10 crash sites and asks for genuine SIGKILL
// process-kill injection at each, but explicitly sanctions an "acceptable alternative" when
// that's disproportionate: "explicit synchronous throw points at each site ... combined with
// an actual process restart for the server between test iterations, as long as the distinction
// between 'graceful error' and 'actual crash' doesn't matter for what's being verified
// (durability of already-committed state, which persists in Postgres regardless of how the
// process died)". That is exactly the case here — DUR-03 verifies Postgres durability and
// convergence after restart, neither of which depends on HOW the prior process instance ended.
// This module is that alternative: a one-shot, in-process armed-site switch, checked inline at
// each of the 10 named call sites (writePath.ts, operationStore.ts, snapshotter.ts,
// gcScheduler.ts). "Restart" itself is realized the same way Phase 16's own
// serverRestart.db.test.ts already established: a fresh DocumentCoordinator/CollabServer
// constructed against the SAME real Postgres database, not a literal new OS process — the
// durable state under test outlives the crash either way.
//
// Module-level mutable state, deliberately mirroring writePath.ts's own
// MUTATE_ACK_BEFORE_COMMIT_ENV precedent: a plain, test-armed global switch that costs one
// reference comparison in the shipped module and can never fire outside a test that explicitly
// calls `armCrashSite()` — no other code in this repository ever does.

export type CrashSite =
  | "afterFrameReceipt"
  | "afterAuthorization"
  | "afterApplyRemote"
  | "afterSeqAssignment"
  | "afterBroadcast"
  | "beforeCommit"
  | "afterCommit"
  | "afterAck"
  | "duringSnapshotWrite"
  | "duringGcCycle";

/** The 10 sites named verbatim (a)-(j) in Test Plan DUR-03, in that order. */
export const ALL_CRASH_SITES: readonly CrashSite[] = [
  "afterFrameReceipt",
  "afterAuthorization",
  "afterApplyRemote",
  "afterSeqAssignment",
  "afterBroadcast",
  "beforeCommit",
  "afterCommit",
  "afterAck",
  "duringSnapshotWrite",
  "duringGcCycle",
];

export class SimulatedCrash extends Error {
  readonly site: CrashSite;
  constructor(site: CrashSite) {
    super(`DUR-03 simulated crash at site "${site}"`);
    this.name = "SimulatedCrash";
    this.site = site;
  }
}

let armedSite: CrashSite | null = null;

/**
 * TEST-ONLY. Arms exactly one crash site to fire the NEXT time it's checked — one-shot, so a
 * test loop must re-arm per iteration rather than accidentally leaving a site permanently live.
 */
export function armCrashSite(site: CrashSite): void {
  armedSite = site;
}

/** TEST-ONLY. Disarms without waiting for a matching check — e.g. an iteration whose armed site was never actually reached before the operation it was attached to finished normally. */
export function disarmCrashSite(): void {
  armedSite = null;
}

/**
 * TEST-ONLY. True iff the most recently armed site has NOT fired yet. Some call sites (e.g.
 * `beforeCommit`, whose `SimulatedCrash` propagates through `operationStore.commitOperations`
 * and is then deliberately swallowed by `writePath.ts`'s own real "a commit failure is logged,
 * not rethrown" behavior, matching what a genuine database error would do) never let their
 * thrown exception reach a test's own `await` — checking `!isCrashSiteArmed()` after the call
 * is a reliable, site-agnostic way to confirm a crash actually fired, regardless of whether the
 * resulting exception happened to propagate all the way back to the caller.
 */
export function isCrashSiteArmed(): boolean {
  return armedSite !== null;
}

/**
 * Checked inline at each of the 10 real call sites DUR-03 names. A no-op (one reference
 * comparison) unless a test has armed exactly this site; auto-disarms on match so the SAME
 * simulated crash can never fire twice.
 */
export function maybeCrash(site: CrashSite): void {
  if (armedSite === site) {
    armedSite = null;
    throw new SimulatedCrash(site);
  }
}
