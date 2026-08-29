/**
 * The contract the convergence harness needs from a replica under test.
 * Mirrors the shape Engine Spec §11.2 defines for the real engine's
 * upward interface (localInsert / localDelete / applyRemote / materialize
 * / pendingCount), so this harness is written against what the engine
 * SHOULD eventually expose — not against a fiction invented for testing.
 * Phase 3 wires the real Engine into exactly this contract.
 *
 * `Op` is generic and opaque to the harness ON PURPOSE: the harness never
 * inspects an operation's contents, only shuffles, duplicates, and
 * redelivers whatever localInsert()/localDelete() returned. What an `Op`
 * actually IS is entirely the adapter's business — this is what lets the
 * exact same harness run against a throwaway toy engine and, later, the
 * real one, without the harness knowing or caring which.
 */
export interface ReplicaAdapter<Op> {
  readonly replicaId: number;

  /** Applies locally and returns the operation to broadcast. Never blocks (PRD FR-CE-6). */
  localInsert(visibleIndex: number, value: number): Op;

  /** Applies locally and returns one operation per removed unit. */
  localDelete(visibleIndex: number, count: number): readonly Op[];

  /**
   * Applies a remote operation. `buffered: true` means the operation's
   * causal dependencies were unmet and it was queued rather than applied —
   * this is NORMAL (Engine Spec §4.2), never an error.
   */
  applyRemote(op: Op): { readonly buffered: boolean };

  /** Materialized document (Engine Spec Definition 2.4). */
  text(): string;

  /** Total node count including tombstones — the harness's structural-equality assertion. */
  structureLength(): number;

  /** Operations still buffered awaiting a causal dependency. MUST be 0 at quiescence (Invariant I9). */
  pendingCount(): number;

  /**
   * OPTIONAL. Pre-advances this replica's Lamport clock by `delta` before
   * any operations are generated (Engine Spec §3.2 `observe()`), so
   * config C6-skew can prove ordering is unaffected by wildly different
   * starting clocks across replicas (PRD FR-CE-2). Adapters that don't
   * expose this yet simply skip the skew — it is additive, never required
   * for a trial to run.
   */
  preSkewClock?(delta: number): void;
}

export type ReplicaFactory<Op> = (replicaId: number) => ReplicaAdapter<Op>;
