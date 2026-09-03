import { describe, expect, it } from "vitest";
import type { Identifier } from "./identifier.js";
import type { Node } from "./node.js";
import { PositionIndex } from "./positionIndex.js";

// ---------------------------------------------------------------------------------------------
// Reference cross-check (Test Plan §2.6, Invariant I6 — Phase 19's own DoD, re-affirmed by
// Phase 20: "runs under 10^4 fuzz seeds with zero disagreements"). A plain flat-array
// linear-scan oracle, driven through an identical random operation sequence per seed as the
// (now block-storage-backed) PositionIndex under test. The reference is DELIBERATELY
// block-unaware — it just tracks a flat Node[] list — because the whole point of block storage
// is that it must be externally invisible: every position/identifier-based query must agree
// with a flat-array oracle REGARDLESS of how many blocks the real index happens to be using
// internally. Every operation's immediate structural consequence (the resulting order) is
// checked after EVERY step; the full positional-query contract is checked exhaustively once
// per seed. `blockCount` is separately, informally sanity-checked (never asserted equal to
// anything the reference computes, since the reference has no notion of blocks) to confirm
// compression is actually happening, not just that correctness holds.
//
// Unlike Phase 19's version, node generation here is BIASED toward genuine Definition 7.5
// chain-continuations (~55% of inserts extend whatever currently sits at the chosen boundary,
// when that's possible) — this is what actually exercises the append/prepend/merge/split code
// paths under fuzz, not just the "always an isolated block" fallback. Positions and deletions
// stay otherwise unconstrained, so Case-A/B/C-shaped interleavings and splits are still
// generated too.
// ---------------------------------------------------------------------------------------------

class LinearReferenceSequence {
  readonly nodes: Node[] = [];

  splice(position: number, deleteCount: number, ...insert: readonly Node[]): Node[] {
    return this.nodes.splice(position, deleteCount, ...insert);
  }

  setDeleted(id: Identifier, deleted: boolean, deletedBy: Identifier | null): void {
    const n = this.nodes.find((x) => x.id.c === id.c && x.id.r === id.r);
    if (!n) {
      throw new Error("LinearReferenceSequence.setDeleted: identifier not present");
    }
    n.deleted = deleted;
    n.deletedBy = deletedBy;
  }

  indexOf(id: Identifier): number | undefined {
    const i = this.nodes.findIndex((x) => x.id.c === id.c && x.id.r === id.r);
    return i === -1 ? undefined : i;
  }

  visibleIndexOf(id: Identifier): number {
    let count = 0;
    for (const n of this.nodes) {
      if (n.id.c === id.c && n.id.r === id.r) {
        return count;
      }
      if (!n.deleted) {
        count += 1;
      }
    }
    throw new Error("LinearReferenceSequence.visibleIndexOf: node not present");
  }

  nodeAt(position: number): Node | undefined {
    return this.nodes[position];
  }

  nodeAtVisible(position: number): Node | undefined {
    let seen = 0;
    for (const n of this.nodes) {
      if (n.deleted) {
        continue;
      }
      if (seen === position) {
        return n;
      }
      seen += 1;
    }
    return undefined;
  }

  toArray(): Node[] {
    return this.nodes.slice();
  }
}

/** mulberry32 — same shape as this project's other seeded PRNGs. Kept local: packages/engine must not depend on packages/testkit. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * id/value/originLeft/deleted/deletedBy/bind are exactly preserved by
 * every block operation (Definition 7.6's own originLeft-chaining
 * guarantee) — compared field-for-field against the flat reference.
 * originRight is DELIBERATELY excluded from that comparison: per
 * Definition 7.5/7.6's own text, a block's stored originRight is
 * reassigned on append/split/merge to reflect the block's CURRENT
 * structural neighbor, not preserved as immutable per-node history the
 * way a flat, block-unaware reference would assume — see block.ts's own
 * header and positionIndex.test.ts's "deleting one interior character"
 * test for the full reasoning.
 */
