import type { Identifier } from "./identifier.js";
import { compareIds } from "./identifier.js";
import type { Node } from "./node.js";

/**
 * Block encoding (Engine Spec §7.5, Definitions 7.5/7.6, Theorem 7.1) —
 * resolving RFC NQ-1. A block is a maximal run of nodes ⟨n1...nk⟩ that (1)
 * share one replica, (2) have consecutive counters, (3) are each anchored
 * to their predecessor (nj+1.originLeft = nj.id), and (4) share
 * deleted/deletedBy/bind. Stored as ⟨r, cFirst, values[], originLeft,
 * originRight, deleted, bind, deletedBy⟩ — one identifier and two origin
 * references for the whole run instead of one of each per node. This file
 * holds pure, engine-purity-clean functions only; PositionIndex (Phase 19,
 * extended this phase) is what actually threads blocks into live storage.
 *
 * **originRight is PRESERVED unchanged through split, never reassigned —
 * a deliberate departure from a literal reading of Definition 7.6's own
 * split description, made after that literal reading was tried, built,
 * and found to break a core, pre-existing project guarantee: SNAPSHOT
 * replay.** Full account:
 *
 * Definition 7.5's own note is explicit that decode gives EVERY node in a
 * block the block's single stored `originRight`, uniformly — this is safe
 * (not lossy) because every node formed within one uninterrupted local
 * typing burst genuinely shares the same real originRight:
 * `Engine.localInsert()` re-queries "what's currently at this visible
 * position" on every keystroke, so absent an intervening remote insert at
 * that exact boundary, every character's real originRight is whatever was
 * immediately right of the WHOLE burst's insertion point — unchanged
 * character to character (the same insight Phase 7 already validated for
 * OP_INSERT_RUN's wire encoding).
 *
 * A first implementation followed Definition 7.6's own split text
 * literally: "the first split block's originRight = (r, cFirst+j) [the
 * second block's first node]." This was built, and Phase 20's own DoD
 * test ("Encode/decode round trip is lossless over 500 randomized engine
 * states") caught a reproducible failure: once ANY block in a document's
 * history has ever split (e.g. from a single interior delete), decoding
 * it produces two nodes — the left split's now-LAST node (originRight
 * reassigned to point at the right split's first node) and that right
 * split's first node (originLeft pointing back at the left split's last
 * node) — whose readiness (Engine Spec §4.2 Definition 4.1) becomes
 * MUTUALLY circular: the left node needs the right node present to
 * satisfy its originRight, and the right node needs the left node
 * present to satisfy its originLeft. Neither can ever become ready first
 * when replayed into a fresh `Engine` via the normal `applyRemote`/
 * `ready()`/`drain()` path — a genuine, permanent deadlock, not a timing
 * or ordering artifact fixable by retrying. This is fatal for exactly
 * the mechanism this whole project has depended on since Phase 9
 * (SNAPSHOT frames), Phase 10 (`seedEngineFromSnapshot`), and Phase 17
 * (coordinator warm start via `replaySnapshotNodesInto`) — all of which
 * feed a decoded node sequence through that identical path.
 *
 * Resolution: originRight is preserved as the ORIGINAL block's own
 * (already-uniform, already-true) value on BOTH sides of a split, exactly
 * as it is on merge and on append — never reassigned to a "points at my
 * current structural neighbor" bookkeeping value. `canMergeBlocks` (and
 * its two convenience wrappers below) correspondingly DO compare
 * originRight as a precondition — not a defensive nice-to-have, but a
 * real, necessary part of what makes two blocks genuinely the product of
 * one uninterrupted typing burst rather than a coincidental counter
 * match. This makes decode fully representation-preserving for id, value,
 * originLeft, originRight, deleted, deletedBy, AND bind — a stronger,
 * simpler property than Definition 7.6's own text describes, and the one
 * this project's existing snapshot machinery actually requires.
 */
export interface Block {
  readonly r: number;
  cFirst: number;
  readonly values: number[];
  readonly originLeft: Identifier | null;
  readonly originRight: Identifier | null;
  deleted: boolean;
  deletedBy: Identifier | null;
  readonly bind: boolean;
}

