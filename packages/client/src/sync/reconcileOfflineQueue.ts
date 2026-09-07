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
  type Node,
  type Operation,
} from "@collab-editor/engine";

/**
 * Phase 23 — filters `nodes` (typically a resident `Engine`'s own
 * `.nodes`, taken as the base for a CATCHUP/ALREADY_CURRENT reconnect's
 * freshly-rebuilt engine) down to a "clean" base: everything this client
 * has ALREADY minted offline but never had acknowledged is EXCLUDED, so
 * `reconcileOfflineQueue` (below) is the ONLY thing that ever reintroduces
 * that content, fresh, under a new identity.
 *
 * Why this is necessary, not merely tidy: unlike SNAPSHOT mode (which
 * seeds a brand-new engine purely from the SERVER's own structure — never
 * anything this client minted locally), CATCHUP/ALREADY_CURRENT reconnects
 * seed from THIS CLIENT'S OWN currently-resident `engine.nodes` — which,
 * if this client minted anything OFFLINE before reconnecting, ALREADY
 * contains those not-yet-committed nodes (Engine.localInsert/localDelete
 * mutate the engine synchronously, at mint time, regardless of whether
 * the operation was ever transmitted). Seeding the fresh engine from that
 * UNFILTERED list, then separately reconciling the SAME queued operations
 * via `reconcileOfflineQueue`, mints a SECOND, duplicate operation for
 * the same content — and because the ORIGINAL (offline, unacked) node is
 * still sitting in the fresh engine's own structure, the new reconciled
 * operation can end up anchored (`parent`) to that
 * ORIGINAL node's id, which was NEVER transmitted to the server and can
 * NEVER resolve on any other replica — a permanently-stuck, silently
 * orphaned operation on every peer. Found via the 27-cell RC-* matrix's
 * own DoD verification (Test Plan §5.1) — every cell with L > 0 and
 * R > 0 reproduced it.
 *
 * For a node whose OWN id is unacked (a not-yet-confirmed local insert),
 * the node is omitted entirely. For a node that IS kept but was deleted
 * by an unacked operation (a not-yet-confirmed local delete), it is kept
 * but reverted to not-deleted — `reconcileOfflineQueue`'s own delete
 * reconciliation re-derives the correct tombstone against the clean base.
 * A confirmed/foreign node can never legally anchor to a still-unacked
 * LOCAL node (the server never broadcasts what it hasn't committed, so no
 * peer could ever have referenced it) — so omitting unacked insert nodes
 * can never dangle some OTHER, kept node's own origin.
 */
export function buildCleanCatchupBase(
  nodes: readonly Node[],
  unackedIds: ReadonlySet<string>,
): Node[] {
  const clean: Node[] = [];
  for (const node of nodes) {
    if (unackedIds.has(serializeId(node.id))) {
      continue;
    }
    if (node.deleted && node.deletedBy !== null && unackedIds.has(serializeId(node.deletedBy))) {
      clean.push({ ...node, deleted: false, deletedBy: null });
    } else {
      clean.push(node);
    }
  }
  return clean;
}

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
 * AFTER `anchor` (or at the very start, if `anchor` is null) — used for a
 * queued insert whose original `side` was `"R"` (Fugue port, 2026-09-05;
 * see this file's own header comment and `reconcileOfflineQueue`'s own
 * doc comment for why the anchor must be resolved differently depending
 * on `side`, unlike the retired YATA design's single `originLeft`
 * derivation). Counts every VISIBLE node up to and including the anchor's
 * own structural position — correct even if the anchor has since been
 * tombstoned (a concurrent delete from the other client that stayed
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
 * The visible index to insert AT so the new content lands immediately
 * BEFORE `anchor` — used for a queued insert whose original `side` was
 * `"L"`. Hand-traced against `FugueTree.decidePlacement` (see this file's
 * own header comment): a `side: "L"` node's `parent` is exactly the node
 * that, at ORIGINAL insertion time, occupied the target visible index
 * itself (Fugue's own Case 2 — the new node becomes the leftmost thing in
 * that node's own left subtree, so an in-order traversal visits the new
 * node immediately BEFORE `parent`, not after it) — so reproducing the
 * same intended position means inserting right before wherever `anchor`
 * currently sits, never after it. Counts every VISIBLE node STRICTLY
 * before the anchor's own structural position; a tombstoned anchor is
 * handled the same way `visibleIndexAfter` handles one (still contributes
 * a well-defined structural position to insert relative to). Falls back
 * to position 0 if the anchor no longer exists at all, same reasoning as
 * `visibleIndexAfter`.
 */
export function visibleIndexBefore(engine: Engine, anchor: Identifier): number {
  const idx = structuralIndexOf(engine, anchor);
  if (idx === -1) {
    return 0;
  }
  const nodes = engine.nodes;
  let visible = 0;
  for (let i = 0; i < idx; i++) {
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
 *
 * Fugue port (2026-09-05): an insert's target visible index is derived
 * from `op.parent`/`op.side` together, not `parent` alone — `side: "R"`
 * means "insert right after `parent`" (`visibleIndexAfter`), `side: "L"`
 * means "insert right before `parent`" (`visibleIndexBefore`); see both
 * functions' own doc comments for the hand-traced derivation against
 * `FugueTree.decidePlacement`. `op.parent === null` only ever occurs with
 * `side: "R"` (Fugue's own `decidePlacement` never returns `side: "L"`
 * with a null parent — Case 2's `parent` is always a real descendant
 * node), so it is handled directly as visible index 0 without consulting
 * `side` at all.
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
      let visibleIndex: number;
      if (op.parent === null) {
        visibleIndex = 0;
      } else {
        const anchor = resolve(op.parent);
        visibleIndex =
          op.side === "R" ? visibleIndexAfter(engine, anchor) : visibleIndexBefore(engine, anchor);
      }
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
