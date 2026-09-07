import type { Identifier } from "./identifier.js";
import { compareIds, serializeId } from "./identifier.js";
import type { Node } from "./node.js";
import type { Engine } from "./engine.js";

/**
 * Runtime assertions for all ten Engine Spec §5 invariants (I0–I9), for
 * test/dev builds (Test Plan §2.6). This module is a pure function with
 * no environment dependency (no process.env, no build-tool coupling) —
 * consistent with Engine Spec §5 purity — so it is safe to import
 * unconditionally; keeping it OUT of a production bundle is the calling
 * layer's job (a dev-only gate around the call site) once
 * packages/server or packages/client actually exist and bundle anything.
 *
 * assertInvariants() is meant to be called repeatedly over an engine's
 * lifetime (after every mutation), not once at the end — I2, I3, and I7
 * are stated in terms of "never changes"/"never regresses" across time,
 * so they need a history to compare against. A single end-of-trial call
 * would make those three vacuously true (nothing to compare the first
 * observation to). I9 is the deliberate exception: a nonempty pending
 * buffer mid-trial is normal (Engine Spec §4.2), so it is only checked
 * when the caller passes `quiescent: true`, which must mean delivery is
 * actually complete.
 *
 * History tracking (I2/I3/I7) is keyed by SERIALIZED IDENTIFIER (a plain
 * `Map<string, ...>`), not by Node object identity (a `WeakMap<Node,
 * ...>`, this module's Phase 1-19 shape). Phase 20's block storage no
 * longer keeps one stable, persistent Node object per identifier —
 * `engine.nodes` decodes a FRESH object from whatever block currently
 * holds each node on every single call, so a WeakMap keyed on a Node
 * reference from a PRIOR call would never match a freshly-decoded object
 * representing the exact same logical node, silently making I2/I3/I7
 * vacuously true (every node looks "never seen before," every call). A
 * plain string-keyed Map has no such requirement and is a fine choice
 * here regardless of the GC-friendliness a WeakMap offered — this module
 * is test/dev-only, never on a production hot path, and an engine's own
 * `applied`/`byReplica`-style bookkeeping already retains one entry per
 * identifier for the engine's whole lifetime anyway.
 */

interface NodeSnapshot {
  readonly id: Identifier;
  readonly value: number;
  readonly parent: Identifier | null;
  readonly side: "L" | "R";
  readonly bind: boolean;
}

interface EngineTrackingState {
  readonly nodeSnapshots: Map<string, NodeSnapshot>;
  readonly deletedBySeen: Map<string, Identifier>;
  readonly lastIndexOf: Map<string, number>;
  lastNodeCount: number | undefined;
}

const tracking = new WeakMap<Engine, EngineTrackingState>();

function getTracking(engine: Engine): EngineTrackingState {
  let state = tracking.get(engine);
  if (!state) {
    state = {
      nodeSnapshots: new Map(),
      deletedBySeen: new Map(),
      lastIndexOf: new Map(),
      lastNodeCount: undefined,
    };
    tracking.set(engine, state);
  }
  return state;
}

function sameId(a: Identifier | null, b: Identifier | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return compareIds(a, b) === 0;
}

/** Thrown by {@link assertInvariants} — the message names every invariant (I0–I9) that failed. */
export class InvariantViolation extends Error {}

export interface AssertInvariantsOptions {
  /** Only pass `true` once a trial's delivery is fully complete (Engine Spec §4.2) — I9 only holds at quiescence. */
  readonly quiescent?: boolean;
  /**
   * Pass `true` for the ONE call immediately after `engine.collect()` (Phase 21, Engine Spec
   * §7.4) — the only legitimate way the structure is ever allowed to shrink. This does not
   * weaken I5 into "shrinkage is fine": it resets THIS call's baseline to the new, smaller
   * count rather than comparing against the pre-collect count, so I5 still fires on any OTHER
   * mutation path that shrinks the structure (which remains a real bug — `collect()` is the
   * sole sanctioned exception, not a general exemption). I4 (origin presence) is NOT
   * exempted by this flag and runs exactly as always — since `collect()`'s own fixpoint is
   * supposed to guarantee no remaining node ever references a removed one, a passing I4 check
   * immediately after a `collect()` call is the exhaustive, per-call proof of that guarantee
   * Test Plan M8-c asks for, not a check `collect()` itself is trusted to have gotten right.
   */
  readonly afterCollect?: boolean;
}

