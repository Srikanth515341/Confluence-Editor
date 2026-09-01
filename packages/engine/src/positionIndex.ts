import type { Node } from "./node.js";

/**
 * The balanced-tree position index (Engine Spec §8.5), replacing the
 * flat-array linear scans Phase 3 shipped with a placeholder ("no index
 * (§8.5) yet — position lookup during integrate() is a linear scan").
 * Engine Spec §8.2 measured the origin-bounded scan WINDOW itself as
 * already effectively constant (p50=0, p95=4, p99=9 nodes on a
 * 20,000-node structure) — this file does not touch that scan's logic
 * at all (engine.ts's Case A/B/C loop is unchanged). What IS O(N) today,
 * and what this file exists to fix, is POSITION LOOKUP: turning an
 * identifier into a position (`indexOfOrigin`, called twice per
 * integration) and turning a visible index into a node (`localInsert`/
 * `localDelete`, called once per character a user types). "Indexing the
 * wrong thing is substantial work for no benefit" (Phase 19's own
 * framing) — so only these lookups move to the index; the scan window
 * itself stays a handful of direct position reads.
 *
 * Implementation: an implicit-key TREAP (a randomized balanced BST,
 * ordered purely by POSITION — there is no comparable "key" the way a
 * normal BST has one, only "this subtree's nodes come before/after
 * that subtree's"). A treap was chosen over AVL/red-black because its
 * balancing rule (random priorities, heap-ordered) needs no rotation
 * bookkeeping — split/merge fall out of one recursive rule apiece, which
 * matters here because this file's correctness is safety-critical (every
 * downstream phase depends on packages/engine) and a treap's split/merge
 * are far easier to get right, and to VERIFY are right, than rotation-
 * based rebalancing. Expected height is O(log N) for random priorities
 * REGARDLESS of insertion order or pattern — unlike a naive unbalanced
 * BST, a treap cannot be driven into a degenerate linear chain by an
 * adversarial sequence of insert positions, because its shape depends
 * only on the (independent, uncorrelated with position) priorities.
 *
 * Priorities are NOT `Math.random()` — deliberately. Two considerations:
 * (1) the tree's SHAPE is a pure implementation detail, invisible to
 * every external observer (in-order traversal always yields the same
 * sequence regardless of shape — Engine Spec §8.5's own "property 6"
 * below), so nothing about convergence requires it to be reproducible;
 * but (2) this project's engine has been kept 100% deterministic given
 * identical inputs since Phase 0 (two independent purity-enforcement
 * mechanisms exist for exactly this reason), and introducing the ONLY
 * source of true non-determinism the engine has ever had, for a detail
 * nothing outside this file can even observe, would be a needless
 * departure from that discipline. A small deterministic generator
 * (SplitMix32-shaped, seeded from a fixed constant, advanced by a
 * counter) gives identical balance-quality guarantees — priorities only
 * need to be well-distributed and independent of node content/position,
 * not cryptographically random — while keeping every Engine instance's
 * behavior, including this internal detail, exactly reproducible given
 * the same sequence of calls.
 */

interface TreapNode {
  readonly node: Node;
  readonly priority: number;
  left: TreapNode | null;
  right: TreapNode | null;
  parent: TreapNode | null;
  /** Subtree total count, including self. */
  size: number;
  /** Subtree count of non-deleted (`!node.deleted`) nodes, including self if not deleted. */
  visibleCount: number;
}

function sz(t: TreapNode | null): number {
  return t === null ? 0 : t.size;
}

function vis(t: TreapNode | null): number {
  return t === null ? 0 : t.visibleCount;
}

/** Recomputes `t.size`/`t.visibleCount` from its (already-correct) children. Called on every node whose children just changed, working outward — see every call site below. */
function update(t: TreapNode): void {
  t.size = 1 + sz(t.left) + sz(t.right);
  t.visibleCount = (t.node.deleted ? 0 : 1) + vis(t.left) + vis(t.right);
}

function setParent(t: TreapNode | null, parent: TreapNode | null): void {
  if (t !== null) {
    t.parent = parent;
  }
}

