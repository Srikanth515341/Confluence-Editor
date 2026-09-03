import { describe, expect, it } from "vitest";
import type { Node } from "./node.js";
import { PositionIndex } from "./positionIndex.js";

// The 10,000-seed reference cross-check (Test Plan §2.6 I6) lives in its own file/vitest config —
// positionIndex.crosscheck.test.ts, run via `pnpm test:index` — since it runs long and doesn't
// belong in the fast default `pnpm test` loop (the same split this project already applies to
// convergence/properties/mutation). This file stays fast, direct, hand-constructed unit tests —
// rewritten for Phase 20's block-storage API (identifier-keyed, not Node-object-keyed;
// `setDeleted(id, deleted, deletedBy)`) and extended to cover block formation/splitting
// (Engine Spec §7.5) directly, not just the node-granularity contract Phase 19 established.

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

/** A run of `count` sequentially-typed nodes by replica `r`, chained per Definition 7.5 (each anchored to its predecessor, shared originRight = `tailOriginRight`) — the shape a real typing burst produces, and the shape block formation is meant to compress. */
function typedRun(r: number, count: number, startCounter = 1, tailOriginRight: Node["originLeft"] = null): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push({
      id: { c: startCounter + i, r },
      value: 97 + (i % 26),
      originLeft: i === 0 ? null : { c: startCounter + i - 1, r },
      originRight: tailOriginRight,
      bind: false,
      deleted: false,
      deletedBy: null,
    });
  }
  return nodes;
}