/** The identifier of a block's LAST node — one past `cFirst + values.length - 1`. */
export function lastId(block: Block): Identifier {
  return { c: block.cFirst + block.values.length - 1, r: block.r };
}

function idEquals(a: Identifier | null, b: Identifier | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return compareIds(a, b) === 0;
}

/** A brand-new, single-node block for `node` — the unmergeable fallback every insert can always produce. */
export function singleNodeBlock(node: Node): Block {
  return {
    r: node.id.r,
    cFirst: node.id.c,
    values: [node.value],
    originLeft: node.originLeft,
    originRight: node.originRight,
    deleted: node.deleted,
    deletedBy: node.deletedBy,
    bind: node.bind,
  };
}

/**
 * Materializes the Node view for position `offset` (0-indexed) within
 * `block`: identifier (r, cFirst+offset), value values[offset], originLeft
 * = the predecessor's identifier by condition 3 (or the block's own
 * stored originLeft for offset 0). originRight/deleted/deletedBy/bind are
 * the block's own uniform values for every offset, preserved exactly
 * through every block operation — see this file's header for the full
 * reasoning and the concrete bug that reasoning fixes.
 */
export function decodeNodeAt(block: Block, offset: number): Node {
  return {
    id: { c: block.cFirst + offset, r: block.r },
    value: block.values[offset]!,
    originLeft: offset === 0 ? block.originLeft : { c: block.cFirst + offset - 1, r: block.r },
    originRight: block.originRight,
    bind: block.bind,
    deleted: block.deleted,
    deletedBy: block.deletedBy,
  };
}

/** Decodes every node in `block`, in order — the general case of {@link decodeNodeAt}. */
export function decodeBlock(block: Block): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < block.values.length; i++) {
    out.push(decodeNodeAt(block, i));
  }
  return out;
}

/**
 * Splits `block` at offset `j` (`0 < j < block.values.length`, an
 * INTERIOR offset — the caller never calls this at a boundary) into two
 * blocks: ⟨r, cFirst, values[0..j)⟩ and ⟨r, cFirst+j, values[j..k)⟩, the
 * second with originLeft = (r, cFirst+j-1) (Definition 7.6). BOTH pieces
 * keep the ORIGINAL block's originRight unchanged — see this file's
 * header for why that's a deliberate, necessary departure from
 * Definition 7.6's own literal split description, not an oversight. Both
 * share the original's r, deleted, deletedBy, bind (condition 4
 * preserved by construction — splitting never changes deletion/binding
 * status). Decoding either the original block or the two split results,
 * in order, yields the identical node sequence in EVERY field.
 */
export function splitBlockAt(block: Block, j: number): readonly [Block, Block] {
  if (j <= 0 || j >= block.values.length) {
    throw new Error(
      `splitBlockAt: offset ${j} must be strictly interior to a block of length ${block.values.length}`,
    );
  }
  const left: Block = {
    r: block.r,
    cFirst: block.cFirst,
    values: block.values.slice(0, j),
    originLeft: block.originLeft,
    originRight: block.originRight,
    deleted: block.deleted,
    deletedBy: block.deletedBy,
    bind: block.bind,
  };
  const right: Block = {
    r: block.r,
    cFirst: block.cFirst + j,
    values: block.values.slice(j),
    originLeft: { c: block.cFirst + j - 1, r: block.r },
    originRight: block.originRight,
    deleted: block.deleted,
    deletedBy: block.deletedBy,
    bind: block.bind,
  };
  return [left, right];
}

/**
 * Can `right` be appended onto the end of `left`, forming one larger valid
 * block per Definition 7.5's four conditions PLUS originRight equality
 * (see this file's header for why that fifth check is necessary here,
 * not merely defensive)? Order matters: `left` precedes `right` in the
 * document. Both single-node blocks (the common case, checked once per
 * `PositionIndex.insertAt`) and multi-node blocks (checked once per
 * opportunistic re-merge after a delete/undelete) are valid inputs.
 */
export function canMergeBlocks(left: Block, right: Block): boolean {
  return (
    left.r === right.r &&
    right.cFirst === left.cFirst + left.values.length && // condition 2: consecutive counters
    idEquals(right.originLeft, lastId(left)) && // condition 3: right's first node anchored to left's last
    left.deleted === right.deleted &&
    idEquals(left.deletedBy, right.deletedBy) &&
    left.bind === right.bind &&
    idEquals(left.originRight, right.originRight)
  );
}

