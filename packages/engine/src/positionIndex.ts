import type { Identifier } from "./identifier.js";
import type { Node } from "./node.js";
import type { Block } from "./block.js";
import {
  appendNodeInPlace,
  canMergeBlocks,
  decodeBlock,
  decodeNodeAt,
  mergeBlocks,
  nodeExtendsBlock,
  nodePrecedesBlock,
  prependNodeInPlace,
  singleNodeBlock,
  splitBlockAt,
} from "./block.js";

/**
 * The balanced-tree position index (Engine Spec §8.5), storing BLOCKS
 * (Engine Spec §7.5, Phase 20) rather than one leaf per node (Phase 19's
 * original design). A treap leaf now represents a maximal compressible RUN
 * of nodes — one replica, consecutive counters, chained originLeft, uniform
 * deleted/deletedBy/bind/originRight (see block.ts's own header for why
 * that last one is safe) — collapsing what used to be N separate JS Node
 * objects (each with 7 fields, V8 object-header overhead) into one Block
 * object (7 fields total, PLUS a single shared `values` array) for however
 * many nodes the run actually contains. This is what M8-b's memory
 * re-measurement (CLAUDE.md's Phase 20 entry) is actually measuring:
 * REAL, live V8 heap savings, not merely a wire/snapshot compression trick
 * — Node objects materialize on demand (`decodeNodeAt`), they are not
 * kept as stable, persistent objects the way Phase 19 assumed.
 *
 * "Split first, then integrate. Blocks live strictly below the algorithm
 * — INTEGRATE from Phase 3 is unchanged and never sees a block" (Engine
 * Spec §7.5 Corollary 7.1): this file is the ENTIRE place that principle
 * lives. `engine.ts`'s `integrate()` still calls exactly the same five
 * position/identifier-based operations it called in Phase 19
 * (`indexOf`/`nodeAt`/`insertAt`, now identifier- rather than
 * Node-object-keyed) and never once touches a `Block`. Every block SPLIT
 * (Definition 7.6) and MERGE this file performs happens transparently
 * inside `splitByPosition`/`tryMergeAt`, triggered by an ordinary
 * position- or identifier-based query or mutation — the caller never
 * asks for a split or a merge directly.
 *
 * Public API changed from Phase 19 in two ways, both necessary
 * consequences of block storage, not gratuitous churn:
 *  1. `indexOf`/`visibleIndexOf`/`nodeByIdentifier`/`hasIdentifier` take an
 *     `Identifier`, not a `Node` object — Engine Spec §8.5's own signature
 *     was `indexOf(id)` all along; Phase 19 took a `Node` only because it
 *     had a stable one on hand via `engine.ts`'s (now-removed) `byKey` map.
 *     Materialized Node views are no longer stable object references (a
 *     fresh object is decoded on every read), so object-identity-keyed
 *     lookup is gone — `engine.ts` no longer keeps its own `byKey` at all;
 *     this index is the SOLE source of truth for identifier resolution.
 *  2. `setDeleted` takes `(id, deleted, deletedBy)` instead of `(node,
 *     deleted)` — Phase 19's version relied on the caller mutating
 *     `node.deletedBy` directly on a live object reference afterward,
 *     which cannot work once `node` is a disposable materialized view.
 *
 * Treap mechanics (merge/priority/why not `Math.random()`) are UNCHANGED
 * from Phase 19 — see this file's own git history / the Phase 19
 * CLAUDE.md entry for that reasoning, not repeated here.
 */

interface TreapNode {
  /** Mutable: reassigned in place on append/prepend/merge/split — see `appendNodeInPlace`, `mergeBlocks`, `splitBlockAt`. */
  block: Block;
  readonly priority: number;
  left: TreapNode | null;
  right: TreapNode | null;
  parent: TreapNode | null;
  /** Subtree total NODE count (not block/leaf count), including this leaf's own `block.values.length`. */
  size: number;
  /** Subtree count of non-deleted nodes. A block's `deleted` is uniform, so it contributes either 0 or its full `values.length`. */
  visibleCount: number;
}

function sz(t: TreapNode | null): number {
  return t === null ? 0 : t.size;
}

function vis(t: TreapNode | null): number {
  return t === null ? 0 : t.visibleCount;
}

function update(t: TreapNode): void {
  t.size = t.block.values.length + sz(t.left) + sz(t.right);
  t.visibleCount = (t.block.deleted ? 0 : t.block.values.length) + vis(t.left) + vis(t.right);
}

