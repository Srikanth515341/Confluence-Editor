import type { Identifier } from "./identifier.js";
import { serializeId } from "./identifier.js";
import type { Node } from "./node.js";

/**
 * The tree data structure behind the Fugue port (2026-09-05) — Weidner &
 * Kleppmann, "The Art of the Fugue: Minimizing Interleaving in
 * Collaborative Text Editing" (arXiv:2305.00583). Ported from the paper
 * author's own real, published reference implementation, fetched
 * directly from source (not recalled from memory or reconstructed from
 * the paper's prose alone):
 * https://raw.githubusercontent.com/mweidner037/fugue/main/fugue-simple/src/index.ts
 * — the `Tree`/`addNode`/`getByIndex`/`traverse` logic below is a direct
 * port of that file's own `Tree<T>` class, adapted to this project's own
 * `Identifier{r,c}`/`Node` shapes and its ONE required domain-specific
 * substitution: sibling order among same-side children is `bind`-then-
 * replica-id (Engine Spec Definition 4.2/Invariant I8), not the reference
 * implementation's own plain ascending-sender-id — see `siblingRank`'s own
 * doc comment for the hand-trace this substitution needed before being
 * trusted.
 *
 * WHY THIS REPLACES `PositionIndex` (Phase 19) ENTIRELY, not just
 * `Engine.integrate()`: unlike the retired YATA-family scan (which
 * recomputed a node's position by re-resolving `originLeft`/`originRight`
 * against the CURRENT structure on every `integrate()` call — the exact
 * mechanism R0010/R0011 exploited, since two nodes never directly
 * compared could end up in opposite relative order on different
 * replicas), a Fugue node's `parent`+`side` are decided ONCE, at
 * creation, and NEVER recomputed. The total order is a pure function of
 * fixed parent/side/sibling-order relationships (in-order traversal),
 * which cannot invert, because there is no pair of separately-tracked
 * boundary identifiers whose resolved positions could drift apart. See
 * CLAUDE.md's "Fugue port" entry for the full investigation, the citation
 * of production Yjs's own independently-confirmed identical defect, and
 * the verification that R0008/R0009/R0010/R0011 and RFC NQ-2 all pass
 * under this exact algorithm before it was ever wired into `Engine`.
 */

interface TreeNode {
  readonly id: Identifier;
  value: number;
  bind: boolean;
  deleted: boolean;
  deletedBy: Identifier | null;
  parent: TreeNode | null;
  side: "L" | "R";
  readonly leftChildren: TreeNode[];
  readonly rightChildren: TreeNode[];
  /** Non-deleted count of this subtree, INCLUDING self if self is visible (Definition 2.3). Root's own "self" is never counted (it isn't a real node). */
  visibleSize: number;
  /** Total node count of this subtree, INCLUDING self (root's own "self" is never counted). */
  totalSize: number;
}

/**
 * `[bind ? 0 : 1, id.r]` — identical in shape to the retired YATA port's
 * own `rank()` (Engine Spec Definition 4.2), reused here as the sibling
 * tie-break among nodes attached to the SAME parent on the SAME side,
 * REPLACING the reference implementation's own plain ascending-
 * sender-id rule. Hand-traced before being trusted (CLAUDE.md's "Fugue
 * port" entry has the full account): a combining mark (`bind: true`)
 * always sorts nearer its base than a concurrently-attached ordinary
 * character on the same side of the same parent, regardless of replica
 * id — the same I8 guarantee the retired YATA port's own `compareRank`
 * substitution provided. Verified against RFC NQ-2's own backward-typing
 * non-interleaving trace (ordinary characters, no combining marks
 * involved, so this substitution changes nothing there) and against a
 * dedicated I8 grapheme-cluster scenario (see engine.test.ts).
 */
function siblingRank(n: TreeNode): readonly [number, number] {
  return [n.bind ? 0 : 1, n.id.r];
}

function siblingLess(a: TreeNode, b: TreeNode): boolean {
  const ra = siblingRank(a);
  const rb = siblingRank(b);
  return ra[0] !== rb[0] ? ra[0] < rb[0] : ra[1] < rb[1];
}


