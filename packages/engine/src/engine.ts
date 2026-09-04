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

  /**
   * Delete-operation metadata needed for garbage collection (Phase 21, Engine Spec §7.3
   * "causal stability", §7.7 "undo horizon") — the SEQ and wall-clock arrival time of each
   * Delete operation this engine has ever seen, keyed by that DELETE OPERATION's own
   * serialized id (never the target's — a node's `deletedBy` can change if a causally-later
   * concurrent delete overrides attribution, and `collect()` must look up whichever delete
   * currently holds it). Populated ONLY when `applyRemote` is called WITH a `context` — every
   * existing caller (the fuzz/property/adversarial suites, `localInsert`/`localDelete`,
   * `SyncClient`) omits it, so this map stays empty for them and {@link collect} finds nothing
   * collectible — collection is opt-in and cannot change behavior for any pre-Phase-21 code
   * path. In practice, only the SERVER's own coordinator engine ever supplies a `context`
   * (seq and wall-clock time are protocol/persistence-layer concepts, deliberately absent from
   * this otherwise-pure engine — the same "accept it as a parameter, never read it yourself"
   * discipline as `observe(remoteCounter)` and `preSkewClock`, Engine Spec C9).
   */
  private readonly deleteContext = new Map<string, { readonly seq: bigint; readonly atMs: number }>();

  /**
   * Highest Lamport counter observed from each replica, across every operation this engine
   * has applied (not just deletes) — a plain-data proxy for "how many operations has this
   * replica minted since [some earlier point]," since the engine otherwise tracks only its
   * OWN clock, never other replicas' individually. Used by {@link collect}'s undo-horizon
   * op-count check (Engine Spec §7.7 Rule 7.3, "200 operations by that user") — pre-auth,
   * "that user" is approximated as "that replica," the same simplification this project has
   * used for every not-yet-real-auth decision since Phase 8/9.
   */
  private readonly maxCounterByReplica = new Map<number, number>();

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
          // (`scanned`) — either because it's ⊥ (the structure's own boundary) or because
          // it's a real node genuinely outside the current scan window entirely.
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
      // GC hygiene (Phase 21): the node is no longer deleted, so whatever delete-context was
      // recorded for its (now-superseded) deletedBy no longer describes anything collectible —
      // drop it rather than let it linger forever across delete/undelete churn.
      if (node.deletedBy !== null) {
        this.deleteContext.delete(serializeId(node.deletedBy));
      }
      this.index.setDeleted(op.target, false, null);
    }
  }

  private doApply(op: Operation): void {
    this.observe(op.id.c);
    const seenCounter = this.maxCounterByReplica.get(op.id.r);
    if (seenCounter === undefined || op.id.c > seenCounter) {
      this.maxCounterByReplica.set(op.id.r, op.id.c);
    }
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
  applyRemote(
    op: Operation,
    context?: { readonly seq: bigint; readonly atMs: number },
  ): { readonly buffered: boolean } {
    if (op.kind === "delete" && context) {
      // Recorded regardless of ready/buffered status below — a Delete's own seq/arrival time
      // is fixed at commit time, independent of when THIS engine gets around to applying it.
      this.deleteContext.set(serializeId(op.id), context);
    }
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
   * Whether `id` currently resolves to a live node in this structure (Phase 24, Engine Spec
   * §7.6). Used only for DIAGNOSTIC purposes by the server's offline-window sweep
   * (packages/server/src/offlineWindowScheduler.ts) — WHICH origin a stuck operation is
   * missing, for logging. It is deliberately NOT the mechanism that decides whether a pending
   * operation gets evicted: every pending operation's missing origin is, by definition,
   * currently absent from this index (that is exactly what "pending" means, Engine Spec §4.2),
   * so this check cannot by itself distinguish a merely-slow, still-arriving dependency from a
   * permanently garbage-collected one (§7.3/§7.6) — only elapsed TIME can (Scope-IN: "buffered
   * > 30s"). See offlineWindowScheduler.ts's own header comment for the full reasoning.
   */
  hasIdentifier(id: Identifier): boolean {
    return this.index.hasIdentifier(id);
  }

  /**
   * Explicitly removes a still-buffered operation from `pending` (Engine Spec §7.6 Rule 7.2:
   * "an evicted replica's queued operations naming since-collected nodes must be explicitly
   * REJECTED... never left in P indefinitely"). Phase 21 built {@link collect} but left this
   * half of Rule 7.2 unbuilt; Phase 24's server-side offline-window sweep is the first and
   * only caller. Matches by the OPERATION's own id (never the origin/target it references) —
   * the same identity discipline `applyRemote()`'s idempotence check and `drain()`'s
   * duplicate-discard already use (Engine Spec §4.5, §6.3): two different operations can
   * legally reference the same target, so matching on anything but the operation's own id
   * could evict the wrong one. Returns whether a matching operation was actually found and
   * removed — `false` is not an error, just means it already drained normally (its dependency
   * arrived) in the time between the caller's own check and this call.
   */
  rejectPending(id: Identifier): boolean {
    const index = this.pending.findIndex((op) => op.id.c === id.c && op.id.r === id.r);
    if (index === -1) {
      return false;
    }
    this.pending.splice(index, 1);
    return true;
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

  /**
   * Garbage collection (Phase 21, Engine Spec §7.3 "causal stability", §7.4 COLLECT,
   * §7.7 "undo horizon"). Physically removes every node that is simultaneously:
   *   1. deleted;
   *   2. deleted by an operation that is causally STABLE — its seq is ≤ `frontier`, meaning
   *      every currently active replica has already observed it (Definition 7.3);
   *   3. not the originLeft/originRight of any node that ISN'T (transitively) also being
   *      collected — a live node may anchor to a dead one, so this is a fixpoint sweep, not a
   *      per-node test (Definition 7.4's own framing);
   *   4. deleted longer ago than the undo horizon — `options.nowMs - <delete's arrival time>
   *      >= options.maxAgeMs`, OR the deleting replica has minted `options.maxOpsPerReplica`
   *      or more further operations since (Rule 7.3's `min(5 minutes, 200 operations)` —
   *      collection is allowed once EITHER bound is crossed, i.e. protection lasts only the
   *      SHORTER of the two windows).
   *
   * A node with NO recorded delete-context (its Delete was applied via a plain `applyRemote`
   * call with no `context` — true for every caller except the server's own coordinator engine)
   * can never satisfy condition 2 and is therefore never collectible — this is what makes
   * collection entirely opt-in and safe to call on any engine, including ones a test built
   * without ever supplying seq/time context.
   *
   * Deliberately NOT wall-clock-reading itself (Engine Spec C9): `options.nowMs` is a plain
   * parameter, exactly like `observe(remoteCounter)` never reads a clock — the caller (the
   * server's GC scheduler) supplies the current time, keeping this method itself pure and
   * deterministic given its inputs.
   */
  collect(frontier: bigint, options: CollectOptions): CollectResult {
    const allNodes = this.nodes; // O(N) materialize, in structural order — see below for why
    // this method reasons over the fully-decoded Node[] view rather than PositionIndex/Block
    // internals directly: Definition 7.4's conditions are node-level, and `nodes` already
    // gives every node's real originLeft/originRight regardless of how blocks group them —
    // block boundaries are a storage detail invisible to this algorithm, exactly as intended.

    // Step 1 (COLLECT line 1): candidates — deleted, causally stable, older than the horizon.
    const candidates = new Set<string>();
    for (const node of allNodes) {
      if (!node.deleted || node.deletedBy === null) {
        continue;
      }
      const context = this.deleteContext.get(serializeId(node.deletedBy));
      if (context === undefined || context.seq > frontier) {
        continue; // no known seq (never GC-eligible) or not yet causally stable
      }
      const agedOut = options.nowMs - context.atMs >= options.maxAgeMs;
      const seenCounter = this.maxCounterByReplica.get(node.deletedBy.r) ?? node.deletedBy.c;
      const outpaced = seenCounter - node.deletedBy.c >= options.maxOpsPerReplica;
      if (!agedOut && !outpaced) {
        continue; // still inside the undo horizon
      }
      candidates.add(serializeId(node.id));
    }
    if (candidates.size === 0) {
      return { collectedCount: 0, incomplete: false };
    }

    // Steps 2-6 (COLLECT lines 2-6): fixpoint anchor exclusion. `collectible` starts as every
    // candidate and shrinks: on each pass, gather every origin referenced by a node NOT
    // (currently) collectible — mathematically `S \ collectible`, which is exactly
    // `(S \ candidates) ∪ (candidates \ collectible)`, the pseudocode's own `anchored` set,
    // just recomputed fresh each pass instead of accumulated incrementally. Simpler to read
    // and audit; same fixed point, since `collectible` only ever shrinks.
    //
    // *** WALL-CLOCK SAFETY CAP (2026-09-03, found via M8-c's own DoD verification) ***
    // A long UNRESOLVED anchor chain (a deleted prefix whose immediately-following content is
    // still live — see CLAUDE.md's Phase 21 entry) forces one fixpoint pass per cascade step,
    // each pass O(N) — measured at 853s wall-clock for a 10,000-deep chain over 90,000 nodes
    // (~680s in the fixpoint itself). Because this loop has no `await` anywhere, an uncapped
    // run of that length would block the ENTIRE Node event loop — not just this document's own
    // GC, but every other document's OPS/PING/HTTP traffic sharing the same process — for the
    // full duration. `options.budgetMs`/`options.clock` (both optional; omitted = no cap, the
    // pre-cap behavior, for every existing caller/test that doesn't care) bound this: the
    // budget is checked ONLY after a FULLY-COMPLETED pass, never mid-pass — but completing a
    // pass cleanly is NOT the same as the fixpoint being SAFE to act on early; see the cutoff
    // site below (search "an incomplete sweep collects ZERO nodes") for the real correctness
    // argument, including a bug an earlier version of this cap got wrong before shipping.
    // `clock` is a plain injected function, invoked here, never a literal wall-clock read of
    // this package's own — Engine Spec C9's purity rule is about this package never READING a
    // clock itself, which an injected callback satisfies the same way `observe(remoteCounter)`
    // and `context.atMs` already do.
    const collectible = new Set(candidates);
    let changed = true;
    let incomplete = false;
    const budgetMs = options.budgetMs;
    const clock = options.clock;
    const startClock = budgetMs !== undefined && clock !== undefined ? clock() : undefined;
    while (changed) {
      changed = false;
      const anchored = new Set<string>();
      for (const node of allNodes) {
        if (collectible.has(serializeId(node.id))) {
          continue; // n itself is (still) being collected — its OWN origins don't protect anything
        }
        if (node.originLeft !== null) {
          anchored.add(serializeId(node.originLeft));
        }
        if (node.originRight !== null) {
          anchored.add(serializeId(node.originRight));
        }
      }
      for (const key of collectible) {
        if (anchored.has(key)) {
          collectible.delete(key);
          changed = true;
        }
      }
      if (startClock !== undefined && budgetMs !== undefined && clock) {
        if (clock() - startClock >= budgetMs) {
          // `changed` reflects THIS just-completed pass: if it's still true, this pass found
          // further shrinkage and the fixpoint had not yet naturally settled — genuinely
          // incomplete. If it's false, this pass found nothing new, i.e. the fixpoint HAD
          // already reached its true, natural conclusion at the same moment the budget was
          // hit — not incomplete, just coincidentally timed.
          incomplete = changed;
          break;
        }
      }
    }
    // *** CORRECTNESS, NOT JUST PERFORMANCE — an incomplete sweep collects NOTHING ***
    // A node still sitting in `collectible` when the loop is cut short is NOT a safe
    // conservative under-approximation — `collectible` only ever SHRINKS as later passes run,
    // which means a node present at THIS moment could still be excluded by a pass that hasn't
    // run yet (i.e. it may in fact still be needed as an anchor, the cascade just hasn't
    // reached it within the budget). Physically removing it now, before the fixpoint has
    // PROVABLY reached its true, stable conclusion, risks leaving some OTHER remaining node's
    // origin dangling — exactly the I4/I5 violation this whole algorithm exists to prevent.
    // (An earlier version of this safety cap got this wrong — traced by hand against the exact
    // R0008-shaped pathological case before being trusted: after just one pass, only the
    // directly-anchored last node of a long chain is excluded, so collecting the rest of the
    // still-`collectible` chain at that point would strand THAT excluded node's own origin.)
    // The only definitely-correct behavior when the budget is hit before natural convergence
    // is to collect ZERO nodes this cycle — bounding wall-clock time is still achieved, but
    // safety is never traded for it. Making genuinely-deep-but-resolvable chains progress
    // across MULTIPLE budget-capped cycles would require persisting fixpoint state between
    // calls (an incremental fixpoint) — explicitly OUT of scope for this safety net; see
    // CLAUDE.md's Phase 21 entry for that as documented future work.
    if (incomplete) {
      return { collectedCount: 0, incomplete: true };
    }
    if (collectible.size === 0) {
      return { collectedCount: 0, incomplete: false };
    }

    // Steps 7-8 (COLLECT lines 7-8): physical removal. `allNodes` is still in structural
    // position order (nothing above mutated the structure), so group `collectible` into
    // maximal contiguous runs and remove each with one `splice` call — O(runs), not
    // O(collectible.size) — processing runs back-to-front so earlier positions stay valid.
    const ranges: Array<{ readonly start: number; readonly count: number }> = [];
    let runStart = -1;
    for (let i = 0; i < allNodes.length; i++) {
      const inSet = collectible.has(serializeId(allNodes[i]!.id));
      if (inSet && runStart === -1) {
        runStart = i;
      } else if (!inSet && runStart !== -1) {
        ranges.push({ start: runStart, count: i - runStart });
        runStart = -1;
      }
    }
    if (runStart !== -1) {
      ranges.push({ start: runStart, count: allNodes.length - runStart });
    }

    for (let i = ranges.length - 1; i >= 0; i--) {
      const { start, count } = ranges[i]!;
      const removed = this.index.splice(start, count);
      for (const node of removed) {
        if (node.deletedBy !== null) {
          this.deleteContext.delete(serializeId(node.deletedBy)); // GC hygiene, same as applyUndelete
        }
      }
    }

    // `incomplete` is always false here — the early return above handles the incomplete case.
    return { collectedCount: collectible.size, incomplete: false };
  }
}

/** {@link Engine.collect}'s tunables — Engine Spec §7.7 Rule 7.3's undo horizon, threaded in
 * as plain data rather than read from a wall clock inside the engine (Engine Spec C9). */
export interface CollectOptions {
  /** The caller's current time, in epoch milliseconds — supplied, never read, by this method. */
  readonly nowMs: number;
  /** A deleted node's tombstone must be at least this old (in ms) to be collectible, UNLESS `maxOpsPerReplica` is reached first (Rule 7.3: `min(5 minutes, 200 operations)`). */
  readonly maxAgeMs: number;
  /** A deleted node's tombstone is also collectible once its deleting replica has minted this many further operations, UNLESS `maxAgeMs` is reached first. */
  readonly maxOpsPerReplica: number;
  /**
   * Optional wall-clock safety cap on the fixpoint sweep (Phase 21, found via a measured 853s
   * pathological case — CLAUDE.md's Phase 21 entry). Both `budgetMs` and `clock` must be
   * supplied together to have any effect; omitting either means NO cap (the original,
   * unbounded-fixpoint behavior — every pre-cap test and caller is unaffected). `clock` is
   * INVOKED by `collect()`, never defined by it — this package still never reads a wall clock
   * itself (Engine Spec C9); see {@link Engine.collect}'s own doc comment for the full
   * reasoning — including a real bug found and fixed BEFORE shipping this: an earlier version
   * of this cap collected whatever remained in the fixpoint's `collectible` set at cutoff,
   * reasoning that set only ever shrinks so a partial result must be "conservative." That's
   * false — a node still in an UNCONVERGED `collectible` set may yet be excluded by a pass
   * that hasn't run, meaning it could still be needed as an anchor. Collecting it anyway risks
   * stranding some OTHER node's origin. The fix (see {@link Engine.collect}'s own comment at
   * the cutoff site): an incomplete sweep collects ZERO nodes, always — bounding wall-clock
   * time without ever trading away correctness.
   */
  readonly budgetMs?: number;
  /** Supplies the current time in epoch milliseconds when invoked — typically a thin wrapper around the platform's own wall clock, defined and kept OUTSIDE this package (e.g. gcScheduler.ts). */
  readonly clock?: () => number;
}

/** {@link Engine.collect}'s result. */
export interface CollectResult {
  /**
   * True iff the fixpoint sweep was cut short by `options.budgetMs` before naturally
   * converging. When `true`, `collectedCount` is ALWAYS `0` — an incomplete sweep NEVER
   * physically removes anything (see {@link CollectOptions.budgetMs}'s own doc comment for
   * why a partial fixpoint result cannot safely be treated as a conservative under-
   * approximation). A caller should expect that a document whose unresolved anchor chain is
   * deeper than the budget allows will keep returning `incomplete: true, collectedCount: 0`
   * on EVERY cycle, indefinitely, until either the budget is raised or (future work — see
   * CLAUDE.md's Phase 21 entry) the fixpoint is made incremental across calls — this is NOT
   * "eventually makes progress across several cycles" today. Worth surfacing as its own
   * metric (`gc.cycle_incomplete_count`): a document that keeps hitting this every cycle
   * without ever transitioning to `collectedCount > 0` is worth knowing about.
   */
  readonly incomplete: boolean;
  /** How many nodes were physically removed from S this call — 0 is normal (nothing due yet), and ALWAYS 0 when `incomplete` is true. */
  readonly collectedCount: number;
}