function setParent(t: TreapNode | null, parent: TreapNode | null): void {
  if (t !== null) {
    t.parent = parent;
  }
}

/** Standard treap merge (Phase 19, unchanged) — purely priority/position-structural, never touches block content. */
function merge(left: TreapNode | null, right: TreapNode | null): TreapNode | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  if (left.priority > right.priority) {
    left.right = merge(left.right, right);
    setParent(left.right, left);
    update(left);
    return left;
  }
  right.left = merge(left, right.left);
  setParent(right.left, right);
  update(right);
  return right;
}

function locateByPosition(root: TreapNode | null, position: number): { t: TreapNode; offset: number } | undefined {
  let t = root;
  let k = position;
  while (t !== null) {
    const leftSize = sz(t.left);
    const blockLen = t.block.values.length;
    if (k < leftSize) {
      t = t.left;
    } else if (k < leftSize + blockLen) {
      return { t, offset: k - leftSize };
    } else {
      k -= leftSize + blockLen;
      t = t.right;
    }
  }
  return undefined;
}

function locateByVisiblePosition(
  root: TreapNode | null,
  position: number,
): { t: TreapNode; offset: number } | undefined {
  let t = root;
  let k = position;
  while (t !== null) {
    const leftVis = vis(t.left);
    if (k < leftVis) {
      t = t.left;
      continue;
    }
    if (!t.block.deleted) {
      const blockLen = t.block.values.length;
      if (k < leftVis + blockLen) {
        return { t, offset: k - leftVis };
      }
      k -= leftVis + blockLen;
      t = t.right;
    } else {
      // The whole block is invisible — none of it consumes any of k.
      k -= leftVis;
      t = t.right;
    }
  }
  return undefined;
}

function inOrderDecode(t: TreapNode | null, out: Node[]): void {
  if (t === null) {
    return;
  }
  inOrderDecode(t.left, out);
  for (const n of decodeBlock(t.block)) {
    out.push(n);
  }
  inOrderDecode(t.right, out);
}

export class PositionIndex {
  private root: TreapNode | null = null;
  /**
   * Per-replica index for O(log B) identifier resolution, B = number of
   * LIVE BLOCKS for that replica (not number of nodes — this is exactly
   * the structure block compression keeps small). Each array is sorted by
   * `block.cFirst`, read FRESH from the (mutable) block on every access —
   * never cached — so append/prepend, which change a block's extent or
   * (prepend only) its own `cFirst` in place, never require re-sorting:
   * blocks for one replica are always disjoint and adjacent-or-separated,
   * so a block's relative ORDER among its replica's siblings never changes
   * from a boundary-adjacent merge, only its extent does.
   */
  private readonly byReplica = new Map<number, TreapNode[]>();
  private prioritySeed = 0x9e3779b9;

