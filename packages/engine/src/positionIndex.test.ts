import { describe, expect, it } from "vitest";
import type { Node } from "./node.js";
import { PositionIndex } from "./positionIndex.js";

// The 10,000-seed reference cross-check (Test Plan §2.6 I6) lives in its own file/vitest config —
// positionIndex.crosscheck.test.ts, run via `pnpm test:index` — since it runs ~50s and doesn't
// belong in the fast default `pnpm test` loop (the same split this project already applies to
// convergence/properties/mutation). This file stays fast, direct, hand-constructed unit tests.

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

describe("PositionIndex — direct contract tests (Engine Spec §8.5)", () => {
  it("indexOf / nodeAt agree for a freshly built sequence", () => {
    const idx = new PositionIndex();
    const nodes = [makeNode(), makeNode(), makeNode(), makeNode()];
    nodes.forEach((n, i) => idx.insertAt(i, n));

    expect(idx.size).toBe(4);
    nodes.forEach((n, i) => {
      expect(idx.indexOf(n)).toBe(i);
      expect(idx.nodeAt(i)).toBe(n);
    });
    expect(idx.nodeAt(4)).toBeUndefined();
  });

  it("insertAt in the middle shifts every later node's position", () => {
    const idx = new PositionIndex();
    const a = makeNode();
    const b = makeNode();
    idx.insertAt(0, a);
    idx.insertAt(1, b);
    const middle = makeNode();
    idx.insertAt(1, middle);

    expect(idx.toArray()).toEqual([a, middle, b]);
    expect(idx.indexOf(a)).toBe(0);
    expect(idx.indexOf(middle)).toBe(1);
    expect(idx.indexOf(b)).toBe(2);
  });

  it("nodeAtVisible / visibleIndexOf skip tombstoned nodes", () => {
    const idx = new PositionIndex();
    const a = makeNode();
    const b = makeNode();
    const c = makeNode();
    idx.insertAt(0, a);
    idx.insertAt(1, b);
    idx.insertAt(2, c);

    idx.setDeleted(b, true);

    expect(idx.visibleSize).toBe(2);
    expect(idx.nodeAtVisible(0)).toBe(a);
    expect(idx.nodeAtVisible(1)).toBe(c);
    expect(idx.nodeAtVisible(2)).toBeUndefined();

    expect(idx.visibleIndexOf(a)).toBe(0);
    // b is tombstoned: "the visible position it would occupy" convention — 1 visible node (a)
    // precedes it, matching how a linear `vis.indexOf`-style count-before would read too.
    expect(idx.visibleIndexOf(b)).toBe(1);
    expect(idx.visibleIndexOf(c)).toBe(1);

    idx.setDeleted(b, false);
    expect(idx.visibleSize).toBe(3);
    expect(idx.nodeAtVisible(1)).toBe(b);
  });

  it("setDeleted is idempotent and toggles both directions", () => {
    const idx = new PositionIndex();
    const a = makeNode();
    idx.insertAt(0, a);
    idx.setDeleted(a, true);
    idx.setDeleted(a, true); // re-applying the same state is a harmless no-op
    expect(idx.visibleSize).toBe(0);
    idx.setDeleted(a, false);
    expect(idx.visibleSize).toBe(1);
  });

  it("splice removes a range and returns exactly the removed nodes, in order", () => {
    const idx = new PositionIndex();
    const nodes = [makeNode(), makeNode(), makeNode(), makeNode(), makeNode()];
    nodes.forEach((n, i) => idx.insertAt(i, n));

    const removed = idx.splice(1, 2);
    expect(removed).toEqual([nodes[1], nodes[2]]);
    expect(idx.toArray()).toEqual([nodes[0], nodes[3], nodes[4]]);
    expect(idx.size).toBe(3);

    const fresh = makeNode();
    idx.splice(1, 0, fresh);
    expect(idx.toArray()).toEqual([nodes[0], fresh, nodes[3], nodes[4]]);
  });

  it("property 6: toArray()'s order is stable across queries and matches insertion-order position semantics regardless of tree shape", () => {
    const idx = new PositionIndex();
    // Insert in a pattern (always at the front) deliberately chosen to stress the treap's
    // balancing — a naive unbalanced BST inserted this way degenerates into a linear chain;
    // a treap's shape is independent of insertion pattern (see positionIndex.ts's own header).
    const nodes: Node[] = [];
    for (let i = 0; i < 200; i++) {
      const n = makeNode();
      idx.insertAt(0, n);
      nodes.unshift(n);
    }
    expect(idx.toArray()).toEqual(nodes);
  });

  it("throws when a query is issued against a node never inserted (or already removed)", () => {
    const idx = new PositionIndex();
    const a = makeNode();
    const stray = makeNode();
    idx.insertAt(0, a);
    expect(() => idx.indexOf(stray)).toThrow();
    idx.splice(0, 1);
    expect(() => idx.indexOf(a)).toThrow();
  });
});
