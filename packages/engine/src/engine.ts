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
import { FugueTree } from "./fugueTree.js";

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
 * OBSEQ convergence engine.
 *
 * As of 2026-09-05 (the "Fugue port"), positioning is implemented via
 * {@link FugueTree} — Weidner & Kleppmann's Fugue algorithm
 * (arXiv:2305.00583) — REPLACING the prior YATA-family scan entirely
 * (Phase 3's own Case A/B/C derivation, later a direct port of the real
 * published YATA algorithm as of the R0010 correction). See CLAUDE.md's
 * "Fugue port" entry for the full investigation: FOUR distinct
 * convergence defects (R0008, R0009, R0010, R0011) were found across
 * this project's own hand-derived scan, the real published YATA
 * algorithm, AND production Yjs's own shipped code — all stemming from
 * the SAME root cause (a scan window between two separately-tracked
 * origin identifiers must be re-resolved against the CURRENT structure on
 * every integration, and two nodes never directly compared can end up in
 * opposite relative order on different replicas). Fugue's own design has
 * no analogue of that mechanism: a node's tree attachment (`parent` +
 * `side`) is decided ONCE, at creation, and never recomputed.
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
   * Ordered node sequence S (Engine Spec Definition 2.2), backed by
   * {@link FugueTree} — a tree, not a flat array or treap. `nodes` stays a
   * public GETTER returning a fresh in-order traversal, preserving the
   * exact same external shape (`readonly Node[]`) every existing caller
   * across the workspace already relies on.
   */
  private readonly tree = new FugueTree();

  get nodes(): readonly Node[] {
    return this.tree.toArray();
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
   * ran 1,3,5,7,9 instead of 1,2,3,4,5. This is Invariant I0, and it is why
   * mint() and observe() are separate methods below and must NEVER be
   * merged into one "tick-and-merge" routine, no matter how convenient
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
   * go straight through the tree's own O(log N)-ish (O(depth)) lookups.
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
   * `tree.size`/`tree.visibleSize` directly (O(1) — the tree's own
   * augmented subtree counts) rather than traversing `this.nodes`.
   */
  stats(): EngineStats {
    const totalElements = this.tree.size;
    const visibleLength = this.tree.visibleSize;
    return {
      totalElements,
      tombstones: totalElements - visibleLength,
      visibleLength,
    };
  }

  private isOriginPresent(id: Identifier | null): boolean {
    return id === null || this.tree.hasIdentifier(id);
  }

  /**
   * Causal readiness (Engine Spec Definition 4.1). As of the Fugue port,
   * an insert has exactly ONE causal dependency (`parent`), not two —
   * Fugue's own correctness does not require a separately-tracked
   * right-boundary reference at all (see `fugueTree.ts`'s own header
   * comment for why this simplification is sound, not merely convenient).
   */
  private ready(op: Operation): boolean {
    if (op.kind === "insert") {
      return this.isOriginPresent(op.parent);
    }
    return this.tree.hasIdentifier(op.target);
  }

  private applyInsert(op: InsertOperation): void {
    this.tree.attach(op.id, op.value, op.bind, op.parent, op.side);
  }

  /**
   * Causally-latest deletedBy rule (Engine Spec §4.5 line 3): concurrent
   * deletes of the same node all tombstone it, but attribution — needed
   * for undo's resurrection question, §9.3 — goes to whichever delete is
   * causally latest under the identifier total order, never to whichever
   * delete simply arrived last.
   */
  private applyDelete(op: DeleteOperation): void {
    const node = this.tree.nodeByIdentifier(op.target);
    if (node === undefined) {
      throw new Error(`applyDelete(): target ${serializeId(op.target)} is not present`);
    }
    const newDeletedBy =
      node.deletedBy === null || compareIds(op.id, node.deletedBy) > 0 ? op.id : node.deletedBy;
    this.tree.setDeleted(op.target, true, newDeletedBy);
  }

  /**
   * Structural inverse of applyDelete, using the same causally-latest
   * comparison. Full resurrection semantics (interaction with redo
   * history) are Phase 36 (Engine Spec §9.3) — this is deliberately the
   * minimal shape that makes the operation type usable end to end.
   */
  private applyUndelete(op: UndeleteOperation): void {
    const node = this.tree.nodeByIdentifier(op.target);
    if (node === undefined) {
      throw new Error(`applyUndelete(): target ${serializeId(op.target)} is not present`);
    }
    if (node.deletedBy === null || compareIds(op.id, node.deletedBy) > 0) {
      // GC hygiene (Phase 21): the node is no longer deleted, so whatever delete-context was
      // recorded for its (now-superseded) deletedBy no longer describes anything collectible —
      // drop it rather than let it linger forever across delete/undelete churn.
      if (node.deletedBy !== null) {
        this.deleteContext.delete(serializeId(node.deletedBy));
      }
      this.tree.setDeleted(op.target, false, null);
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
   * Explicitly records GC delete-context (Phase 21) for a delete operation whose seq is
   * assigned LAZILY, after this engine already accepted (or buffered) it via `applyRemote`
   * with NO context (Phase 25's DUR-06 fix, writePath.ts: seq is not known until a message's
   * ops are actually finalized, which may happen strictly later than the `applyRemote` call
   * that determined readiness — including, for a delete that was buffered at that time, an
   * arbitrary later point when some OTHER message's own processing happens to resolve it as a
   * side effect via `drain()`). Idempotent (overwrites any existing entry for this id); safe to
   * call regardless of whether the delete has been applied yet. `applyRemote`'s own inline
   * `context` parameter is unaffected and still used by callers that DO know seq up front (e.g.
   * `DocumentCoordinator.warmStart`, replaying an already-persisted log with known seqs).
   */
  setDeleteContext(deleteOpId: Identifier, context: { readonly seq: bigint; readonly atMs: number }): void {
    this.deleteContext.set(serializeId(deleteOpId), context);
  }

  /**
   * Whether `id` currently resolves to a live node in this structure (Phase 24, Engine Spec
   * §7.6). Used only for DIAGNOSTIC purposes by the server's offline-window sweep
   * (packages/server/src/offlineWindowScheduler.ts) — WHICH origin a stuck operation is
   * missing, for logging.
   */
  hasIdentifier(id: Identifier): boolean {
    return this.tree.hasIdentifier(id);
  }

  /**
   * Whether an OPERATION with this id has already been applied to this engine — the SAME
   * check `applyRemote`'s own idempotence guard and `drain()`'s duplicate-discard already use
   * internally (Engine Spec §6.3), exposed publicly (Phase 25, DUR-05 fix). Unlike
   * `hasIdentifier` (tree/node presence — meaningless for a delete/undelete operation's own
   * id, which never becomes a node), this works uniformly for every operation kind, and is
   * TRUE the instant an operation is structurally integrated — independent of whether it has
   * been durably committed anywhere yet. This is exactly the distinction
   * `handshake.ts`'s `buildAlreadyHaveMessage` needs: a client's own operation that is already
   * LIVE here (already broadcast to peers) will always eventually be durably committed
   * regardless of what that client does next, so re-sending/re-minting it on a reconnect that
   * merely raced ahead of its own not-yet-resolved commit would create a genuine duplicate.
   */
  hasApplied(id: Identifier): boolean {
    return this.applied.has(serializeId(id));
  }

  /**
   * Explicitly removes a still-buffered operation from `pending` (Engine Spec §7.6 Rule 7.2).
   * Matches by the OPERATION's own id (never the origin/target it references) — the same
   * identity discipline `applyRemote()`'s idempotence check and `drain()`'s duplicate-discard
   * already use (Engine Spec §4.5, §6.3).
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
   * Phase 25 (Option 2 / R0012's own scoped mitigation, Engine Spec §7.6 Rule 7.2) — attempts to
   * revert a LOCALLY-INTEGRATED insert this client applied synchronously at mint time (Phase
   * 3/10's own real-time-feel design), after the server has explicitly rejected it
   * (`OFFLINE_WINDOW_EXCEEDED`) — see `tests/regression/R0012` for the full scenario this exists
   * to mitigate (a live client's ordinary keystroke anchoring to a node the server has since
   * garbage-collected). Delegates directly to {@link FugueTree.tryRemoveLeaf}: succeeds (returns
   * `true`) ONLY in the "clean" case, where nothing else currently anchors to this node; returns
   * `false` in the "cascading" case (something — typically the SAME user's own very next
   * keystroke — already chains onto it) WITHOUT attempting any partial or unsafe removal, since
   * that would dangle the other node's own `parent` reference (Engine Spec I4/I5). The caller
   * (`SyncClient`) is responsible for falling back to its own existing preserve-only behavior
   * when this returns `false` — this method never does anything destructive on failure.
   *
   * Deliberately does NOT remove `id` from `this.applied` — this exact stamp must never be
   * treated as "ready to be reapplied" again regardless of outcome (this project's design never
   * resends a rejected operation under its own original identity).
   */
  tryRevertLocalInsert(id: Identifier): boolean {
    return this.tree.tryRemoveLeaf(id) !== undefined;
  }

  /**
   * Mints and applies a local insert, returning the operation to broadcast
   * (API Spec §1.4). `parent`/`side` are decided here via
   * {@link FugueTree.decidePlacement} — Fugue's own `createBetween` rule,
   * computed ONCE from the CURRENT tree state at the visible position
   * immediately before the insertion point, and carried on the wire
   * (never re-derived by a receiver — see `operation.ts`'s own doc
   * comment on why that would be unsound).
   */
  localInsert(
    visibleIndex: number,
    value: number,
    bind: boolean = isClusterContinuing(value),
  ): InsertOperation {
    const { parent, side } = this.tree.decidePlacement(visibleIndex);
    const op: InsertOperation = {
      kind: "insert",
      id: this.mint(),
      value,
      parent,
      side,
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
   * Re-querying the SAME `visibleIndex` against the live, mutating tree on
   * every iteration is equivalent to indexing a static snapshot at
   * `visibleIndex, visibleIndex+1, ..., visibleIndex+count-1`: each
   * successful delete removes exactly one unit from vis(S) AT
   * `visibleIndex` itself, so whatever now occupies that same visible
   * position is exactly what would have been next in the original
   * snapshot.
   */
  localDelete(visibleIndex: number, count: number): readonly DeleteOperation[] {
    const ops: DeleteOperation[] = [];
    for (let k = 0; k < count; k++) {
      const target = this.tree.nodeAtVisible(visibleIndex);
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
   *   3. not the `parent` of any node that ISN'T (transitively) also being collected — Fugue's
   *      own analogue of the retired "not the originLeft/originRight of any node" condition;
   *      Fugue has only ONE causal-reference field per node (`parent`), so this fixpoint is
   *      simpler than the retired flat-array design's own (which had to check both
   *      originLeft AND originRight per node) — a live node may still anchor to a dead one via
   *      `parent`, so this is a fixpoint sweep, not a per-node test (Definition 7.4's own
   *      framing);
   *   4. deleted longer ago than the undo horizon — `options.nowMs - <delete's arrival time>
   *      >= options.maxAgeMs`, OR the deleting replica has minted `options.maxOpsPerReplica`
   *      or more further operations since (Rule 7.3's `min(5 minutes, 200 operations)`).
   *
   * A node with NO recorded delete-context (its Delete was applied via a plain `applyRemote`
   * call with no `context`) can never satisfy condition 2 and is therefore never collectible.
   *
   * Removal itself (steps 7-8) is ONE-AT-A-TIME via {@link FugueTree.remove}, not a
   * contiguous-range splice (the retired flat-array design's own optimization, which doesn't
   * apply to a tree — there is no single "structural position range" a set of tree nodes
   * necessarily occupies). `FugueTree.remove()` throws if a node still has children, so this
   * loop repeatedly removes whichever currently-childless members of `collectible` remain,
   * fixpoint-style, until the whole batch is gone — safe by construction, since the
   * "anchored" exclusion above already guarantees no node OUTSIDE `collectible` is a child of
   * anything IN it; the only remaining question is REMOVAL ORDER among collectible nodes
   * themselves, which this loop resolves by always taking leaves first.
   */
  collect(frontier: bigint, options: CollectOptions): CollectResult {
    const allNodes = this.nodes; // O(N) materialize, in structural order

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

    // Steps 2-6 (COLLECT lines 2-6): fixpoint anchor exclusion — Fugue's own single-`parent`
    // analogue of the retired dual-origin fixpoint. See this method's own doc comment above
    // and CollectOptions.budgetMs's doc comment for the wall-clock safety cap this phase (21)
    // found necessary and hand-traced before shipping (a pathological long anchor chain can
    // force one fixpoint pass per cascade step) — kept verbatim in spirit, adapted to `parent`
    // being the sole reference field now.
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
          continue; // n itself is (still) being collected — its OWN parent reference doesn't protect anything
        }
        if (node.parent !== null) {
          anchored.add(serializeId(node.parent));
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
          incomplete = changed;
          break;
        }
      }
    }
    // *** CORRECTNESS, NOT JUST PERFORMANCE — an incomplete sweep collects NOTHING ***
    // See the retired flat-array design's own extensive comment (CLAUDE.md's Phase 21 entry)
    // for the full reasoning — unchanged here: a node still sitting in `collectible` when the
    // loop is cut short is NOT a safe conservative under-approximation.
    if (incomplete) {
      return { collectedCount: 0, incomplete: true };
    }
    if (collectible.size === 0) {
      return { collectedCount: 0, incomplete: false };
    }

    // Steps 7-8 (COLLECT lines 7-8): physical removal, one node at a time, leaves first (see
    // this method's own doc comment above for why this is safe and sufficient).
    let remaining = new Set(collectible);
    let removedThisPass = true;
    while (remaining.size > 0 && removedThisPass) {
      removedThisPass = false;
      for (const key of [...remaining]) {
        const node = this.tree.nodeByIdentifier(parseKey(key));
        if (node === undefined) {
          remaining.delete(key);
          continue;
        }
        const hasNonRemovedChild = allNodes.some(
          (n) => n.parent !== null && serializeId(n.parent) === key && remaining.has(serializeId(n.id)),
        );
        if (hasNonRemovedChild) continue;
        const removedNode = this.tree.remove(node.id);
        if (removedNode?.deletedBy !== null && removedNode?.deletedBy !== undefined) {
          this.deleteContext.delete(serializeId(removedNode.deletedBy)); // GC hygiene, same as applyUndelete
        }
        remaining.delete(key);
        removedThisPass = true;
      }
    }

    return { collectedCount: collectible.size, incomplete: false };
  }
}

function parseKey(key: string): Identifier {
  const [c, r] = key.split(":").map(Number);
  return { c: c!, r: r! };
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
   * supplied together to have any effect; omitting either means NO cap.
   */
  readonly budgetMs?: number;
  /** Supplies the current time in epoch milliseconds when invoked — typically a thin wrapper around the platform's own wall clock, defined and kept OUTSIDE this package (e.g. gcScheduler.ts). */
  readonly clock?: () => number;
}

/** {@link Engine.collect}'s result. */
export interface CollectResult {
  /**
   * True iff the fixpoint sweep was cut short by `options.budgetMs` before naturally
   * converging. When `true`, `collectedCount` is ALWAYS `0`.
   */
  readonly incomplete: boolean;
  /** How many nodes were physically removed from S this call — 0 is normal (nothing due yet), and ALWAYS 0 when `incomplete` is true. */
  readonly collectedCount: number;
}