  private nextPriority(): number {
    this.prioritySeed = (this.prioritySeed + 0x6d2b79f5) | 0;
    let t = this.prioritySeed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Total node count (not block count). */
  get size(): number {
    return sz(this.root);
  }

  /** Visible (non-tombstoned) node count. */
  get visibleSize(): number {
    return vis(this.root);
  }

  /** Live block count, across every replica — purely diagnostic (compression-ratio measurement, M8-b), read by no ordering logic. */
  get blockCount(): number {
    let count = 0;
    for (const arr of this.byReplica.values()) {
      count += arr.length;
    }
    return count;
  }

  /** Engine Spec §8.5: indexOf(id) — TOTAL position, or `undefined` if `id` isn't present. O(log B) to locate the containing block, O(log N) to walk to root. */
  indexOf(id: Identifier): number | undefined {
    const loc = this.locateByIdentifier(id);
    if (!loc) {
      return undefined;
    }
    let idx = sz(loc.t.left) + loc.offset;
    let cur = loc.t;
    while (cur.parent !== null) {
      if (cur.parent.right === cur) {
        idx += sz(cur.parent.left) + cur.parent.block.values.length;
      }
      cur = cur.parent;
    }
    return idx;
  }

  /** Engine Spec §8.5: visibleIndexOf(id) — count of visible nodes strictly before `id` (its visible position if visible; the position it would occupy if it became visible, if not). `undefined` if `id` isn't present. */
  visibleIndexOf(id: Identifier): number | undefined {
    const loc = this.locateByIdentifier(id);
    if (!loc) {
      return undefined;
    }
    let idx = vis(loc.t.left) + (loc.t.block.deleted ? 0 : loc.offset);
    let cur = loc.t;
    while (cur.parent !== null) {
      if (cur.parent.right === cur) {
        idx += vis(cur.parent.left) + (cur.parent.block.deleted ? 0 : cur.parent.block.values.length);
      }
      cur = cur.parent;
    }
    return idx;
  }

  /** Node at TOTAL position `position`, materialized on demand — not one of Engine Spec §8.5's five named operations, but required by `integrate()`'s own scan loop. O(log N). */
  nodeAt(position: number): Node | undefined {
    const loc = locateByPosition(this.root, position);
    return loc ? decodeNodeAt(loc.t.block, loc.offset) : undefined;
  }

  /** Engine Spec §8.5: nodeAtVisible(k) — the node at VISIBLE position `k`, materialized on demand, or `undefined` past the visible end. O(log N). */
  nodeAtVisible(position: number): Node | undefined {
    const loc = locateByVisiblePosition(this.root, position);
    return loc ? decodeNodeAt(loc.t.block, loc.offset) : undefined;
  }

  /** Does `id` currently exist in the structure (deleted or not)? Replaces `engine.ts`'s Phase 3/19 `byKey.has()` — this index is the sole source of truth for identifier resolution as of Phase 20. */
  hasIdentifier(id: Identifier): boolean {
    return this.locateByIdentifier(id) !== undefined;
  }

  /** Resolves `id` to its materialized Node view, or `undefined` if absent. Replaces `engine.ts`'s Phase 3/19 `byKey.get()`/`nodeById`. */
  nodeByIdentifier(id: Identifier): Node | undefined {
    const loc = this.locateByIdentifier(id);
    return loc ? decodeNodeAt(loc.t.block, loc.offset) : undefined;
  }

  /**
   * Engine Spec §8.5: splice(position, deleteCount, ...insert) — mirrors
   * `Array.prototype.splice`. The engine itself only ever calls this with
   * `deleteCount === 0` via `insertAt` (physical removal doesn't happen
   * pre-GC, Invariant I5) and with exactly one `insert` element — kept
   * fully general per the spec's own contract regardless (same reasoning
   * as Phase 19). Opportunistic block merging (Definition 7.5) is
   * attempted at both new seams after insertion; removed blocks are
   * decoded to their full node sequence for the return value.
   */
  splice(position: number, deleteCount: number, ...insert: readonly Node[]): Node[] {
    const [left, rest] = this.splitByPosition(this.root, position);
    const [removed, right] = this.splitByPosition(rest, deleteCount);

    const removedNodes: Node[] = [];
    this.collectAndDeregister(removed, removedNodes);

    let middle: TreapNode | null = null;
    for (const n of insert) {
      middle = merge(middle, this.makeLeaf(singleNodeBlock(n)));
    }

    this.root = merge(merge(left, middle), right);
    setParent(this.root, null);

    this.tryMergeAt(position);
    this.tryMergeAt(position + insert.length);

    return removedNodes;
  }

  /**
   * The only shape `engine.ts`'s `integrate()` actually calls — implemented
   * directly rather than delegating to `splice(position, 0, node)`, for a
   * real performance reason, not just directness: `splice`'s generic path
   * creates a throwaway single-node leaf and relies on `tryMergeAt`'s
   * `mergeBlocks` (an array CONCAT) to fold it into a neighbor. For the
   * DOMINANT real workload — a user typing a long run of characters,
   * always appending onto the immediately preceding block — going through
   * concat on every keystroke would cost O(L) for a block of length L,
   * making one N-character burst cost O(N²) overall. The fast path below
   * instead extends the preceding block's `values` array via `push`
   * (`appendNodeInPlace`, O(1) amortized) whenever Definition 7.5's
   * conditions already hold between the new node and its immediate
   * predecessor — which, for an uninterrupted local typing burst, is
   * EVERY keystroke after the first (see block.ts's own header for why
   * this holds). Prepending (rarer — only relevant for out-of-order
   * remote application) still goes through an O(L) array-rebuild
   * (`prependNodeInPlace`), which is acceptable since it isn't the hot
   * path this fix exists for. Only when NEITHER applies does this fall
   * back to a fresh single-node leaf, exactly like `splice`'s own
   * fallback.
   */
  insertAt(position: number, node: Node): void {
    if (position > 0) {
      const leftLoc = locateByPosition(this.root, position - 1);
      if (
        leftLoc &&
        leftLoc.offset === leftLoc.t.block.values.length - 1 &&
        nodeExtendsBlock(leftLoc.t.block, node)
      ) {
        appendNodeInPlace(leftLoc.t.block, node);
        this.propagateCounts(leftLoc.t);
        this.tryMergeAt(position + 1); // the extended block may now also bridge into its successor
        return;
      }
    }
    if (position < sz(this.root)) {
      const rightLoc = locateByPosition(this.root, position);
      if (rightLoc && rightLoc.offset === 0 && nodePrecedesBlock(node, rightLoc.t.block)) {
        rightLoc.t.block = prependNodeInPlace(rightLoc.t.block, node);
        this.propagateCounts(rightLoc.t);
        this.tryMergeAt(position); // the extended block may now also bridge into its predecessor
        return;
      }
    }
    const [left, right] = this.splitByPosition(this.root, position);
    const leaf = this.makeLeaf(singleNodeBlock(node));
    this.root = merge(merge(left, leaf), right);
    setParent(this.root, null);
  }

  /**
   * Engine Spec §8.5: setDeleted(id, deleted, deletedBy) — the SOLE place
   * a node's `deleted`/`deletedBy` are ever written (`engine.ts`'s
   * `applyDelete`/`applyUndelete` compute the new `deletedBy` value from a
   * freshly materialized read, then call this once). Isolates `id` into
   * its own single-node block first if it currently lives inside a larger
   * one (a delete/undelete always targets exactly ONE identifier —
   * Engine Spec §4.1 — so its containing block can never be flipped
   * wholesale unless it already has exactly one member), flips the
   * isolated block's fields, then opportunistically re-merges with
   * neighbors that may now match (e.g. two adjacent single-char deletes
   * with the same attribution re-compress back into one block).
   */
  setDeleted(id: Identifier, deleted: boolean, deletedBy: Identifier | null): void {
    const position = this.indexOf(id);
    if (position === undefined) {
      throw new Error(`PositionIndex.setDeleted: identifier not present`);
    }
    const [left, rest] = this.splitByPosition(this.root, position);
    const [mid, right] = this.splitByPosition(rest, 1);
    if (mid === null) {
      throw new Error("PositionIndex.setDeleted: internal error — isolated node missing after split");
    }
    mid.block.deleted = deleted;
    mid.block.deletedBy = deletedBy;
    update(mid);

    this.root = merge(merge(left, mid), right);
    setParent(this.root, null);

    this.tryMergeAt(position);
    this.tryMergeAt(position + 1);
  }

  /** Property 6 (Engine Spec §8.5): iteration order identical to S at all times. O(N) — unavoidable for materializing the whole sequence. */
  toArray(): Node[] {
    const out: Node[] = [];
    inOrderDecode(this.root, out);
    return out;
  }

  // --- Block-aware treap internals ---------------------------------------------------------

  /**
   * Position-based split, generalizing Phase 19's `split` for
   * variable-length leaves. When `k` lands exactly on a leaf boundary,
   * this recurses structurally exactly as Phase 19's version did (now
   * comparing against `block.values.length` instead of an implicit 1).
   * When `k` lands STRICTLY INSIDE a leaf's block, that block is split
   * per Definition 7.6 (`splitBlockAt`) into two fresh leaves, which
   * inherit the original leaf's children — this is the one and only
   * place a live block is ever split, and it happens transparently
   * underneath any position-based mutation that needs a boundary there
   * (`splice`, `setDeleted`), never as a directly callable operation.
   */
  private splitByPosition(
    t: TreapNode | null,
    k: number,
  ): readonly [TreapNode | null, TreapNode | null] {
    if (t === null) {
      return [null, null];
    }
    const leftSize = sz(t.left);
    const blockLen = t.block.values.length;
    if (k <= leftSize) {
      const [ll, lr] = this.splitByPosition(t.left, k);
      t.left = lr;
      setParent(lr, t);
      setParent(t, null);
      update(t);
      return [ll, t];
    }
    if (k >= leftSize + blockLen) {
      const [rl, rr] = this.splitByPosition(t.right, k - leftSize - blockLen);
      t.right = rl;
      setParent(rl, t);
      setParent(t, null);
      update(t);
      return [t, rr];
    }
    // k falls strictly inside this leaf's block — Definition 7.6.
    const localOffset = k - leftSize;
    const [leftBlock, rightBlock] = splitBlockAt(t.block, localOffset);
    this.deregisterLeaf(t);
    const leftLeaf = this.makeLeaf(leftBlock);
    const rightLeaf = this.makeLeaf(rightBlock);
    leftLeaf.left = t.left;
    setParent(t.left, leftLeaf);
    rightLeaf.right = t.right;
    setParent(t.right, rightLeaf);
    update(leftLeaf);
    update(rightLeaf);
    return [leftLeaf, rightLeaf];
  }

  /**
   * If the leaf ending at `boundaryPosition - 1` and the leaf starting at
   * `boundaryPosition` are both present and mergeable (Definition 7.5 via
   * `canMergeBlocks`), combines them into one block, removing the right
   * leaf. A no-op if `boundaryPosition` isn't a genuine leaf boundary (the
   * two positions resolve to the SAME leaf) or either side is absent.
   */
  private tryMergeAt(boundaryPosition: number): void {
    if (boundaryPosition <= 0 || boundaryPosition >= sz(this.root)) {
      return;
    }
    const leftLoc = locateByPosition(this.root, boundaryPosition - 1);
    const rightLoc = locateByPosition(this.root, boundaryPosition);
    if (!leftLoc || !rightLoc || leftLoc.t === rightLoc.t) {
      return;
    }
    if (!canMergeBlocks(leftLoc.t.block, rightLoc.t.block)) {
      return;
    }
    const merged = mergeBlocks(leftLoc.t.block, rightLoc.t.block);
    const rightLength = rightLoc.t.block.values.length;
    this.deregisterLeaf(rightLoc.t);
    const [left, rest] = this.splitByPosition(this.root, boundaryPosition);
    const [, right] = this.splitByPosition(rest, rightLength);
    this.root = merge(left, right);
    setParent(this.root, null);

    leftLoc.t.block = merged;
    this.propagateCounts(leftLoc.t);
  }

  /** Recomputes `size`/`visibleCount` from `t` up to the root — called after any in-place block mutation (append/prepend/merge/setDeleted) that doesn't already go through `splitByPosition`/`merge`'s own bookkeeping. */
  private propagateCounts(t: TreapNode | null): void {
    let cur = t;
    while (cur !== null) {
      update(cur);
      cur = cur.parent;
    }
  }

  private makeLeaf(block: Block): TreapNode {
    const t: TreapNode = {
      block,
      priority: this.nextPriority(),
      left: null,
      right: null,
      parent: null,
      size: block.values.length,
      visibleCount: block.deleted ? 0 : block.values.length,
    };
    this.registerLeaf(t);
    return t;
  }

  private registerLeaf(t: TreapNode): void {
    let arr = this.byReplica.get(t.block.r);
    if (!arr) {
      arr = [];
      this.byReplica.set(t.block.r, arr);
    }
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid]!.block.cFirst < t.block.cFirst) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    arr.splice(lo, 0, t);
  }

  private deregisterLeaf(t: TreapNode): void {
    const arr = this.byReplica.get(t.block.r);
    if (!arr) {
      throw new Error("PositionIndex: internal error — no replica bucket for a leaf being deregistered");
    }
    let lo = 0;
    let hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const c = arr[mid]!.block.cFirst;
      if (c < t.block.cFirst) {
        lo = mid + 1;
      } else if (c > t.block.cFirst) {
        hi = mid - 1;
      } else {
        arr.splice(mid, 1);
        return;
      }
    }
    throw new Error("PositionIndex: internal error — leaf not found in per-replica identity index");
  }

  private locateByIdentifier(id: Identifier): { t: TreapNode; offset: number } | undefined {
    const arr = this.byReplica.get(id.r);
    if (!arr) {
      return undefined;
    }
    let lo = 0;
    let hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const block = arr[mid]!.block;
      if (id.c < block.cFirst) {
        hi = mid - 1;
      } else if (id.c >= block.cFirst + block.values.length) {
        lo = mid + 1;
      } else {
        return { t: arr[mid]!, offset: id.c - block.cFirst };
      }
    }
    return undefined;
  }

  private collectAndDeregister(t: TreapNode | null, out: Node[]): void {
    if (t === null) {
      return;
    }
    this.collectAndDeregister(t.left, out);
    for (const n of decodeBlock(t.block)) {
      out.push(n);
    }
    this.collectAndDeregister(t.right, out);
    this.deregisterLeaf(t);
  }
}