function expectNodeFieldsMatch(actual: readonly Node[], expected: readonly Node[]): void {
  expect(actual.length).toBe(expected.length);
  expect(actual.map((n) => n.id)).toEqual(expected.map((n) => n.id));
  expect(actual.map((n) => n.value)).toEqual(expected.map((n) => n.value));
  expect(actual.map((n) => n.originLeft)).toEqual(expected.map((n) => n.originLeft));
  expect(actual.map((n) => n.deleted)).toEqual(expected.map((n) => n.deleted));
  expect(actual.map((n) => n.deletedBy)).toEqual(expected.map((n) => n.deletedBy));
  expect(actual.map((n) => n.bind)).toEqual(expected.map((n) => n.bind));
}

// The structural "originRight, if non-null, resolves to a node positioned strictly after this
// one" property (Engine Spec I6) is real and IS checked — but only against REALISTIC,
// engine-produced sequences, where a node's originRight is always derived from
// `nodeAtVisible()` at mint time and therefore always resolves. This file's fuzz generator
// constructs synthetic nodes directly (never through a real `Engine`), including "unrelated"
// nodes whose origins are deliberately arbitrary — so that property doesn't hold here by
// construction and isn't part of what THIS cross-check exists to verify (PositionIndex stores
// and retrieves whatever Node data it's given; it doesn't validate CRDT-level origin integrity,
// that's `integrate()`'s and invariants.ts's I6's job, exercised against real engine output by
// the convergence fuzz suite). See positionIndex.test.ts's own "deleting one interior
// character" test for a direct, realistic check of exactly this property instead.

/** Same field-by-field comparison as {@link expectNodeFieldsMatch}, for a single optional node — used by the per-position `nodeAt`/`nodeAtVisible` checks below. */
function expectNodeMatches(actual: Node | undefined, expected: Node | undefined): void {
  if (expected === undefined) {
    expect(actual).toBeUndefined();
    return;
  }
  expect(actual).toBeDefined();
  expect(actual!.id).toEqual(expected.id);
  expect(actual!.value).toBe(expected.value);
  expect(actual!.originLeft).toEqual(expected.originLeft);
  expect(actual!.deleted).toBe(expected.deleted);
  expect(actual!.deletedBy).toEqual(expected.deletedBy);
  expect(actual!.bind).toBe(expected.bind);
}

function exhaustiveCrossCheck(index: PositionIndex, reference: LinearReferenceSequence): void {
  const total = reference.nodes.length;
  expect(index.size).toBe(total);
  const visibleTotal = reference.nodes.filter((n) => !n.deleted).length;
  expect(index.visibleSize).toBe(visibleTotal);
  expectNodeFieldsMatch(index.toArray(), reference.toArray());

  for (const node of reference.nodes) {
    expect(index.indexOf(node.id)).toBe(reference.indexOf(node.id));
    expect(index.visibleIndexOf(node.id)).toBe(reference.visibleIndexOf(node.id));
  }
  for (let p = 0; p <= total; p++) {
    expectNodeMatches(index.nodeAt(p), reference.nodeAt(p));
  }
  for (let p = 0; p <= visibleTotal; p++) {
    expectNodeMatches(index.nodeAtVisible(p), reference.nodeAtVisible(p));
  }
  // Block compression must never make the index worse than one block per node, and a fully
  // random-attribution structure could legitimately need close to that — this is a sanity
  // bound, not a compression-ratio assertion (that's the dedicated benchmark's job).
  expect(index.blockCount).toBeLessThanOrEqual(Math.max(1, total));
}