export class FugueTree {
  private readonly root: TreeNode;
  private readonly byId = new Map<string, TreeNode>();

  constructor() {
    this.root = {
      id: { c: 0, r: 0 }, // sentinel — never a real, externally-visible identifier (real counters start at 1)
      value: -1,
      bind: false,
      deleted: true,
      deletedBy: null,
      parent: null,
      side: "R",
      leftChildren: [],
      rightChildren: [],
      visibleSize: 0,
      totalSize: 0,
    };
  }

  get size(): number {
    return this.root.totalSize;
  }

  get visibleSize(): number {
    return this.root.visibleSize;
  }

  hasIdentifier(id: Identifier): boolean {
    return this.byId.has(serializeId(id));
  }

  /**
   * Converts an internal {@link TreeNode} to the public {@link Node} shape.
   * `t.parent` is NEVER JS `null` internally (a node attached "under the
   * root" stores an actual pointer to the root sentinel TreeNode, per
   * `attach()`'s own `parentId === null ? this.root : ...` resolution) —
   * this is the ONE place that distinction is translated back to the
   * public contract (`Node.parent === null` for a document-start
   * attachment). A real bug was found and fixed here during this port's
   * own verification (not by review): an earlier free-function version of
   * this conversion had no way to compare against `this.root` at all and
   * checked `t.parent === null` instead — which is never true — leaking
   * the root sentinel's own reserved identifier `{c:0,r:0}` out as if it
   * were a real, meaningful parent reference. Caught immediately by
   * Invariant I4 ("parent {0:0} is not present in the structure") the
   * first time `assertInvariants` ran against real GC output.
   */
  private toPublicNode(t: TreeNode): Node {
    return {
      id: t.id,
      value: t.value,
      parent: t.parent === null || t.parent === this.root ? null : t.parent.id,
      side: t.side,
      bind: t.bind,
      deleted: t.deleted,
      deletedBy: t.deletedBy,
    };
  }

  nodeByIdentifier(id: Identifier): Node | undefined {
    const t = this.byId.get(serializeId(id));
    return t === undefined ? undefined : this.toPublicNode(t);
  }

  /**
   * Attaches a new node with the given (already-decided) `parent`/`side`
   * — the direct analogue of the reference implementation's own
   * `addNode`. `parentId === null` attaches directly under the tree's own
   * root sentinel (Fugue's own document-start/document-empty case).
   * Throws if `parentId` doesn't resolve — the same "caller must have
   * already checked readiness" precondition the retired `integrate()`
   * documented for its own origin lookups.
   */
  attach(id: Identifier, value: number, bind: boolean, parentId: Identifier | null, side: "L" | "R"): void {
    const parent = parentId === null ? this.root : this.byId.get(serializeId(parentId));
    if (parent === undefined) {
      throw new Error(`FugueTree.attach(): parent ${parentId ? serializeId(parentId) : "null"} is not present`);
    }
    const node: TreeNode = {
      id,
      value,
      bind,
      deleted: false,
      deletedBy: null,
      parent,
      side,
      leftChildren: [],
      rightChildren: [],
      visibleSize: 0,
      totalSize: 0,
    };
    this.byId.set(serializeId(id), node);
    const siblings = side === "L" ? parent.leftChildren : parent.rightChildren;
    let i = 0;
    for (; i < siblings.length; i++) {
      if (siblingLess(node, siblings[i]!)) break;
    }
    siblings.splice(i, 0, node);
    this.updateSize(node, 1, 1);
  }

  private updateSize(node: TreeNode, deltaTotal: number, deltaVisible: number): void {
    for (let anc: TreeNode | null = node; anc !== null; anc = anc.parent) {
      anc.totalSize += deltaTotal;
      anc.visibleSize += deltaVisible;
    }
  }

  setDeleted(id: Identifier, deleted: boolean, deletedBy: Identifier | null): void {
    const node = this.byId.get(serializeId(id));
    if (node === undefined) {
      throw new Error(`FugueTree.setDeleted(): ${serializeId(id)} is not present`);
    }
    if (node.deleted === deleted) {
      node.deletedBy = deletedBy;
      return;
    }
    node.deleted = deleted;
    node.deletedBy = deletedBy;
    this.updateSize(node, 0, deleted ? -1 : 1);
  }

