import { describe, expect, it } from "vitest";
import type { Node } from "./node.js";
import { PositionIndex } from "./positionIndex.js";

// ---------------------------------------------------------------------------------------------
// Reference cross-check (Test Plan §2.6, Invariant I6 — Phase 19's own DoD: "runs under 10^4
// fuzz seeds with zero disagreements"). A plain flat-array linear-scan oracle, sharing the SAME
// Node object references as the PositionIndex under test, driven through an identical random
// operation sequence per seed. Every operation's immediate structural consequence (the resulting
// order) is checked after EVERY step; the full positional-query contract (indexOf/visibleIndexOf
// for every node, nodeAt/nodeAtVisible for every position) is checked exhaustively once per seed,
// against that seed's own accumulated (randomly shaped) structure — across 10,000 independently
// seeded trials, this is 10,000 different accumulated structures each fully cross-checked, not
// one structure checked 10,000 times.
//
// Isolated into its own file/vitest config (`pnpm test:index`, packages/engine/
// vitest.crosscheck.config.ts), NOT swept into the default `pnpm test` — the same reasoning as
// this project's convergence/properties/mutation suites (root vitest.config.ts's own `exclude`):
// 10,000 seeds at ~50s is fuzz-suite scale, not inner-loop scale. positionIndex.test.ts (the
// direct, fast contract unit tests) stays in the default run.
// ---------------------------------------------------------------------------------------------

let nextTestId = 0;
function makeNode(overrides: Partial<Node> = {}): Node {
  const id = nextTestId++;
  return {
    id: { c: id, r: 1 },
    value: 97 + (id % 26),
    originLeft: null,
    originRight: null,
    bind: false,
    deleted: false,
    deletedBy: null,
    ...overrides,
  };
}

class LinearReferenceSequence {
  readonly nodes: Node[] = [];

  splice(position: number, deleteCount: number, ...insert: readonly Node[]): Node[] {
    return this.nodes.splice(position, deleteCount, ...insert);
  }

  setDeleted(node: Node, deleted: boolean): void {
    node.deleted = deleted;
  }

  indexOf(node: Node): number {
    return this.nodes.indexOf(node);
  }

  visibleIndexOf(node: Node): number {
    let count = 0;
    for (const n of this.nodes) {
      if (n === node) {
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

/** mulberry32 — same shape as this project's other seeded PRNGs (e.g. testkit's fuzz harness). Kept local: packages/engine must not depend on packages/testkit (the reverse is true throughout this project). */
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

function exhaustiveCrossCheck(index: PositionIndex, reference: LinearReferenceSequence): void {
  const total = reference.nodes.length;
  expect(index.size).toBe(total);
  const visibleTotal = reference.nodes.filter((n) => !n.deleted).length;
  expect(index.visibleSize).toBe(visibleTotal);
  expect(index.toArray()).toEqual(reference.toArray());

  for (const node of reference.nodes) {
    expect(index.indexOf(node)).toBe(reference.indexOf(node));
    expect(index.visibleIndexOf(node)).toBe(reference.visibleIndexOf(node));
  }
  for (let p = 0; p <= total; p++) {
    expect(index.nodeAt(p)).toBe(reference.nodeAt(p));
  }
  for (let p = 0; p <= visibleTotal; p++) {
    expect(index.nodeAtVisible(p)).toBe(reference.nodeAtVisible(p));
  }
}

function runCrossCheckTrial(seed: number, opsPerTrial: number): void {
  const rng = mulberry32(seed);
  const index = new PositionIndex();
  const reference = new LinearReferenceSequence();
  let idCounter = 0;

  for (let step = 0; step < opsPerTrial; step++) {
    const total = reference.nodes.length;
    const action = rng();

    if (total === 0 || action < 0.55) {
      const position = total === 0 ? 0 : Math.floor(rng() * (total + 1));
      const node = makeNode({ id: { c: idCounter, r: seed } });
      idCounter += 1;
      index.insertAt(position, node);
      reference.splice(position, 0, node);
    } else if (action < 0.85) {
      const position = Math.floor(rng() * total);
      const node = reference.nodeAt(position);
      if (node) {
        const deleted = rng() < 0.5;
        index.setDeleted(node, deleted);
        reference.setDeleted(node, deleted);
      }
    } else {
      const position = Math.floor(rng() * total);
      const deleteCount = Math.min(total - position, 1 + Math.floor(rng() * 3));
      const removedRef = reference.splice(position, deleteCount);
      const removedIdx = index.splice(position, deleteCount);
      expect(removedIdx).toEqual(removedRef);
    }

    // Cheap, every-step check: the resulting order itself always agrees.
    expect(index.toArray()).toEqual(reference.toArray());
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
