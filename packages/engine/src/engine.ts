import type { Identifier } from "./identifier.js";
import { compareIds, serializeId } from "./identifier.js";
import type { Node } from "./node.js";
import type { DeleteOperation, InsertOperation, Operation, UndeleteOperation } from "./operation.js";
import { isClusterContinuing } from "./grapheme.js";

/** Structural metrics feeding PRD M8 / RFC §7.8's tombstone-ratio observability. */
export interface EngineStats {
  readonly totalElements: number;
  readonly tombstones: number;
  readonly visibleLength: number;
}

/**
 * Disambiguator rank (Engine Spec Definition 4.2). Binding rank precedes
 * replica id so a combining mark always sorts nearer its base than a
 * concurrently-inserted ordinary character. Engine Spec I8; the failure
 * is order-dependent and invisible in one of two replica-id orderings — §10.8.
 */
function rank(n: Node): readonly [number, number] {
  return [n.bind ? 0 : 1, n.id.r];
}

/** Negative iff `a` outranks `b` (sorts nearer the left origin). */
function compareRank(a: Node, b: Node): number {
  const ra = rank(a);
  const rb = rank(b);
  return ra[0] !== rb[0] ? ra[0] - rb[0] : ra[1] - rb[1];
}

/** Identifier equality, treating `null` (⊥, a structure boundary) as equal only to itself. */
function sameOrigin(a: Identifier | null, b: Identifier | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return compareIds(a, b) === 0;
}

/**
 * OBSEQ convergence engine — Phase 1 shell.
 *
 * This phase implements only the data structures and identifier generation
 * (Engine Spec §2, §3). integrate() / applyRemote() / applyDelete() /
 * applyUndelete() (Engine Spec §4.3–§4.6) are Phase 3; the index (§8.5) is
 * Phase 19; garbage collection (§7) is Phase 21; undo (§9) is Phase 36. The
 * shape below exists now so later phases extend one class rather than
 * re-deriving its fields.
 *
 * Purity: this class touches nothing but its own in-memory fields. No DOM,
 * no network, no storage, no wall clock — enforced independently by
 * eslint.config.js and scripts/check-engine-purity.mjs.
 */
export class Engine {
  readonly replicaId: number;

  /**
   * Lamport clock. Advanced ONLY by mint() (+1) and observe() (max) — see
   * their docstrings. Never read or written anywhere else in this class.
   */
  private clock = 0;

  /** Ordered node sequence S (Engine Spec Definition 2.2). Populated starting Phase 3. */
  readonly nodes: Node[] = [];

  /** Identifier → Node lookup K (Engine Spec Definition 2.2), keyed by a serialized identifier. */
  private readonly byKey = new Map<string, Node>();

  /**
   * Origin stamps of operations already applied — the mechanism behind
   * Engine Spec §6.3's idempotence guarantee (applying an already-present
   * identifier is a no-op). Populated starting Phase 3.
   */
  private readonly applied = new Set<string>();

  /** Operations buffered because their causal dependencies are unmet (Engine Spec §4.2). */
  readonly pending: Operation[] = [];

  constructor(replicaId: number) {
    this.replicaId = replicaId;
  }

  /**
   * Mints a NEW local identifier. Advances the clock by exactly 1.
   *
   * Engine Spec §3.4 documents a real defect: an earlier implementation
   * advanced the clock TWICE per local operation, because a combined
   * tick-and-merge routine called this same increment a second time when
   * the freshly-minted operation was applied locally. Convergence was
   * completely unaffected — identifiers stayed unique and totally ordered,
   * and all 60,000 fuzz seeds passed — but counters for sequential typing
   * ran 1,3,5,7,9 instead of 1,2,3,4,5. Consecutive counters are exactly
   * what RFC §7.5's block run-length encoding requires (Engine Spec
   * Definition 7.5, condition 2), so block compression on ordinary typing
   * silently collapsed from a measured 20,000x to 1.0x — the entire M8
   * memory-recovery strategy stopped working, with every correctness test
   * still green. Invariant I0 exists because of this exact failure, and it
   * is why mint() and observe() are separate methods below and must NEVER
   * be merged into one "tick-and-merge" routine, no matter how convenient
   * that looks at a call site.
   */
  mint(): Identifier {
    this.clock += 1;
    return { c: this.clock, r: this.replicaId };
  }

  /**
   * Merges a REMOTE Lamport counter into the clock WITHOUT minting.
   * Called when integrating any operation this replica did not originate,
   * so that a later local mint() cannot produce a counter the remote side
   * has already used. Deliberately separate from mint() — see its
   * docstring for why merging the two is the exact defect Invariant I0
   * guards against.
   */
  observe(remoteCounter: number): void {
    this.clock = Math.max(this.clock, remoteCounter);
  }

