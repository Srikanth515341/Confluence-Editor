import { Engine, compareIds, serializeId } from "@collab-editor/engine";
import type { Node, Operation } from "@collab-editor/engine";

/**
 * Shared helpers for the five property-based tests (Test Plan §2.5,
 * PROP-1…5), kept out of any individual test file because PROP-1/3/4/5 all
 * need some form of "generate a stream of local operations" or "check a
 * causal-readiness-respecting order," and duplicating that per file would
 * risk each property silently testing a slightly different notion of
 * causality than the others.
 */

const LOWERCASE_A = 0x61;

/** Deterministic PRNG (mulberry32) — mirrors testkit/src/fuzz/prng.ts's technique so a failing case is reproducible from its seed alone. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a sequence of local operations against a fresh single-replica
 * `Engine`, returning the emitted operations in generation order. Because
 * every operation in the stream is generated against ITS OWN replica's
 * prior local state, this is a genuinely causally-chained history (later
 * inserts anchor on earlier ones; deletes target earlier inserts) — never
 * a synthetic operation list built by hand.
 */
export function generateOpStream(
  rand: () => number,
  replicaId: number,
  opCount: number,
): Operation[] {
  const source = new Engine(replicaId);
  const ops: Operation[] = [];
  for (let i = 0; i < opCount; i++) {
    const len = source.text().length;
    if (len === 0 || rand() < 0.7) {
      const idx = len === 0 ? 0 : Math.floor(rand() * (len + 1));
      const value = LOWERCASE_A + Math.floor(rand() * 26);
      ops.push(source.localInsert(idx, value));
    } else {
      const idx = Math.floor(rand() * len);
      ops.push(...source.localDelete(idx, 1));
    }
  }
  return ops;
}

/** Engine Spec Definition 4.1's readiness test, reimplemented independently of engine.ts's own `ready()` (never imported) so this module cannot silently share a bug with the code it is checking. */
function isReady(op: Operation, appliedIds: ReadonlySet<string>): boolean {
  if (op.kind === "insert") {
    // Fugue port (2026-09-05): a single `parent` reference replaces the retired
    // originLeft/originRight pair — see operation.ts's own doc comment.
    return op.parent === null || appliedIds.has(serializeId(op.parent));
  }
  return appliedIds.has(serializeId(op.target));
}

/**
 * Produces one random topological ("causality-respecting") ordering of
 * `ops`: at every step, picks uniformly at random among the operations
 * whose dependencies are already satisfied. Two calls with different
 * `rand` streams over the SAME `ops` set are, whenever the dependency
 * graph has any real concurrency in it, genuinely different valid
 * linearizations — which is exactly what PROP-3/PROP-4 need.
 */
export function randomLinearization(ops: readonly Operation[], rand: () => number): Operation[] {
  const remaining = ops.slice();
  const appliedIds = new Set<string>();
  const result: Operation[] = [];
  while (remaining.length > 0) {
    const readyIndices: number[] = [];
    for (let i = 0; i < remaining.length; i++) {
      if (isReady(remaining[i] as Operation, appliedIds)) {
        readyIndices.push(i);
      }
    }
    const pickAt = readyIndices[Math.floor(rand() * readyIndices.length)] as number;
    const [op] = remaining.splice(pickAt, 1);
    const chosen = op as Operation;
    result.push(chosen);
    appliedIds.add(serializeId(chosen.id));
  }
  return result;
}

/** Applies every operation in `ops`, in order, to a fresh engine via applyRemote — a valid linearization never needs buffering, but applyRemote's own drain still runs harmlessly if one somehow did. */
export function buildEngine(replicaId: number, ops: readonly Operation[]): Engine {
  const engine = new Engine(replicaId);
  for (const op of ops) {
    engine.applyRemote(op);
  }
  return engine;
}

/**
 * PROP-4's subsequence check: every node in `partialVisible` must appear,
 * by IDENTITY (not by coincidentally-equal character value), inside
 * `fullNodes` at strictly increasing positions. `fullNodes` deliberately
 * includes tombstones (pass a full engine's `.nodes`, not `.visible()`) —
 * a node the partial replica still sees as visible may already be deleted
 * in the fully-informed replica, and that must not look like a broken
 * subsequence, only like a not-yet-learned deletion.
 */
