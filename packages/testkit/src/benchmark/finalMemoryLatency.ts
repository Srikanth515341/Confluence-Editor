import { Engine, type DeleteOperation, type Identifier } from "@collab-editor/engine";

/**
 * Phase 25 — Milestone M2, Test Plan M8-a: "final memory and apply-latency measurement at the
 * same 100,000-op/~10,000-visible scenario already benchmarked in Phases 19-21. Reuse that
 * existing benchmark infrastructure." "Final" here specifically means WITH Phase 21's real
 * tombstone GC actually applied — Phase 20's own M8-b measurement (`compression.ts`,
 * `buildMemoryTestDocument`) explicitly named GC as "the next, and likely only real, lever" for
 * getting this scenario's memory footprint down, since block compression alone cannot merge
 * tombstones minted by separate single-character `DeleteOperation`s (Engine Spec §4.1) even
 * when they're deleted together and sit contiguously.
 *
 * `buildMemoryTestDocument` itself CANNOT be reused unmodified for this measurement: its
 * deletes go through `Engine.localDelete()`, which mints and applies a `DeleteOperation`
 * directly with NO `context` argument — and `Engine.collect()`'s own doc comment is explicit
 * that a node with no recorded delete-context "can never satisfy condition 2 and is therefore
 * never collectible." A tombstone built that way is permanently GC-ineligible, by design (this
 * is exactly what makes collection opt-in and safe for every other engine-level test in this
 * project that never supplies GC context at all). This file's own fixture instead applies each
 * delete via `applyRemote(op, context)` — the same mechanism the real server's write path uses
 * (writePath.ts) — with synthetic `seq`/`atMs` values, so `collect()` has real context to work
 * with.
 *
 * The delete SHAPE also matters, per a real, hard-won lesson from Phase 21's own M8-c DoD test
 * (see that phase's own completed-phase entry, bug #5): deleting a PREFIX of a single unbroken
 * append chain makes every tombstone in that prefix permanently anchored-to by whatever live
 * content immediately follows it (Engine Spec I4/I5 — a live node's origin must never be
 * removed out from under it), which can make collection either impossible or pathologically
 * slow (an 853-SECOND fixpoint sweep was measured for that exact shape). This fixture instead
 * appends `targetVisible` characters FIRST (these stay live forever), then appends
 * `totalOps - targetVisible` MORE characters strictly AFTER them (same unbroken chain, same
 * replica), then deletes ALL of that trailing suffix, from the visible END inward — Phase 21's
 * own established GC-friendly shape ("nothing is ever inserted after the deleted suffix, so
 * nothing anchors to it — no cascade, no pathology").
 */

const SYNTHETIC_DELETING_REPLICA = 2; // distinct from the document's own replica (1) — a real second "actor" applying deletes remotely, matching how a real server-relayed delete would arrive.

export interface GcEligibleDocument {
  readonly engine: Engine;
  /** The highest synthetic `seq` used for any delete — pass this (or higher) as `collect()`'s own `frontier` to make every delete causally stable. */
  readonly maxSeq: bigint;
}

/** Same two-phase shape as `compression.ts`'s own `buildMemoryTestDocument`, but every delete carries real GC context (see this file's own header for why that's the one thing that MUST differ). */
export function buildGcEligibleMemoryDocument(
  totalOps: number,
  targetVisible: number,
): GcEligibleDocument {
  const engine = new Engine(1);
  for (let i = 0; i < totalOps; i++) {
    engine.localInsert(i, 97 + (i % 26));
  }
  // The trailing `totalOps - targetVisible` characters (positions [targetVisible, totalOps)) are
  // exactly the ones that were inserted AFTER the first `targetVisible` — deleting them, from the
  // visible end inward, never removes anything any surviving node anchors to.
  // Captured ONCE, up front (a single O(N) materialize) — node IDENTITIES are stable regardless
  // of later tombstoning, so the trailing `totalOps - targetVisible` ids can be walked in
  // reverse without ever re-querying `visible()` again (which would cost O(N) PER delete, an
  // O(N * D) blowup this fixture must avoid to stay usable as an actual benchmark).
  const visibleAtStart = engine.visible();
  let seq = 0n;
  let deletingCounter = 1;
  for (let i = visibleAtStart.length - 1; i >= targetVisible; i--) {
    const node = visibleAtStart[i]!;
    seq += 1n;
    const id: Identifier = { c: deletingCounter, r: SYNTHETIC_DELETING_REPLICA };
    deletingCounter += 1;
    const op: DeleteOperation = { kind: "delete", id, target: node.id };
    // atMs = 0: "deleted an eternity ago" — collect()'s own age check (`nowMs - atMs >=
    // maxAgeMs`) is trivially satisfied for ANY realistic `nowMs`/`maxAgeMs` pairing, so this
    // fixture's own collectibility depends only on causal stability (frontier) and anchoring
    // (condition 3), the two things this benchmark actually wants to measure GC's effect on.
    engine.applyRemote(op, { seq, atMs: 0 });
  }
  return { engine, maxSeq: seq };
}
