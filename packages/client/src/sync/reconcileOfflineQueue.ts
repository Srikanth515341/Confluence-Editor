// Phase 22 — reconciling a durably-queued offline edit against a FRESH
// engine seeded from a new SNAPSHOT (syncClient.ts's handleSnapshot()).
//
// Why this exists at all: this project's server never resumes a session --
// every reconnect is assigned a brand-new replica id (DocumentCoordinator.
// allocateReplicaId()'s counter always advances, Phase 8/9's deliberate
// design for Invariant I1). writePath.ts's step 2 (Phase 16) rejects any
// operation whose stamp.r doesn't match the CURRENT session's replica id
// (IDENTITY_MISMATCH) -- so an operation minted offline under the OLD
// replica id can never be resent to the server AS-IS after a reconnect.
// The only way for its CONTENT to actually reach the server is to mint a
// BRAND NEW local operation, under the NEW replica id, that reproduces the
// same intent. That is what `reconcileOfflineQueue` does: it is NOT a
// resend, it is a replay of intent through the engine's own public
// localInsert/localDelete API.
//
// Disclosed nuance (documented here and in CLAUDE.md, not hidden): the
// operation identities that land on the server after a replica-id-changing
// reconnect are NOT the original ones queued while offline. DUR-07's own
// assertions ("all 200 land in the final document, exactly once", "the
// document converges with a second client") are about CONTENT, never about
// identifier equality across a reconnect -- that guarantee is fully
// satisfied by this design.

import {
  serializeId,
  type Engine,
  type Identifier,
  type Operation,
} from "@collab-editor/engine";

/** Structural (not visible) index of the node with `id`, or -1 if no such node exists in `engine.nodes`. */
function structuralIndexOf(engine: Engine, id: Identifier): number {
  const nodes = engine.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.id.c === id.c && node.id.r === id.r) {
      return i;
    }
  }
  return -1;
}

/**
 * The visible index to insert AT so the new content lands immediately
 * after `anchor` (or at the very start, if `anchor` is null) — matching
 * `Engine.localInsert`'s own `visibleIndex` semantics (Engine Spec §4.1:
 * `originLeft`/`originRight` are derived from `index.nodeAtVisible(v-1)`/
 * `nodeAtVisible(v)`). Counts every VISIBLE node up to and including the
 * anchor's own structural position — correct even if the anchor has since
 * been tombstoned (a concurrent delete from the other client that stayed
 * online while this one was offline): the content still belongs right
 * after where that character used to be, and a tombstoned anchor
 * contributes 0 to the visible count, exactly as it should.
 *
 * Falls back to position 0 if the anchor no longer exists at all
 * (physically removed) — not reachable within this phase's own DoD scope
 * (GC's minimum thresholds, Phase 21, are 5 minutes / 200 ops; DUR-07/08's
 * short offline windows can never age a tombstone out that fast), but a
 * defensible, disclosed fallback rather than a throw for the remote
 * theoretical case.
 */
export function visibleIndexAfter(engine: Engine, anchor: Identifier | null): number {
  if (anchor === null) {
    return 0;
  }
  const idx = structuralIndexOf(engine, anchor);
  if (idx === -1) {
    return 0;
  }
  const nodes = engine.nodes;
  let visible = 0;
  for (let i = 0; i <= idx; i++) {
    if (!nodes[i]!.deleted) {
      visible++;
    }
  }
  return visible;
}

/**
 * The current visible index of the node identified by `target`, or `null`
 * if it no longer exists as a LIVE node — either it was never found
 * (physically removed) or it's already tombstoned (deleted by the other
 * client while this one was offline, or already consumed earlier in this
 * same replay batch). Either way there is nothing left to re-delete.
 */
export function visibleIndexOfTarget(engine: Engine, target: Identifier): number | null {
  const idx = structuralIndexOf(engine, target);
  if (idx === -1) {
    return null;
  }
  const nodes = engine.nodes;
  if (nodes[idx]!.deleted) {
    return null;
  }
  let visible = 0;
  for (let i = 0; i < idx; i++) {
    if (!nodes[i]!.deleted) {
      visible++;
    }
  }
  return visible;
}

/**
 * Replays `queuedOps` (already sorted into original local mint order by
 * durableQueue.ts's `loadUnacked`, or naturally in that order if they were
 * never persisted at all — a same-session reconnect with no crash in
 * between) against `engine`, producing brand-new operations under
 * `engine`'s own (newly-assigned) replica id. Returns the new operations,
 * in the same order, ready to be handed to `SyncClient.sendOperation` —
 * this function only mutates `engine` and returns data; it does not touch
 * the network or the durable queue itself (syncClient.ts's caller is
 * responsible for un-queueing the OLD entries and queueing the NEW ones).
 *
 * A `remap` (old op id -> newly-minted id) is threaded through the whole
 * batch so a LATER queued op anchored to an EARLIER queued op in the SAME
 * batch (e.g. three consecutively-typed characters, each chained to the
 * previous one's id) resolves to that earlier op's NEW identity, not its
 * stale one — without this, every character after the first in a
 * same-session offline chain would incorrectly fail to find its anchor and
 * fall back to position 0.
 */
export function reconcileOfflineQueue(
  engine: Engine,
  queuedOps: readonly Operation[],
): Operation[] {
  const remap = new Map<string, Identifier>();
  const resolve = (id: Identifier): Identifier => remap.get(serializeId(id)) ?? id;

  const resent: Operation[] = [];
  for (const op of queuedOps) {
    if (op.kind === "insert") {
      const anchor = op.originLeft === null ? null : resolve(op.originLeft);
      const visibleIndex = visibleIndexAfter(engine, anchor);
      const newOp = engine.localInsert(visibleIndex, op.value, op.bind);
      remap.set(serializeId(op.id), newOp.id);
      resent.push(newOp);
    } else if (op.kind === "delete") {
      const target = resolve(op.target);
      const visibleIndex = visibleIndexOfTarget(engine, target);
      if (visibleIndex === null) {
        continue; // already gone — nothing to re-delete
      }
      const [newOp] = engine.localDelete(visibleIndex, 1);
      if (newOp) {
        remap.set(serializeId(op.id), newOp.id);
        resent.push(newOp);
      }
    }
    // "undelete" is never minted by SyncClient.localInsert/localDelete (Engine Spec §9.3's
    // resurrection semantics are Phase 36) — not reachable from this client's own offline
    // queue today; skipped defensively rather than crashing on a kind this replay can't
    // reproduce via the public localInsert/localDelete API.
  }
  return resent;
}