  /**
   * Returns the node at the given VISIBLE index (Definition 2.3), via the
   * reference implementation's own iterative (non-recursive, to avoid
   * stack overflow at depth — same reasoning as the reference's own
   * comment) tree walk.
   */
  nodeAtVisible(visibleIndex: number): Node | undefined {
    if (visibleIndex < 0 || visibleIndex >= this.root.visibleSize) {
      return undefined;
    }
    let node = this.root;
    let remaining = visibleIndex;
    for (;;) {
      let found: TreeNode | undefined;
      for (const child of node.leftChildren) {
        if (remaining < child.visibleSize) {
          node = child;
          found = child;
          break;
        }
        remaining -= child.visibleSize;
      }
      if (found) continue;
      if (!node.deleted && node !== this.root) {
        if (remaining === 0) return this.toPublicNode(node);
        remaining -= 1;
      }
      for (const child of node.rightChildren) {
        if (remaining < child.visibleSize) {
          node = child;
          found = child;
          break;
        }
        remaining -= child.visibleSize;
      }
      if (found) continue;
      throw new Error("FugueTree.nodeAtVisible(): index in range but not found — internal bookkeeping bug");
    }
  }

  /**
   * Fugue's own `createBetween`-style placement decision (the paper's own
   * Case 1/Case 2), computed from the CURRENT tree state at the visible
   * position immediately before an insertion point — used by
   * `Engine.localInsert()` to decide the `parent`/`side` a NEW local
   * operation will carry on the wire. `visibleIndex === 0` anchors
   * directly under the tree's own root (document-start case, `parent:
   * null` on the wire).
   */
  decidePlacement(visibleIndex: number): { readonly parent: Identifier | null; readonly side: "L" | "R" } {
    const leftOriginNode =
      visibleIndex === 0 ? this.root : this.byIdOrThrow(this.nodeAtVisibleRequired(visibleIndex - 1).id);
    if (leftOriginNode.rightChildren.length === 0) {
      return { parent: leftOriginNode === this.root ? null : leftOriginNode.id, side: "R" };
    }
    const rightOrigin = this.leftmostDescendant(leftOriginNode.rightChildren[0]!);
    return { parent: rightOrigin.id, side: "L" };
  }

  private nodeAtVisibleRequired(visibleIndex: number): Node {
    const n = this.nodeAtVisible(visibleIndex);
    if (!n) throw new Error(`FugueTree: visible index ${visibleIndex} out of range`);
    return n;
  }

  private byIdOrThrow(id: Identifier): TreeNode {
    const t = this.byId.get(serializeId(id));
    if (t === undefined) throw new Error(`FugueTree: ${serializeId(id)} is not present`);
    return t;
  }

  private leftmostDescendant(node: TreeNode): TreeNode {
    let desc = node;
    while (desc.leftChildren.length !== 0) {
      desc = desc.leftChildren[0]!;
    }
    return desc;
  }

  /** In-order traversal (left children, self, right children — each side in its own sibling order), excluding the root sentinel. Same iterative-stack approach as the reference implementation, for the same stack-depth reason. */
  toArray(): Node[] {
    const out: Node[] = [];
    let current: TreeNode = this.root;
    const stack: { side: "L" | "R"; childIndex: number }[] = [{ side: "L", childIndex: 0 }];
    for (;;) {
      const top = stack[stack.length - 1]!;
      const children = top.side === "L" ? current.leftChildren : current.rightChildren;
      if (top.childIndex === children.length) {
        if (top.side === "L") {
          if (current !== this.root) out.push(this.toPublicNode(current));
          top.side = "R";
          top.childIndex = 0;
        } else {
          if (current.parent === null) return out;
          current = current.parent;
          stack.pop();
        }
      } else {
        const child = children[top.childIndex]!;
        top.childIndex++;
        if (child.totalSize > 0) {
          current = child;
          stack.push({ side: "L", childIndex: 0 });
        }
      }
    }
  }

