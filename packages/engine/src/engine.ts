import type { Identifier } from "./identifier.js";
import { compareIds, serializeId } from "./identifier.js";
import type { Node } from "./node.js";
import type {
  DeleteOperation,
  InsertOperation,
  Operation,
  UndeleteOperation,
} from "./operation.js";
import { isClusterContinuing } from "./grapheme.js";
import { PositionIndex } from "./positionIndex.js";

/** Structural metrics feeding PRD M8 / RFC §7.8's tombstone-ratio observability. */
export interface EngineStats {
  readonly totalElements: number;
  readonly tombstones: number;
  readonly visibleLength: number;
}

/**
 * Test/diagnostic-only record of every clock-affecting call, consumed
 * exclusively by Invariant I0's runtime assertion (invariants.ts, Test
 * Plan §2.6) to independently REPLAY what the clock should be — using
 * only the correct max/increment semantics restated from scratch — and
 * compare that against the engine's actual clock. This is what lets the
 * assertion catch a defect where OBSERVE's body was changed from merging
 * via `Math.max` to an unconditional increment: the replay wouldn't
 * reflect that change (it hard-codes the correct semantics), so it would
 * disagree with the now-wrong actual clock. Mirrors this project's
 * existing "two independent mechanisms" pattern (engine-purity's ESLint
 * rule + grep script) — never read by mint()/observe()/integrate().
 */