  /** Current clock value. Exposed for tests and diagnostics only — never for ordering decisions. */
  get currentClock(): number {
    return this.clock;
  }

  /** Visible sequence vis(S): non-tombstoned nodes, in structure order (Definition 2.3). */
  visible(): readonly Node[] {
    return this.nodes.filter((n) => !n.deleted);
  }

  /** Materialized document (Definition 2.4): concatenation of visible scalars, in order. */
  text(): string {
    return this.visible()
      .map((n) => String.fromCodePoint(n.value))
      .join("");
  }

  /** Structural metrics: total nodes, tombstone count, visible length. */
  stats(): EngineStats {
    let tombstones = 0;
    for (const n of this.nodes) {
      if (n.deleted) {
        tombstones += 1;
      }
    }
    return {
      totalElements: this.nodes.length,
      tombstones,
      visibleLength: this.nodes.length - tombstones,
    };
  }

  private nodeById(id: Identifier | null): Node | null {
    if (id === null) {
      return null;
    }
    return this.byKey.get(serializeId(id)) ?? null;
  }

  private isOriginPresent(id: Identifier | null): boolean {
    return id === null || this.byKey.has(serializeId(id));
  }

  /**
   * Index of the node identified by `id` within `this.nodes`. Only ever
   * called on an origin that `ready()` has already confirmed present —
   * the thrown error documents that precondition rather than being a
   * reachable runtime case.
   */
  private indexOfOrigin(id: Identifier): number {
    const node = this.byKey.get(serializeId(id));
    if (node === undefined) {
      throw new Error(
        `integrate(): origin ${serializeId(id)} is not present — ready() must be checked before integrating`,
      );
    }
    return this.nodes.indexOf(node);
  }

  /** Causal readiness (Engine Spec Definition 4.1). */
  private ready(op: Operation): boolean {
    if (op.kind === "insert") {
      return this.isOriginPresent(op.originLeft) && this.isOriginPresent(op.originRight);
    }
    return this.byKey.has(serializeId(op.target));
  }

  /**
   * Origin-bounded integration (Engine Spec §4.3). Places `node` into
   * `this.nodes` at the position the total order requires, scanning only
   * the region strictly between its origins and resolving every
   * concurrent insert anchored there without ever consulting arrival
   * order — see Engine Spec §10.1–§10.8 for the worked traces this
   * algorithm is checked against.
   */
  private integrate(node: Node): void {
    const leftIndex = node.originLeft === null ? -1 : this.indexOfOrigin(node.originLeft);
    const rightIndex = node.originRight === null ? this.nodes.length : this.indexOfOrigin(node.originRight);

    if (leftIndex + 1 === rightIndex) {
      // Nothing currently sits between our origins — no conflict to resolve.
      this.nodes.splice(leftIndex + 1, 0, node);
      return;
    }

    let destIndex = leftIndex + 1;
    const scanned = new Set<Node>();
    const conflicting = new Set<Node>();

    for (let i = leftIndex + 1; i < rightIndex; i++) {
      const other = this.nodes[i];
      if (!other) {
        break;
      }
      scanned.add(other);
      conflicting.add(other);

      if (sameOrigin(node.originLeft, other.originLeft)) {
        // Case A: `other` was anchored at the same left origin as `node`.
        if (compareRank(other, node) < 0) {
          destIndex = i + 1;
          conflicting.clear();
        } else if (sameOrigin(node.originRight, other.originRight)) {
          // Case A line 13: the originRight equality test. This is what prevents two users'
          // concurrently-typed runs from interleaving character-by-character. Without it,
          // the RFC's prototype produced "[zcybxa]" instead of "[cbazyx]" — convergent but
          // intention-violating. Engine Spec §4.3, resolved as RFC NQ-2; trace at §10.7.
          break;
        }
        // else: same left origin, different right origin, `other` outranks `node` —
        // still undetermined, keep scanning without moving destIndex.
      } else {
        const otherOriginNode = this.nodeById(other.originLeft);
        if (otherOriginNode !== null && scanned.has(otherOriginNode)) {
          // Case B (nested inside scanned region): the group set test.
          if (!conflicting.has(otherOriginNode)) {
            destIndex = i + 1;
            conflicting.clear();
          }
          // else: `other`'s origin is itself still an undetermined member of the
          // current conflict group — stays undecided, keep scanning.
        } else {
          // Case C: `other`'s origin lies outside this conflict group entirely.
          break;
        }
      }
    }

    this.nodes.splice(destIndex, 0, node);
  }