  /**
   * Physically unlinks `id` from the tree (Phase 21 GC, Engine Spec §7.4
   * COLLECT). Callers (see `Engine.collect()`) guarantee, via the SAME
   * fixpoint "anchored" exclusion the retired flat-array design used,
   * that `id` is not currently the `parent` of any node that isn't ALSO
   * being removed in the same batch — Fugue's own analogue of
   * Invariant I5 ("no live node's origin is removed out from under it")
   * is "no surviving node's `parent` reference dangles." Unlike the
   * retired `PositionIndex.splice()` (which removed a CONTIGUOUS
   * structural-position range in one call), this removes ONE node at a
   * time by unlinking it from its own current parent's sibling array —
   * simpler than the flat-array range removal, since a Fugue node has no
   * "neighbors to shift" the way a flat array's remaining elements did.
   */
  remove(id: Identifier): Node | undefined {
    const node = this.byId.get(serializeId(id));
    if (node === undefined) return undefined;
    const parent = node.parent;
    if (parent === null) {
      throw new Error("FugueTree.remove(): cannot remove a node with no parent (would orphan the root)");
    }
    if (node.leftChildren.length > 0 || node.rightChildren.length > 0) {
      throw new Error(
        `FugueTree.remove(): ${serializeId(id)} still has children — caller must guarantee no surviving node's parent reference would dangle`,
      );
    }
    const siblings = node.side === "L" ? parent.leftChildren : parent.rightChildren;
    const idx = siblings.indexOf(node);
    if (idx !== -1) siblings.splice(idx, 1);
    this.updateSize(node, -1, node.deleted ? 0 : -1);
    this.byId.delete(serializeId(id));
    return this.toPublicNode(node);
  }

  /**
   * Phase 25 (Option 2 / R0012's own scoped mitigation, Engine Spec §7.6 Rule 7.2) — a safe,
   * NON-THROWING variant of {@link remove} for reverting a client's own LOCALLY-INTEGRATED
   * insert that the server has explicitly rejected (`OFFLINE_WINDOW_EXCEEDED`) well after this
   * client already applied it synchronously at mint time (this project's own real-time-feel
   * design, Phase 3/10). Unlike GC's own caller, which pre-computes a whole fixpoint batch and
   * GUARANTEES no live child exists before ever calling {@link remove}, a rejection can arrive
   * at ANY time relative to what the user has typed SINCE — including more characters chained
   * directly onto the now-rejected node's own id. This method makes that check itself, atomically
   * with the removal, rather than trusting the caller to have already proven it:
   *
   * - The COMMON ("clean") case: nothing anchors to `id` yet — safe to remove, identical in
   *   effect to {@link remove} (same unlink + size bookkeeping), returned as the removed node.
   * - The CASCADING case: something (the SAME user's own next keystroke, chained via Fugue's own
   *   `decidePlacement` "attach right after the last thing I typed" rule, Phase 3/10) already
   *   has `id` as its own `parent` — removing `id` here would leave THAT node's own `parent`
   *   reference dangling (Engine Spec I4/I5). This method deliberately does NOTHING structural
   *   in that case and returns `undefined` — the caller's own existing preserve-only fallback
   *   (SyncClient's `rejectedOps`, Phase 24) is what's expected to run instead.
   */
  tryRemoveLeaf(id: Identifier): Node | undefined {
    const node = this.byId.get(serializeId(id));
    if (node === undefined) return undefined; // already gone somehow — nothing to revert
    if (node.parent === null) return undefined; // would orphan the root — never expected for a real insert, defensive only
    if (node.leftChildren.length > 0 || node.rightChildren.length > 0) {
      return undefined; // the cascading case — refuse, rather than risk a dangling reference
    }
    const parent = node.parent;
    const siblings = node.side === "L" ? parent.leftChildren : parent.rightChildren;
    const idx = siblings.indexOf(node);
    if (idx !== -1) siblings.splice(idx, 1);
    this.updateSize(node, -1, node.deleted ? 0 : -1);
    this.byId.delete(serializeId(id));
    return this.toPublicNode(node);
  }