/**
 * Standard treap merge: assumes every node in `left` precedes every node
 * in `right` (the caller's responsibility — true for every call site
 * below, since merge is only ever used to reassemble pieces `split`
 * itself produced, or a single fresh leaf). Higher priority becomes the
 * new subtree root (max-heap ordering) — an arbitrary but consistent
 * convention; nothing depends on which side "wins" ties beyond the tree
 * staying a valid treap. Expected O(log N).
 */
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

/**
 * Splits `t` into `[first k nodes by position, the rest]`. Both returned
 * roots have `parent === null` (they are now independent treaps; the
 * caller reattaches via `merge` and/or a fresh `setParent`). Expected
 * O(log N).
 */
function split(t: TreapNode | null, k: number): readonly [TreapNode | null, TreapNode | null] {
  if (t === null) {
    return [null, null];
  }
  const leftSize = sz(t.left);
  if (leftSize < k) {
    const [rl, rr] = split(t.right, k - leftSize - 1);
    t.right = rl;
    setParent(rl, t);
    setParent(t, null);
    update(t);
    return [t, rr];
  }
  const [ll, lr] = split(t.left, k);
  t.left = lr;
  setParent(lr, t);
  setParent(t, null);
  update(t);
  return [ll, t];
}

function inOrder(t: TreapNode | null, out: Node[]): void {
  if (t === null) {
    return;
  }
  inOrder(t.left, out);
  out.push(t.node);
  inOrder(t.right, out);
}

export class PositionIndex {
  private root: TreapNode | null = null;
  /** Node → its treap wrapper, for O(1) ENTRY into the O(log N) parent-pointer walk-up that `indexOf`/`visibleIndexOf`/`setDeleted` all need. Parallel to `Engine`'s own `byKey` (identifier → Node) — this map is keyed on Node identity instead, since that's what the index's own callers always already have in hand. */
  private readonly byNode = new Map<Node, TreapNode>();
  /** See this file's own header comment for why not `Math.random()`. Arbitrary odd (golden-ratio-derived, a common PRNG seed choice) constant; advanced once per inserted node. */
  private prioritySeed = 0x9e3779b9;