  private applyInsert(op: InsertOperation): void {
    const node: Node = {
      id: op.id,
      value: op.value,
      originLeft: op.originLeft,
      originRight: op.originRight,
      bind: op.bind,
      deleted: false,
      deletedBy: null,
    };
    this.byKey.set(serializeId(op.id), node);
    this.integrate(node);
  }

  /**
   * Causally-latest deletedBy rule (Engine Spec §4.5 line 3): concurrent
   * deletes of the same node all tombstone it, but attribution — needed
   * for undo's resurrection question, §9.3 — goes to whichever delete is
   * causally latest under the identifier total order, never to whichever
   * delete simply arrived last.
   */
  private applyDelete(op: DeleteOperation): void {
    const node = this.nodeById(op.target);
    if (node === null) {
      throw new Error(`applyDelete(): target ${serializeId(op.target)} is not present`);
    }
    node.deleted = true;
    if (node.deletedBy === null || compareIds(op.id, node.deletedBy) > 0) {
      node.deletedBy = op.id;
    }
  }

  /**
   * Structural inverse of applyDelete, using the same causally-latest
   * comparison. Full resurrection semantics (interaction with redo
   * history) are Phase 36 (Engine Spec §9.3) — this is deliberately the
   * minimal shape that makes the operation type usable end to end.
   */
  private applyUndelete(op: UndeleteOperation): void {
    const node = this.nodeById(op.target);
    if (node === null) {
      throw new Error(`applyUndelete(): target ${serializeId(op.target)} is not present`);
    }
    if (node.deletedBy === null || compareIds(op.id, node.deletedBy) > 0) {
      node.deleted = false;
      node.deletedBy = null;
    }
  }

  private doApply(op: Operation): void {
    this.observe(op.id.c);
    switch (op.kind) {
      case "insert":
        this.applyInsert(op);
        break;
      case "delete":
        this.applyDelete(op);
        break;
      case "undelete":
        this.applyUndelete(op);
        break;
    }
    this.applied.add(serializeId(op.id));
  }

  /**
   * Drains `pending` to a fixpoint. Applying one operation can satisfy the
   * causal dependency of another that arrived earlier and was buffered, so
   * a single pass is not sufficient (Engine Spec §4.2) — this loop keeps
   * sweeping until a full pass makes no progress.
   */
  private drain(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const op = this.pending[i];
        if (!op) {
          continue;
        }
        if (this.applied.has(serializeId(op.id))) {
          // Already applied via another (duplicate) delivery — discard.
          this.pending.splice(i, 1);
          progressed = true;
        } else if (this.ready(op)) {
          this.doApply(op);
          this.pending.splice(i, 1);
          progressed = true;
        }
      }
    }
  }

  /**
   * Applies a remote operation. Idempotent: re-delivering an operation
   * whose id has already been applied is a no-op (Engine Spec §6.3).
   * `buffered: true` means the operation's causal dependencies were unmet
   * and it was queued rather than applied — normal, never an error
   * (Engine Spec §4.2).
   */
  applyRemote(op: Operation): { readonly buffered: boolean } {
    if (this.applied.has(serializeId(op.id))) {
      return { buffered: false };
    }
    if (this.ready(op)) {
      this.doApply(op);
      this.drain();
      return { buffered: false };
    }
    this.pending.push(op);
    return { buffered: true };
  }

  /** Mints and applies a local insert, returning the operation to broadcast (API Spec §1.4). */
  localInsert(visibleIndex: number, value: number, bind: boolean = isClusterContinuing(value)): InsertOperation {
    const vis = this.visible();
    const leftNode = visibleIndex > 0 ? vis[visibleIndex - 1] : undefined;
    const rightNode = visibleIndex < vis.length ? vis[visibleIndex] : undefined;
    const op: InsertOperation = {
      kind: "insert",
      id: this.mint(),
      value,
      originLeft: leftNode ? leftNode.id : null,
      originRight: rightNode ? rightNode.id : null,
      bind,
    };
    this.applyInsert(op);
    this.applied.add(serializeId(op.id));
    return op;
  }

  /**
   * Mints and applies up to `count` local deletes starting at
   * `visibleIndex` (against the visible sequence as it stood when this
   * call began), returning one operation per removed unit with
   * consecutive counters in return order (API Spec §1.4).
   */
  localDelete(visibleIndex: number, count: number): readonly DeleteOperation[] {
    const vis = this.visible();
    const ops: DeleteOperation[] = [];
    for (let k = 0; k < count; k++) {
      const target = vis[visibleIndex + k];
      if (!target) {
        break;
      }
      const op: DeleteOperation = { kind: "delete", id: this.mint(), target: target.id };
      this.applyDelete(op);
      this.applied.add(serializeId(op.id));
      ops.push(op);
    }
    return ops;
  }
}