export function isOrderPreservingSubsequence(
  partialVisible: readonly Node[],
  fullNodes: readonly Node[],
): boolean {
  let cursor = 0;
  for (const p of partialVisible) {
    while (cursor < fullNodes.length && compareIds((fullNodes[cursor] as Node).id, p.id) !== 0) {
      cursor++;
    }
    if (cursor >= fullNodes.length) {
      return false;
    }
    cursor++;
  }
  return true;
}

/** The four operation-type pairings PROP-1's generator must cover (Test Plan §2.5). */
export type PairingType = "insIns" | "insDel" | "delIns" | "delDel";

function applyTypedOp(
  engine: Engine,
  kind: "ins" | "del",
  pos: number,
  value: number,
  baseLen: number,
): Operation {
  if (kind === "ins") {
    const idx = baseLen === 0 ? 0 : Math.abs(pos) % (baseLen + 1);
    return engine.localInsert(idx, value);
  }
  // Callers only ever request "del" when baseLen >= 1 — see each test's arbitrary (minLength: 1).
  const idx = Math.abs(pos) % baseLen;
  return engine.localDelete(idx, 1)[0] as Operation;
}

export interface ConcurrentPair {
  readonly baseOps: readonly Operation[];
  readonly opA: Operation;
  readonly opB: Operation;
}

/**
 * Builds one concurrent pair (opA, opB): both generated from replicas that
 * started at the SAME base document and never saw each other's operation —
 * true concurrency, not "op B built on top of op A." `sameOrigin` biases
 * an "insIns" pairing toward both replicas inserting at the identical
 * visible position (Test Plan §2.5's "ins/ins biased toward identical
 * origins" — this is exactly the case Case A's tie-break exists for).
 * `preSkewA`/`preSkewB`, if given, advance each replica's clock (Engine
 * Spec §3.2 observe()) before it generates its own operation — PROP-5's
 * clock-skew-invariance hook.
 */
export function generateConcurrentPair(
  base: string,
  pairing: PairingType,
  posA: number,
  posB: number,
  valueA: number,
  valueB: number,
  sameOrigin: boolean,
  preSkewA?: number,
  preSkewB?: number,
): ConcurrentPair {
  const baseOps: Operation[] = [];
  const seed = new Engine(1);
  for (const ch of base) {
    baseOps.push(seed.localInsert(seed.text().length, ch.codePointAt(0) as number));
  }

  const replicaA = new Engine(2);
  const replicaB = new Engine(3);
  for (const op of baseOps) {
    replicaA.applyRemote(op);
    replicaB.applyRemote(op);
  }
  if (preSkewA !== undefined) {
    replicaA.observe(preSkewA);
  }
  if (preSkewB !== undefined) {
    replicaB.observe(preSkewB);
  }

  const kindA: "ins" | "del" = pairing === "delIns" || pairing === "delDel" ? "del" : "ins";
  const kindB: "ins" | "del" = pairing === "insDel" || pairing === "delDel" ? "del" : "ins";
  const effectivePosB = pairing === "insIns" && sameOrigin ? posA : posB;

  const opA = applyTypedOp(replicaA, kindA, posA, valueA, base.length);
  const opB = applyTypedOp(replicaB, kindB, effectivePosB, valueB, base.length);

  return { baseOps, opA, opB };
}

export interface MergeOutcome {
  readonly textForward: string;
  readonly textReverse: string;
  readonly structureLengthForward: number;
  readonly structureLengthReverse: number;
}

/** Applies {opA, opB} in both orders, from the same base, to two fresh engines — PROP-1/PROP-5's core check. */
export function mergeBothOrders(pair: ConcurrentPair): MergeOutcome {
  const forward = new Engine(10);
  const reverse = new Engine(11);
  for (const op of pair.baseOps) {
    forward.applyRemote(op);
    reverse.applyRemote(op);
  }
  forward.applyRemote(pair.opA);
  forward.applyRemote(pair.opB);
  reverse.applyRemote(pair.opB);
  reverse.applyRemote(pair.opA);

  return {
    textForward: forward.text(),
    textReverse: reverse.text(),
    structureLengthForward: forward.stats().totalElements,
    structureLengthReverse: reverse.stats().totalElements,
  };
}

export interface FullNodeDescriptor {
  readonly id: string;
  readonly deleted: boolean;
}

/** PROP-2's full-state descriptor: every node's id and deleted flag, sorted by id so two structurally-identical engines compare equal regardless of internal array order. */
export function fullStateDescriptor(engine: Engine): readonly FullNodeDescriptor[] {
  return engine.nodes
    .map((n) => ({ id: serializeId(n.id), deleted: n.deleted }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