/** Merges two ADJACENT, mergeable (per {@link canMergeBlocks}) blocks into one. Caller must have already verified mergeability — including originRight equality, so `left.originRight`/`right.originRight` are interchangeable here. */
export function mergeBlocks(left: Block, right: Block): Block {
  return {
    r: left.r,
    cFirst: left.cFirst,
    values: left.values.concat(right.values),
    originLeft: left.originLeft,
    originRight: right.originRight,
    deleted: left.deleted,
    deletedBy: left.deletedBy,
    bind: left.bind,
  };
}

/** Symmetric convenience: can `newBlock` be appended onto the end of `existing`? */
export function canAppend(existing: Block, newBlock: Block): boolean {
  return canMergeBlocks(existing, newBlock);
}

/** Symmetric convenience: can `newBlock` be prepended onto the start of `existing`? */
export function canPrepend(newBlock: Block, existing: Block): boolean {
  return canMergeBlocks(newBlock, existing);
}

/** True iff a fresh single-node block for `node` could extend `existing` (used by `PositionIndex.insertAt`'s left-neighbor check) — avoids constructing a throwaway `Block` just to test mergeability. */
export function nodeExtendsBlock(existing: Block, node: Node): boolean {
  return (
    node.id.r === existing.r &&
    node.id.c === existing.cFirst + existing.values.length &&
    idEquals(node.originLeft, lastId(existing)) &&
    node.deleted === existing.deleted &&
    idEquals(node.deletedBy, existing.deletedBy) &&
    node.bind === existing.bind &&
    idEquals(node.originRight, existing.originRight)
  );
}

/** True iff a fresh single-node block for `node` could precede `existing` (used by `PositionIndex.insertAt`'s right-neighbor check). */
export function nodePrecedesBlock(node: Node, existing: Block): boolean {
  return (
    node.id.r === existing.r &&
    node.id.c === existing.cFirst - 1 &&
    idEquals(existing.originLeft, node.id) &&
    node.deleted === existing.deleted &&
    idEquals(node.deletedBy, existing.deletedBy) &&
    node.bind === existing.bind &&
    idEquals(node.originRight, existing.originRight)
  );
}

/**
 * True iff `next` could immediately follow `prev` within one block
 * (Definition 7.5's four conditions plus originRight equality, matching
 * {@link canMergeBlocks}), given as two already-DECODED adjacent nodes.
 * This is the grouping check a flat `Node[]` sequence (e.g. `engine.nodes`,
 * or a persisted operation log replayed into a fresh `Engine`) needs to
 * re-derive maximal block runs for WIRE/STORAGE compression — used by
 * `@collab-editor/protocol`'s SNAPSHOT body encoder (Phase 20),
 * independent of whatever internal representation the originating engine
 * happened to use.
 */
export function canFollowInBlock(prev: Node, next: Node): boolean {
  return (
    prev.id.r === next.id.r &&
    next.id.c === prev.id.c + 1 &&
    idEquals(next.originLeft, prev.id) &&
    prev.deleted === next.deleted &&
    idEquals(prev.deletedBy, next.deletedBy) &&
    prev.bind === next.bind &&
    idEquals(prev.originRight, next.originRight)
  );
}

/** Appends `node`'s value onto `existing` IN PLACE (caller has verified {@link nodeExtendsBlock}, including originRight equality). Only `values` grows — every other field, including originRight, is already shared by construction. */
export function appendNodeInPlace(existing: Block, node: Node): void {
  existing.values.push(node.value);
}

/** Prepends `node`'s value onto `existing` IN PLACE (caller has verified {@link nodePrecedesBlock}, including originRight equality). `cFirst` and `originLeft` move to the new first node's own real values; `originRight` is unchanged (already shared). */
export function prependNodeInPlace(existing: Block, node: Node): Block {
  return {
    r: existing.r,
    cFirst: node.id.c,
    values: [node.value, ...existing.values],
    originLeft: node.originLeft,
    originRight: existing.originRight,
    deleted: existing.deleted,
    deletedBy: existing.deletedBy,
    bind: existing.bind,
  };
}