export type ClockEvent =
  { readonly kind: "mint" } | { readonly kind: "observe"; readonly remoteCounter: number };

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
 * applyUndelete() (Engine Spec §4.3–§4.6) are Phase 3; the index (§8.5,
 * {@link PositionIndex}) was added Phase 19; garbage collection (§7) is
 * Phase 21; undo (§9) is Phase 36. The shape below exists now so later
 * phases extend one class rather than re-deriving its fields.
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

  /**
   * Ordered node sequence S (Engine Spec Definition 2.2), backed as of
   * Phase 19 by {@link PositionIndex} — a balanced tree, not a flat array
   * (Engine Spec §8.5). `nodes` itself stays a public GETTER returning a
   * fresh in-order traversal, preserving the exact same external shape
   * (`readonly Node[]`) every existing caller across the workspace already
   * relies on (server's replay endpoints, snapshotting, the audit module,
   * every invariant check) — none of them needed to change. This getter is
   * O(N), same as the flat array it replaces would cost for the same
   * "materialize the whole sequence" operation; the actual fix is that nothing
   * on the hot path (integrate()'s origin lookups, localInsert/localDelete's
   * visible-position lookups) calls this getter anymore — see `index` below.
   */
  private readonly index = new PositionIndex();

  get nodes(): readonly Node[] {
    return this.index.toArray();
  }

  /**
   * Origin stamps of operations already applied — the mechanism behind
   * Engine Spec §6.3's idempotence guarantee (applying an already-present
   * identifier is a no-op). Populated starting Phase 3.
   */
  private readonly applied = new Set<string>();

  /** Operations buffered because their causal dependencies are unmet (Engine Spec §4.2). */
  readonly pending: Operation[] = [];

  /** See {@link ClockEvent}. Test/diagnostic-only — never consulted by ordering logic. */
  private readonly clockEvents: ClockEvent[] = [];

  constructor(replicaId: number) {
    this.replicaId = replicaId;
  }

  /** See {@link ClockEvent}. Exposed only for Invariant I0's runtime assertion. */
  get clockEventLog(): readonly ClockEvent[] {
    return this.clockEvents;
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
    this.clockEvents.push({ kind: "mint" });
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
    this.clockEvents.push({ kind: "observe", remoteCounter });
  }

  /** Current clock value. Exposed for tests and diagnostics only — never for ordering decisions. */
  get currentClock(): number {
    return this.clock;
  }

  /**
   * Visible sequence vis(S): non-tombstoned nodes, in structure order
   * (Definition 2.3). O(N) — used only for whole-document reads (`text()`,
   * `stats()`); the per-character hot paths (`localInsert`/`localDelete`)
   * no longer call this (Phase 19) and go straight through `index`.
   */
  visible(): readonly Node[] {
    return this.nodes.filter((n) => !n.deleted);
  }

  /** Materialized document (Definition 2.4): concatenation of visible scalars, in order. */
  text(): string {
    return this.visible()
      .map((n) => String.fromCodePoint(n.value))
      .join("");
  }

  /**
   * Structural metrics: total nodes, tombstone count, visible length. Reads
   * `index.size`/`index.visibleSize` directly (O(1), Phase 19) rather than
   * traversing `this.nodes` — the augmented counts the tree already
   * maintains for every other operation are exactly what this needs too.
   */
  stats(): EngineStats {
    const totalElements = this.index.size;
    const visibleLength = this.index.visibleSize;
    return {
      totalElements,
      tombstones: totalElements - visibleLength,
      visibleLength,
    };
  }

  /**
   * Live block count (Engine Spec §7.5, Phase 20) — diagnostic only, read
   * by no ordering logic, exposed purely so compression can be measured
   * directly (`stats().totalElements / blockCount`) rather than inferred.
   */
  get blockCount(): number {
    return this.index.blockCount;
  }

  /**
   * Resolves an identifier to its materialized Node view. As of Phase 20,
   * {@link PositionIndex} is the SOLE source of truth for identifier
   * resolution — this class no longer keeps its own `byKey` map of stable
   * Node objects (Phase 3/19's design), because block storage means most
   * nodes are no longer stable, persistent objects at all: they're decoded
   * on demand from whichever block currently contains them. Keeping a
   * separate `byKey: Map<string, Node>` here would have held one full Node
   * object per character regardless of what `PositionIndex` did internally
   * — exactly the memory cost block compression exists to eliminate
   * (Engine Spec §7.5, M8-b).
   */
  private nodeById(id: Identifier | null): Node | null {
    if (id === null) {
      return null;
    }
    return this.index.nodeByIdentifier(id) ?? null;
  }

  private isOriginPresent(id: Identifier | null): boolean {
    return id === null || this.index.hasIdentifier(id);
  }

  /**
   * Total-order position of the node identified by `id`, via the O(log N)
   * {@link PositionIndex.indexOf}. Only ever called on an origin that
   * `ready()` has already confirmed present — the thrown error documents
   * that precondition rather than being a reachable runtime case.
   */
  private indexOfOrigin(id: Identifier): number {
    const position = this.index.indexOf(id);
    if (position === undefined) {
      throw new Error(
        `integrate(): origin ${serializeId(id)} is not present — ready() must be checked before integrating`,
      );
    }
    return position;
  }

  /** Causal readiness (Engine Spec Definition 4.1). */
  private ready(op: Operation): boolean {
    if (op.kind === "insert") {
      return this.isOriginPresent(op.originLeft) && this.isOriginPresent(op.originRight);
    }
    return this.index.hasIdentifier(op.target);
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
    const rightIndex =
      node.originRight === null ? this.index.size : this.indexOfOrigin(node.originRight);

    if (leftIndex + 1 === rightIndex) {
      // Nothing currently sits between our origins — no conflict to resolve.
      this.index.insertAt(leftIndex + 1, node);
      return;
    }

    let destIndex = leftIndex + 1;
    // Keyed by serialized identifier, not Node object identity — as of Phase 20, `nodeAt`/
    // `nodeById` decode a FRESH Node object on every call (block storage no longer keeps stable,
    // persistent objects per node, Phase 19's design), so an object-identity Set (`Set<Node>`,
    // Phase 3-19's original shape) would silently never find a match: the SAME logical node read
    // via `nodeAt` at one iteration and via `nodeById` at another would be two different object
    // instances. Re-keying by identifier is the only change here — the algorithm's control flow
    // and comparisons below are byte-for-byte what Phase 3 established.
    const scanned = new Set<string>();
    const conflicting = new Set<string>();

    // Engine Spec §8.2: this window is already effectively constant (p50=0, p95=4, p99=9 on a
    // 20,000-node structure) — direct positional reads here, one per scanned node, are the
    // right call; only the boundary lookups above (leftIndex/rightIndex) and the final
    // placement below needed to move to the O(log N) index (Phase 19).
    for (let i = leftIndex + 1; i < rightIndex; i++) {
      const other = this.index.nodeAt(i);
      if (!other) {
        break;
      }
      const otherKey = serializeId(other.id);
      scanned.add(otherKey);
      conflicting.add(otherKey);

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
        const otherOriginKey = otherOriginNode !== null ? serializeId(otherOriginNode.id) : null;
        if (otherOriginKey !== null && scanned.has(otherOriginKey)) {
          // Case B (nested inside scanned region): the group set test.
          //
          // *** ENGINE SPEC §6.2 SUB-CASE III-D CORRECTION, PART 2 (2026-09-02/03, R0009) ***
          // Group-membership alone ("has this group already lost?") is NOT sound when
          // `other` is chained onto an already-resolved node that was compared against a
          // DIFFERENT pair than the one actually in question. R0009: a wide-window candidate
          // correctly beats a direct competitor via Case A; a later, structurally-unrelated
          // node anchored onto that competitor then blindly inherited its loss via this
          // branch, WITHOUT its own rank vs the candidate ever being consulted — producing
          // SILENT, delivery-order-dependent text divergence ("ipt" vs "itp"), no throw, no
          // canary. For a genuine single-author contiguous run, every member shares its
          // anchor's own replica id, so `compareRank(other, node) < 0` is automatically
          // consistent with the group's decision — this check is a no-op there and RFC NQ-2's
          // non-interleaving guarantee is preserved (verified against a same-author run swept
          // by a concurrent competitor, plus a depth-2 chain crossing an authorship boundary).
          // It only changes behavior when a chain crosses an authorship/replica boundary,
          // which isn't really "one run" to begin with. Full investigation: CLAUDE.md's
          // "Engine Spec §6.2 sub-case iii-d correction" entry; tests/regression/R0009.
          if (conflicting.has(otherOriginKey)) {
            // `other`'s origin is itself still an undetermined member of the current
            // conflict group — stays undecided, keep scanning without moving destIndex.
          } else if (compareRank(other, node) < 0) {
            destIndex = i + 1;
            conflicting.clear();
          } else {
            // The group resolved to "advance," but `other` itself does not outrank `node` —
            // do not blindly inherit. Stop here, mirroring Case A/C's own "other does not
            // outrank us" -> break.
            break;
          }
        } else {
          // Case C: `other`'s own origin lies outside what THIS scan pass has walked
          // (`scanned`) — either because it's ⊥ (the document boundary) or because it's a
          // real node genuinely outside the current window.
          //
          // *** ENGINE SPEC §6.2 SUB-CASE III-D CORRECTION, PART 1 (2026-09-02, R0008) ***
          // Sub-case iii-d, AS ORIGINALLY WRITTEN in the approved Engine Specification,
          // claims a Case C node can NEVER outrank/affect where `node` lands, and until
          // this fix this branch enforced that claim as a live assertion, throwing if
          // violated. That claim is INCORRECT — confirmed as a flaw in the spec's own
          // literal §4.3 pseudocode (line 17's "c.originLeft ≠ ⊥" conjunct), not an
          // implementation deviation. R0008 found it firing at ~24% under ordinary
          // randomized states once "immediate delivery" (a replica broadcasting an
          // operation the instant it's minted — the ordinary shape of real, live
          // multi-user editing) was fuzzed; a variant with no tombstoning at all produced
          // direct, confirmed VISIBLE TEXT divergence ("ipt" vs "pit") from as few as 3
          // operations. This correction has TWO parts — this is part 1; see the Case B
          // branch above for part 2 (R0009), found while validating this fix. Full
          // investigation, root cause, and both fixes: CLAUDE.md's "Engine Spec §6.2
          // sub-case iii-d correction" entry; regression fixtures tests/regression/R0008
          // and R0009 (both permanent, Test Plan §2.3).
          //
          // THE FIX: `other` now gets the SAME rank check Case A/B already give same-window
          // competitors, instead of being unconditionally skipped. This is no longer a
          // "canary that must never fire" — Case C legitimately participates in placement.
          if (compareRank(other, node) < 0) {
            destIndex = i + 1;
            conflicting.clear();
          } else {
            break;
          }
        }
      }
    }

    // Test-build structural sanity check (redefined 2026-09-02/03 — the ORIGINAL canary here
    // asserted Engine Spec §6.2 sub-case iii-d, which R0008 and R0009 both disproved, in two
    // different branches (Case C and Case B respectively); seeing FALSE below would mean
    // `destIndex` was computed outside the window this scan is even allowed to place into —
    // an unrelated, still-live correctness property, true regardless of which branch (A/B/C)
    // decided `destIndex`, worth keeping a cheap, always-on regression canary for.
    if (destIndex < leftIndex + 1 || destIndex > rightIndex) {
      throw new Error(
        `integrate(): computed destIndex ${destIndex} for candidate ${serializeId(node.id)} ` +
          `outside its own scan window [${leftIndex + 1}, ${rightIndex}] — this is an ` +
          "integrate() bookkeeping bug, unrelated to the retired Engine Spec §6.2 sub-case " +
          "iii-d claim (see the Case B/Case C comments above).",
      );
    }

    this.index.insertAt(destIndex, node);
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
    // The new deletedBy is computed from the CURRENT read, then passed into setDeleted
    // together with the tombstone flag in one call — Phase 19's version mutated
    // `node.deletedBy` directly on a live object reference afterward, which cannot work
    // now that a materialized Node view is a disposable snapshot, not a stable object
    // block storage (Phase 20) can keep mutating underneath. PositionIndex.setDeleted is
    // the SOLE place a node's deleted/deletedBy are ever written.
    const newDeletedBy =
      node.deletedBy === null || compareIds(op.id, node.deletedBy) > 0 ? op.id : node.deletedBy;
    this.index.setDeleted(op.target, true, newDeletedBy);
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
      this.index.setDeleted(op.target, false, null);
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

  /**
   * Mints and applies a local insert, returning the operation to broadcast
   * (API Spec §1.4). O(log N) as of Phase 19 — origin lookups go straight
   * through `index.nodeAtVisible()` rather than materializing the whole
   * visible sequence via `visible()` first (the pre-Phase-19 O(N) approach).
   */
  localInsert(
    visibleIndex: number,
    value: number,
    bind: boolean = isClusterContinuing(value),
  ): InsertOperation {
    const leftNode = visibleIndex > 0 ? this.index.nodeAtVisible(visibleIndex - 1) : undefined;
    const rightNode = this.index.nodeAtVisible(visibleIndex);
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
   *
   * O(log N) per removed unit as of Phase 19 (no more `visible()`
   * snapshot). Re-querying the SAME `visibleIndex` against the live,
   * mutating index on every iteration is equivalent to indexing a static
   * snapshot at `visibleIndex, visibleIndex+1, ..., visibleIndex+count-1`:
   * each successful delete removes exactly one unit from vis(S) AT
   * `visibleIndex` itself, so whatever now occupies that same visible
   * position is exactly what would have been next in the original
   * snapshot (removing position P shifts everything after P left by one —
   * what's now at P is what was previously at P+1). This is what the
   * doc comment above means by "as it stood when this call began": the
   * TARGET SET is fixed at call time, even though each lookup is live.
   */
  localDelete(visibleIndex: number, count: number): readonly DeleteOperation[] {
    const ops: DeleteOperation[] = [];
    for (let k = 0; k < count; k++) {
      const target = this.index.nodeAtVisible(visibleIndex);
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