describe("PositionIndex — direct contract tests (Engine Spec §8.5)", () => {
  it("indexOf / nodeAt agree for a freshly built sequence", () => {
    const idx = new PositionIndex();
    const nodes = [makeNode(), makeNode(), makeNode(), makeNode()];
    nodes.forEach((n, i) => idx.insertAt(i, n));

    expect(idx.size).toBe(4);
    nodes.forEach((n, i) => {
      expect(idx.indexOf(n.id)).toBe(i);
      expect(idx.nodeAt(i)).toEqual(n);
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
    expect(idx.indexOf(a.id)).toBe(0);
    expect(idx.indexOf(middle.id)).toBe(1);
    expect(idx.indexOf(b.id)).toBe(2);
  });

  it("nodeAtVisible / visibleIndexOf skip tombstoned nodes", () => {
    const idx = new PositionIndex();
    const a = makeNode();
    const b = makeNode();
    const c = makeNode();
    idx.insertAt(0, a);
    idx.insertAt(1, b);
    idx.insertAt(2, c);

    idx.setDeleted(b.id, true, { c: 999, r: 1 });

    expect(idx.visibleSize).toBe(2);
    expect(idx.nodeAtVisible(0)).toEqual(a);
    expect(idx.nodeAtVisible(1)).toEqual(c);
    expect(idx.nodeAtVisible(2)).toBeUndefined();

    expect(idx.visibleIndexOf(a.id)).toBe(0);
    // b is tombstoned: "the visible position it would occupy" convention — 1 visible node (a)
    // precedes it, matching how a linear `vis.indexOf`-style count-before would read too.
    expect(idx.visibleIndexOf(b.id)).toBe(1);
    expect(idx.visibleIndexOf(c.id)).toBe(1);

    idx.setDeleted(b.id, false, null);
    expect(idx.visibleSize).toBe(3);
    expect(idx.nodeAtVisible(1)).toEqual(b);
  });

  it("setDeleted is idempotent and toggles both directions", () => {
    const idx = new PositionIndex();
    const a = makeNode();
    idx.insertAt(0, a);
    idx.setDeleted(a.id, true, { c: 999, r: 1 });
    idx.setDeleted(a.id, true, { c: 999, r: 1 }); // re-applying the same state is a harmless no-op
    expect(idx.visibleSize).toBe(0);
    idx.setDeleted(a.id, false, null);
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

  it("indexOf/nodeByIdentifier/hasIdentifier return undefined/false for an identifier never inserted (or already removed)", () => {
    const idx = new PositionIndex();
    const a = makeNode();
    const stray = makeNode();
    idx.insertAt(0, a);
    expect(idx.indexOf(stray.id)).toBeUndefined();
    expect(idx.nodeByIdentifier(stray.id)).toBeUndefined();
    expect(idx.hasIdentifier(stray.id)).toBe(false);
    idx.splice(0, 1);
    expect(idx.indexOf(a.id)).toBeUndefined();
  });
});

describe("PositionIndex — block formation and splitting (Engine Spec §7.5)", () => {
  it("a sequential typing burst compresses into exactly one block", () => {
    const idx = new PositionIndex();
    const run = typedRun(1, 500);
    run.forEach((n, i) => idx.insertAt(i, n));

    expect(idx.size).toBe(500);
    expect(idx.blockCount).toBe(1);
    expect(idx.toArray()).toEqual(run);
  });

  it("appending characters one at a time still yields exactly one block, in either scan direction", () => {
    // Appending at the true end (originRight always null) — the actual localInsert() shape.
    const idx = new PositionIndex();
    const run = typedRun(1, 50);
    for (let i = 0; i < run.length; i++) {
      idx.insertAt(i, run[i]!);
    }
    expect(idx.blockCount).toBe(1);
    expect(idx.toArray()).toEqual(run);
  });

  it("deleting one interior character splits the block into (before, deleted, after)", () => {
    const idx = new PositionIndex();
    const run = typedRun(1, 5); // 5-node block
    run.forEach((n, i) => idx.insertAt(i, n));
    expect(idx.blockCount).toBe(1);

    idx.setDeleted(run[2]!.id, true, { c: 999, r: 1 });

    // Splitting is an internal storage detail (never observable via the node-level contract),
    // but IS observable via the diagnostic blockCount: (before) + (deleted middle) + (after).
    expect(idx.blockCount).toBe(3);
    expect(idx.size).toBe(5);
    expect(idx.visibleSize).toBe(4);

    // Every field is EXACTLY preserved by a split, originRight included — see block.ts's own
    // header for why originRight is deliberately PRESERVED (not reassigned, contrary to a
    // literal reading of Definition 7.6's own split text) after that reassignment was found to
    // deadlock snapshot replay.
    const decoded = idx.toArray();
    expect(decoded.map((n) => n.id)).toEqual(run.map((n) => n.id));
    expect(decoded.map((n) => n.value)).toEqual(run.map((n) => n.value));
    expect(decoded.map((n) => n.originLeft)).toEqual(run.map((n) => n.originLeft));
    expect(decoded.map((n) => n.originRight)).toEqual(run.map((n) => n.originRight));
    expect(decoded.map((n) => n.deleted)).toEqual([false, false, true, false, false]);
    expect(decoded[2]!.deletedBy).toEqual({ c: 999, r: 1 });
  });

  it("deleting the first or last character of a block splits into exactly two pieces, not three", () => {
    const idxFirst = new PositionIndex();
    const runFirst = typedRun(1, 5);
    runFirst.forEach((n, i) => idxFirst.insertAt(i, n));
    idxFirst.setDeleted(runFirst[0]!.id, true, { c: 999, r: 1 });
    expect(idxFirst.blockCount).toBe(2);

    const idxLast = new PositionIndex();
    const runLast = typedRun(1, 5);
    runLast.forEach((n, i) => idxLast.insertAt(i, n));
    idxLast.setDeleted(runLast[4]!.id, true, { c: 999, r: 1 });
    expect(idxLast.blockCount).toBe(2);
  });

  it("undeleting a node back to matching the state of its former neighbors re-merges the block", () => {
    const idx = new PositionIndex();
    const run = typedRun(1, 5);
    run.forEach((n, i) => idx.insertAt(i, n));

    idx.setDeleted(run[2]!.id, true, { c: 999, r: 1 });
    expect(idx.blockCount).toBe(3);

    idx.setDeleted(run[2]!.id, false, null);
    // Back to matching its neighbors (deleted:false, deletedBy:null) — re-merges into one block.
    expect(idx.blockCount).toBe(1);
    expect(idx.toArray()).toEqual(run);
  });

  it("two adjacent single-character deletes with the same attribution re-compress into one deleted block", () => {
    const idx = new PositionIndex();
    const run = typedRun(1, 5);
    run.forEach((n, i) => idx.insertAt(i, n));

    idx.setDeleted(run[1]!.id, true, { c: 999, r: 1 });
    idx.setDeleted(run[2]!.id, true, { c: 999, r: 1 });

    // [0] | [1,2 deleted, merged] | [3,4] — 3 blocks, not 4.
    expect(idx.blockCount).toBe(3);
    expect(idx.visibleSize).toBe(3);
  });

  it("a remote block replayed out of local mint order still merges once its predecessor arrives (prepend path)", () => {
    const idx = new PositionIndex();
    const run = typedRun(1, 3, 10); // counters 10, 11, 12
    // Apply the LATER two nodes first (as if they arrived before their own predecessor).
    idx.insertAt(0, run[1]!); // counter 11 — becomes its own single-node block
    idx.insertAt(1, run[2]!); // counter 12 — appends onto 11 (append fast path)
    expect(idx.blockCount).toBe(1);
    // Now the true first node (counter 10) arrives and must PREPEND.
    idx.insertAt(0, run[0]!);
    expect(idx.blockCount).toBe(1);
    expect(idx.toArray()).toEqual(run);
  });

  it("a block with a different bind/deleted/replica never merges with an adjacent one", () => {
    const idx = new PositionIndex();
    const a = makeNode({ id: { c: 1, r: 1 } });
    idx.insertAt(0, a);
    // Different replica, otherwise "consecutive" — must NOT merge.
    const b = makeNode({ id: { c: 2, r: 2 }, originLeft: a.id });
    idx.insertAt(1, b);
    expect(idx.blockCount).toBe(2);
  });
});