  /** SplitMix32-shaped: cheap, good statistical spread, no external dependency. Only needs to be well-distributed and independent of node content/position — see this file's header. */
  private nextPriority(): number {
    this.prioritySeed = (this.prioritySeed + 0x6d2b79f5) | 0;
    let t = this.prioritySeed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Total node count. */
  get size(): number {
    return sz(this.root);
  }

  /** Visible (non-tombstoned) node count. */
  get visibleSize(): number {
    return vis(this.root);
  }

  /** Engine Spec §8.5: indexOf(id) — here taking the already-resolved `Node` (every call site already has it via `byKey`), returning its TOTAL position. O(log N): one map lookup, then a parent-pointer walk summing left-sibling subtree sizes. */
  indexOf(node: Node): number {
    const t = this.mustFind(node);
    let idx = sz(t.left);
    let cur = t;
    while (cur.parent !== null) {
      if (cur.parent.right === cur) {
        idx += sz(cur.parent.left) + 1;
      }
      cur = cur.parent;
    }
    return idx;
  }

  /** Engine Spec §8.5: visibleIndexOf(node) — the count of visible nodes strictly before `node` (its visible position if visible; the position it would occupy if it became visible, if not — the same convention `nodeAtVisible`'s inverse relies on). O(log N). */
  visibleIndexOf(node: Node): number {
    const t = this.mustFind(node);
    let idx = vis(t.left);
    let cur = t;
    while (cur.parent !== null) {
      if (cur.parent.right === cur) {
        idx += vis(cur.parent.left) + (cur.parent.node.deleted ? 0 : 1);
      }
      cur = cur.parent;
    }
    return idx;
  }

  /** Node at TOTAL position `position` (0-indexed), or `undefined` if out of range. Not one of Engine Spec §8.5's five named operations, but required by `integrate()`'s own scan loop — the direct successor to the flat array's `this.nodes[i]`. O(log N). */
  nodeAt(position: number): Node | undefined {
    let t = this.root;
    let k = position;
    while (t !== null) {
      const leftSize = sz(t.left);
      if (k < leftSize) {
        t = t.left;
      } else if (k === leftSize) {
        return t.node;
      } else {
        k -= leftSize + 1;
        t = t.right;
      }
    }
    return undefined;
  }

  /** Engine Spec §8.5: nodeAtVisible(k) — the node at VISIBLE position `k`, or `undefined` if `k` is at or past the visible end (matches `vis[k]` on a plain array, which is likewise `undefined` past the end). O(log N). */
  nodeAtVisible(position: number): Node | undefined {
    let t = this.root;
    let k = position;
    while (t !== null) {
      const leftVis = vis(t.left);
      if (k < leftVis) {
        t = t.left;
        continue;
      }
      if (!t.node.deleted) {
        if (k === leftVis) {
          return t.node;
        }
        k -= leftVis + 1;
        t = t.right;
      } else {
        // `t` itself doesn't count toward a visible position — pass its own non-contribution
        // through without consuming any of `k`.
        k -= leftVis;
        t = t.right;
      }
    }
    return undefined;
  }

  /**
   * Engine Spec §8.5: splice(position, deleteCount, ...insert) — mirrors
   * `Array.prototype.splice`'s own contract exactly, at O(log N) per
   * element rather than array splice's O(N) element-shifting. The engine
   * itself only ever calls this with `deleteCount === 0` (physical
   * removal never happens pre-GC, Invariant I5) — implemented generally
   * per the spec's own contract regardless, since a future phase (GC,
   * Phase 21) may need real removal, and a half-implemented contract
   * operation would be a worse trap than a fully correct, currently-
   * unexercised one.
   */
  splice(position: number, deleteCount: number, ...insert: readonly Node[]): Node[] {
    const [left, rest] = split(this.root, position);
    const [removed, right] = split(rest, deleteCount);

    const removedNodes: Node[] = [];
    inOrder(removed, removedNodes);
    for (const n of removedNodes) {
      this.byNode.delete(n);
    }

    let middle: TreapNode | null = null;
    for (const n of insert) {
      const t: TreapNode = {
        node: n,
        priority: this.nextPriority(),
        left: null,
        right: null,
        parent: null,
        size: 1,
        visibleCount: n.deleted ? 0 : 1,
      };
      this.byNode.set(n, t);
      middle = merge(middle, t);
    }

    this.root = merge(merge(left, middle), right);
    setParent(this.root, null);
    return removedNodes;
  }

  /** `splice(position, 0, node)` — the only shape `engine.ts`'s `integrate()` actually calls. */
  insertAt(position: number, node: Node): void {
    this.splice(position, 0, node);
  }

  /** Engine Spec §8.5: setDeleted(node, deleted) — the SOLE place `node.deleted` is ever written (engine.ts's `applyDelete`/`applyUndelete` call this instead of assigning the field directly), so the augmented `visibleCount` along the ancestor path can never drift out of sync with it. O(log N). */
  setDeleted(node: Node, deleted: boolean): void {
    const t = this.mustFind(node);
    node.deleted = deleted;
    let cur: TreapNode | null = t;
    while (cur !== null) {
      update(cur);
      cur = cur.parent;
    }
  }

  /** Property 6 (Engine Spec §8.5): iteration order identical to S at all times — an in-order traversal of a valid treap visits nodes in POSITION order by construction (that is the treap's own ordering invariant), so this holds regardless of the tree's shape. O(N) — unavoidable for materializing the whole sequence, and no worse than the flat array this replaces cost for the same operation. */
  toArray(): Node[] {
    const out: Node[] = [];
    inOrder(this.root, out);
    return out;
  }

  private mustFind(node: Node): TreapNode {
    const t = this.byNode.get(node);
    if (t === undefined) {
      throw new Error("PositionIndex: node is not present in the index");
    }
    return t;
  }
}