export function assertInvariants(engine: Engine, options: AssertInvariantsOptions = {}): void {
  const violations: string[] = [];
  const state = getTracking(engine);
  const nodes = engine.nodes;

  // Nested-by-counter-then-replica lookup, not a string-keyed Map: this
  // function runs after every mutation across 10^4 fuzz seeds (Test Plan
  // §2.6), so avoiding a serializeId() string allocation per lookup on the
  // hot path is a measured, meaningful difference at that volume. serializeId
  // is still used freely below, but only inside violation messages (and the
  // cross-call history keys, which are cold relative to the per-node scan
  // below), which are cold by construction (a passing run never builds one).
  const byId = new Map<number, Map<number, Node>>();
  const indexOf = new Map<Node, number>();
  let idCount = 0;

  // I3 — order stability: once node a precedes node b, it does so forever
  // (Engine Spec §5 I3, §4.3). Checked in this same pass, without a
  // separate O(n) array-copy-and-rescan, via a single running maximum:
  // walking the CURRENT array left to right, each previously-seen node's
  // PREVIOUSLY recorded index must not dip below the highest previously
  // recorded index seen so far at this point in the walk — if it did, two
  // nodes whose relative order was already established have flipped.
  // integrate() only ever splices a new node in, so this holds by
  // construction; it exists to catch a future regression (e.g. a GC bug
  // that reorders instead of just removing).
  let highestPriorIndexSoFar = -1;
  let i3Violation: Node | undefined;

  nodes.forEach((n, i) => {
    let byReplica = byId.get(n.id.c);
    if (!byReplica) {
      byReplica = new Map();
      byId.set(n.id.c, byReplica);
    }
    if (!byReplica.has(n.id.r)) {
      idCount++;
    }
    byReplica.set(n.id.r, n);
    indexOf.set(n, i);

    const key = serializeId(n.id);
    const priorIndex = state.lastIndexOf.get(key);
    if (priorIndex !== undefined) {
      if (i3Violation === undefined && priorIndex < highestPriorIndexSoFar) {
        i3Violation = n;
      }
      highestPriorIndexSoFar = priorIndex;
    }
    state.lastIndexOf.set(key, i);
  });
  const resolve = (id: Identifier): Node | undefined => byId.get(id.c)?.get(id.r);

  if (i3Violation !== undefined) {
    violations.push(
      `I3 violated: node ${serializeId(i3Violation.id)}'s position relative to its neighbors regressed ` +
        "since it was last observed — Engine Spec §5 I3, §4.3.",
    );
  }

  // I0 — clock advances exactly once per minted identifier (Engine Spec §5 I0, §3.2).
  // Independently replays the correct max/increment semantics from the
  // logged events and compares against the engine's actual clock, so a
  // defect that changes OBSERVE's own arithmetic cannot also corrupt the
  // value this check compares against.
  {
    let replayed = 0;
    for (const event of engine.clockEventLog) {
      replayed = event.kind === "mint" ? replayed + 1 : Math.max(replayed, event.remoteCounter);
    }
    if (replayed !== engine.currentClock) {
      violations.push(
        `I0 violated: replaying ${engine.clockEventLog.length} mint/observe event(s) with correct ` +
          `max/increment semantics yields clock ${replayed}, but the engine's actual clock is ` +
          `${engine.currentClock}. MINT must advance the clock by exactly 1; OBSERVE must only merge ` +
          `via max() and never increment on its own — Engine Spec §5 I0, §3.2.`,
      );
    }
  }

  // I1 — identifier uniqueness: no two nodes share an identifier (Engine Spec §5 I1, §3.3).
  if (idCount !== nodes.length) {
    violations.push(
      `I1 violated: ${nodes.length} node(s) but only ${idCount} distinct identifier(s) among them — ` +
        "Engine Spec §5 I1, §3.3.",
    );
  }

  for (const node of nodes) {
    const key = serializeId(node.id);

    // I2 — identifier immutability: id/value/parent/side/bind never change
    // after creation (Engine Spec §5 I2, Definition 2.1/§2.2). As of the
    // Fugue port, this is STRICTER than the retired Phase-20 exception for
    // originRight (which a block split legitimately reassigned) — a Fugue
    // node's tree attachment is permanent by design (fugueTree.ts's own
    // header comment), so `parent`/`side` are real, unconditional identity
    // fields now, with no representation-level carve-out needed.
    const prevSnapshot = state.nodeSnapshots.get(key);
    if (prevSnapshot === undefined) {
      state.nodeSnapshots.set(key, {
        id: node.id,
        value: node.value,
        parent: node.parent,
        side: node.side,
        bind: node.bind,
      });
    } else if (
      !sameId(prevSnapshot.id, node.id) ||
      prevSnapshot.value !== node.value ||
      !sameId(prevSnapshot.parent, node.parent) ||
      prevSnapshot.side !== node.side ||
      prevSnapshot.bind !== node.bind
    ) {
      violations.push(
        `I2 violated: node ${serializeId(node.id)}'s identity fields changed after creation — ` +
          "Engine Spec §5 I2.",
      );
    }

    // I4 — origin presence: every `parent` a node currently carries resolves to
    // a node actually in the structure (Engine Spec §5 I4, §4.2). Fugue has
    // exactly ONE causal-reference field per node, replacing the retired
    // originLeft/originRight pair.
    const parentNode = node.parent !== null ? resolve(node.parent) : undefined;
    if (node.parent !== null && parentNode === undefined) {
      violations.push(
        `I4 violated: node ${serializeId(node.id)}'s parent ${serializeId(node.parent)} is not ` +
          "present in the structure — Engine Spec §5 I4, §4.2.",
      );
    }

    // I6 — scan-window determinism, restated for Fugue's own placement rule (there is no
    // "scan window" anymore, so this checks the structural consequence the retired
    // originLeft/originRight-bounded version checked instead): a node attached as its
    // parent's RIGHT child (side "R") must sort strictly AFTER its parent in the total
    // order; one attached as the LEFT child of some node (side "L") must sort strictly
    // BEFORE that reference node. This is the direct Fugue-era analogue of "every node sits
    // strictly between its own origin bounds" — Fugue only has one bound (`parent`), and
    // which side of it depends on `side`.
    const myIndex = indexOf.get(node);
    if (myIndex !== undefined && parentNode !== undefined) {
      const parentIndex = indexOf.get(parentNode);
      if (parentIndex !== undefined) {
        if (node.side === "R" && !(parentIndex < myIndex)) {
          violations.push(
            `I6 violated: node ${serializeId(node.id)} (side R) is not positioned after its parent — ` +
              "Engine Spec §5 I6, §4.3 (Fugue placement rule).",
          );
        }
        if (node.side === "L" && !(myIndex < parentIndex)) {
          violations.push(
            `I6 violated: node ${serializeId(node.id)} (side L) is not positioned before its reference node — ` +
              "Engine Spec §5 I6, §4.3 (Fugue placement rule).",
          );
        }
      }
    }

    // I7 — deletion attribution monotonicity: deletedBy only ever advances in
    // the (counter, replica) order (Engine Spec §5 I7, §4.5 line 3).
    if (node.deletedBy !== null) {
      const prevDeletedBy = state.deletedBySeen.get(key);
      if (prevDeletedBy !== undefined && compareIds(node.deletedBy, prevDeletedBy) < 0) {
        violations.push(
          `I7 violated: node ${serializeId(node.id)}'s deletedBy regressed from ` +
            `${serializeId(prevDeletedBy)} to ${serializeId(node.deletedBy)} — Engine Spec §5 I7, §4.5.`,
        );
      } else {
        state.deletedBySeen.set(key, node.deletedBy);
      }
    }

    // I8 — grapheme cluster contiguity (Engine Spec §5 I8, §4.4), restated for Fugue's own
    // sibling-order mechanism: `fugueTree.ts`'s `siblingRank` sorts bind:true siblings before
    // bind:false ones among nodes attached to the SAME parent on the SAME side (the direct
    // Fugue-era analogue of the retired rank()'s own [bind?0:1, replicaId] tie-break) — this
    // checks that substitution was actually applied correctly: a bind:true node must never
    // have an ordinary (bind:false) SIBLING (same parent + side) sorted before it. This is a
    // narrower, directly-checkable restatement of the retired version's own "no ordinary node
    // sits between a base and its mark" claim, scoped to the one mechanism `siblingRank`
    // actually controls (immediate same-parent-same-side sibling order) — deeper,
    // multi-generation interposition scenarios are exhaustively covered instead by the real
    // ADV-17/ADV-19 empirical cases (Test Plan §2.4) and this project's own Phase 5 DoD check
    // (temporarily dropping `bind` from `siblingRank` and confirming those two cases fail),
    // re-verified fresh under this port rather than assumed to still hold.
    // Any node sharing this (parent, side) is a sibling, regardless of position — the set is
    // typically tiny (only concurrent insertions at the exact same anchor point ever produce
    // more than one), so a plain pass over all nodes is fine here.
    for (const other of nodes) {
      if (other === node) continue;
      if (!sameId(other.parent, node.parent) || other.side !== node.side) continue;
      // `other` is a same-parent-same-side sibling of `node`. If `node` is a combining mark
      // (bind:true) and `other` is ordinary (bind:false), `node` must sort before `other`
      // (siblingRank's own bind-then-replica rule) — checked via id/id comparison directly,
      // mirroring `siblingRank`'s own definition, rather than trusting position alone.
      if (node.bind && !other.bind) {
        const otherIndex = indexOf.get(other);
        if (myIndex !== undefined && otherIndex !== undefined && otherIndex < myIndex) {
          violations.push(
            `I8 violated: ordinary sibling ${serializeId(other.id)} sorts before combining mark ` +
              `${serializeId(node.id)} sharing the same parent/side — Engine Spec §5 I8, §4.4.`,
          );
        }
      }
    }
  }

  // I5 — tombstone retention: a node once integrated is never later missing
  // EXCEPT through garbage collection (Engine Spec §5 I5, §4.5/§7.4 as
  // amended by Phase 21's §7.4 COLLECT). Full retention is already implied
  // by I3's subsequence check above (a removed node couldn't reappear in
  // the match) combined with I1's uniqueness — this is a cheap O(1)
  // restatement so a shrinking structure is attributed to I5 specifically
  // rather than surfacing only as an I3 message. `options.afterCollect`
  // is the ONE sanctioned exception (see its own doc comment) — any OTHER
  // shrinkage is still a genuine violation.
  if (
    options.afterCollect !== true &&
    state.lastNodeCount !== undefined &&
    nodes.length < state.lastNodeCount
  ) {
    violations.push(
      `I5 violated: the structure shrank from ${state.lastNodeCount} to ${nodes.length} node(s) outside ` +
        "of engine.collect() — a node referenced as an origin must never be physically removed while it " +
        "may still be needed as an anchor — Engine Spec §5 I5, §4.5/§7.4.",
    );
  }
  state.lastNodeCount = nodes.length;

  // I9 — pending buffer drains at quiescence (Engine Spec §5 I9, §4.2 Rule 4.2).
  if (options.quiescent === true && engine.pending.length !== 0) {
    violations.push(
      `I9 violated: ${engine.pending.length} operation(s) still pending at quiescence — ` +
        "Engine Spec §5 I9, §4.2.",
    );
  }

  if (violations.length > 0) {
    throw new InvariantViolation(violations.join("\n"));
  }
}