function runCrossCheckTrial(seed: number, opsPerTrial: number): void {
  const rng = mulberry32(seed);
  const index = new PositionIndex();
  const reference = new LinearReferenceSequence();
  let idCounter = 0;
  const usedIds = new Set<string>();

  for (let step = 0; step < opsPerTrial; step++) {
    const total = reference.nodes.length;
    const action = rng();

    if (total === 0 || action < 0.55) {
      const position = total === 0 ? 0 : Math.floor(rng() * (total + 1));
      const attemptChain = rng() < 0.55;
      let node: Node;
      const neighborBefore = position > 0 ? reference.nodeAt(position - 1) : undefined;
      const neighborAfter = position < total ? reference.nodeAt(position) : undefined;
      // A candidate chain identifier can collide with an ALREADY-USED (c, r) pair elsewhere in
      // the structure (e.g. two independent chains for the same replica happening to reach the
      // same counter) — real identifiers are guaranteed unique by construction (Invariant I1,
      // each replica's own strictly-increasing mint() counter), which this synthetic generator
      // has no such guarantee for unless it checks explicitly. `usedIds` (below) tracks every
      // identifier ever inserted this trial (including ones later marked deleted, since deleted
      // nodes still occupy their identifier) so a colliding chain candidate can fall back to a
      // fresh, always-unique identifier instead.
      const beforeChainId =
        neighborBefore && !neighborBefore.deleted
          ? { c: neighborBefore.id.c + 1, r: neighborBefore.id.r }
          : undefined;
      const afterChainId =
        neighborAfter && !neighborAfter.deleted
          ? { c: neighborAfter.id.c - 1, r: neighborAfter.id.r }
          : undefined;
      if (attemptChain && beforeChainId && !usedIds.has(`${beforeChainId.c}:${beforeChainId.r}`)) {
        // A genuine Definition 7.5 continuation of whatever's immediately before — this is
        // what `insertAt`'s append fast path (or a later merge) should pick up.
        node = {
          id: beforeChainId,
          value: 97 + (idCounter % 26),
          originLeft: neighborBefore!.id,
          originRight: neighborBefore!.originRight,
          bind: neighborBefore!.bind,
          deleted: neighborBefore!.deleted,
          deletedBy: neighborBefore!.deletedBy,
        };
      } else if (attemptChain && afterChainId && !usedIds.has(`${afterChainId.c}:${afterChainId.r}`)) {
        // A genuine continuation that PRECEDES whatever's immediately after (prepend path).
        node = {
          id: afterChainId,
          value: 97 + (idCounter % 26),
          originLeft: neighborAfter!.originLeft,
          originRight: neighborAfter!.id,
          bind: neighborAfter!.bind,
          deleted: neighborAfter!.deleted,
          deletedBy: neighborAfter!.deletedBy,
        };
      } else {
        // An unrelated, freshly-identified node — never mergeable with anything.
        node = {
          id: { c: 1_000_000 + idCounter, r: 100 + seed },
          value: 97 + (idCounter % 26),
          originLeft: null,
          originRight: null,
          bind: false,
          deleted: false,
          deletedBy: null,
        };
      }
      idCounter += 1;
      usedIds.add(`${node.id.c}:${node.id.r}`);
      index.insertAt(position, node);
      reference.splice(position, 0, node);
    } else if (action < 0.85) {
      const position = Math.floor(rng() * total);
      const node = reference.nodeAt(position);
      if (node) {
        const deleted = rng() < 0.5;
        const deletedBy = deleted ? { c: idCounter++, r: 999 } : null;
        index.setDeleted(node.id, deleted, deletedBy);
        reference.setDeleted(node.id, deleted, deletedBy);
      }
    } else {
      const position = Math.floor(rng() * total);
      const deleteCount = Math.min(total - position, 1 + Math.floor(rng() * 3));
      const removedRef = reference.splice(position, deleteCount);
      const removedIdx = index.splice(position, deleteCount);
      expectNodeFieldsMatch(removedIdx, removedRef);
    }

    // Cheap, every-step check: the resulting order itself always agrees.
    expectNodeFieldsMatch(index.toArray(), reference.toArray());
    expect(index.size).toBe(reference.nodes.length);
  }

  // Expensive, once-per-seed check: every positional query the six-operation contract exposes.
  exhaustiveCrossCheck(index, reference);
}

describe("PositionIndex — reference cross-check under fuzz (Test Plan §2.6 I6)", () => {
  it("agrees with a linear-scan oracle across 10,000 independently seeded random trials", () => {
    const SEEDS = 10_000;
    const OPS_PER_TRIAL = 30;
    for (let seed = 0; seed < SEEDS; seed++) {
      runCrossCheckTrial(seed, OPS_PER_TRIAL);
    }
  });
});