  /**
   * Phase 32 (API Spec §7.5.3's `resolveCaret`, reinterpreted for a tree — see
   * `Engine.resolveCaret`'s own doc comment for the full contract and the correction from the
   * pre-Fugue, flat-array design this replaces). Returns the number of VISIBLE nodes at-or-before
   * `id`'s own position in the tree's in-order traversal (Definition 2.3's `vis(S)` order) —
   * which is EXACTLY the caret contract's "visible index immediately right of the nearest
   * surviving node at or before `id`," computed WITHOUT a separate "walk left to find a
   * survivor" step:
   *
   *   - If `id` is currently LIVE: the augmented `visibleSize` fields already give the count of
   *     visible nodes in `id`'s own left subtree; adding 1 for `id` itself, then adding every
   *     preceding sibling-subtree's `visibleSize` while walking up to the root, yields precisely
   *     `id`'s own 0-based rank among visible nodes, plus one — "immediately right of a live
   *     node."
   *   - If `id` is currently TOMBSTONED: the identical sum (this time WITHOUT the "+1 for self",
   *     since a tombstoned node contributes 0 to its own `visibleSize`) yields the count of
   *     visible nodes STRICTLY BEFORE `id`'s position — which is, by construction, exactly the
   *     rank-plus-one of whichever LIVE node is nearest to `id` in in-order traversal (every
   *     visible node strictly before a given position is, definitionally, every visible node up
   *     to and including that nearest live predecessor). No explicit "walk left through the
   *     structure looking for a survivor" is needed — the aggregate sum already IS that answer.
   *   - If `id` was never known, or has since been PHYSICALLY removed by GC (Phase 21) — a case
   *     the pre-Fugue design never had to consider, since it predates GC removing anything from
   *     the flat sequence outright — there is no position left to resolve at all. This falls back
   *     to 0 (document start), the same "no survivor exists" answer the contract already defines
   *     for an entirely-tombstoned prefix; disclosed here as a graceful-degradation case, the same
   *     category of fallback `reconcileOfflineQueue.ts`'s own `visibleIndexAfter` already
   *     documents for an unresolvable anchor (Phase 22/24).
   *
   * Cost is O(depth) — the SAME cost class every other position-aware `FugueTree` operation
   * already carries (`nodeAtVisible`, `decidePlacement`), including this project's own already-
   * disclosed Fugue O(N) worst-case chain depth for purely sequential typing (CLAUDE.md's Open
   * Item 3) — not a new performance regression introduced by this phase.
   *
   * Determinism (API Spec §7.5.3: "MUST be... identical on every replica"): every input this
   * method reads (`visibleSize`, `deleted`, `parent`, `side`, sibling order) is a pure function of
   * the SET of operations applied, never of delivery order or wall-clock time — the same property
   * that makes this tree's full STRUCTURE (not merely its visible text) identical across any two
   * replicas that have applied the same operations (see this file's own header comment on why
   * Fugue's `parent`/`side` are decided once and never recomputed). Two replicas holding the same
   * tree therefore always compute the identical answer for the identical `id` — verified directly
   * across three independently-converged replicas by `engine.test.ts`'s CUR-04 test.
   */
  visibleIndexRightOf(id: Identifier | null): number {
    if (id === null) return 0;
    const node = this.byId.get(serializeId(id));
    if (node === undefined) return 0; // unknown or GC-collected — no resolvable position; see doc comment
    let count = 0;
    for (const child of node.leftChildren) count += child.visibleSize;
    if (!node.deleted) count += 1;
    let cur: TreeNode = node;
    while (cur.parent !== null) {
      const parent = cur.parent;
      if (cur.side === "L") {
        for (const sib of parent.leftChildren) {
          if (sib === cur) break;
          count += sib.visibleSize;
        }
      } else {
        for (const sib of parent.leftChildren) count += sib.visibleSize;
        if (parent !== this.root && !parent.deleted) count += 1;
        for (const sib of parent.rightChildren) {
          if (sib === cur) break;
          count += sib.visibleSize;
        }
      }
      cur = parent;
    }
    return count;
  }
}
