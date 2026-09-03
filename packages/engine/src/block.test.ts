import { describe, expect, it } from "vitest";
import type { Node } from "./node.js";
import {
  canFollowInBlock,
  canMergeBlocks,
  decodeBlock,
  mergeBlocks,
  singleNodeBlock,
  splitBlockAt,
  type Block,
} from "./block.js";

/** A run of `count` sequentially-typed nodes by replica `r`, chained per Definition 7.5 — the shape splitBlockAt is meant to operate on. */
function typedRun(r: number, count: number, startCounter = 1): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push({
      id: { c: startCounter + i, r },
      value: 97 + (i % 26),
      originLeft: i === 0 ? null : { c: startCounter + i - 1, r },
      originRight: null,
      bind: false,
      deleted: false,
      deletedBy: null,
    });
  }
  return nodes;
}

function blockFromRun(nodes: readonly Node[]): Block {
  let block = singleNodeBlock(nodes[0]!);
  for (let i = 1; i < nodes.length; i++) {
    const next = singleNodeBlock(nodes[i]!);
    expect(canMergeBlocks(block, next)).toBe(true);
    block = mergeBlocks(block, next);
  }
  return block;
}

describe("block.ts — Definition 7.5/7.6/Theorem 7.1", () => {
  it("decodeBlock reproduces the original node sequence exactly (id/value/originLeft/deleted/deletedBy/bind)", () => {
    const run = typedRun(1, 10);
    const block = blockFromRun(run);
    const decoded = decodeBlock(block);
    expect(decoded.map((n) => n.id)).toEqual(run.map((n) => n.id));
    expect(decoded.map((n) => n.value)).toEqual(run.map((n) => n.value));
    expect(decoded.map((n) => n.originLeft)).toEqual(run.map((n) => n.originLeft));
    expect(decoded.every((n) => !n.deleted)).toBe(true);
    expect(decoded.every((n) => n.deletedBy === null)).toBe(true);
  });

  it("Theorem 7.1: splitting a block at EVERY interior offset preserves the node sequence exactly", () => {
    const run = typedRun(1, 20);
    const original = blockFromRun(run);
    const originalDecoded = decodeBlock(original);

    for (let j = 1; j < run.length; j++) {
      const [left, right] = splitBlockAt(original, j);
      const decoded = [...decodeBlock(left), ...decodeBlock(right)];

      // EVERY field is exactly preserved, originRight included — see block.ts's own header for
      // why originRight is deliberately PRESERVED through a split rather than reassigned to a
      // "points at my new structural neighbor" value (a literal reading of Definition 7.6 that
      // was tried and found to deadlock snapshot replay).
      expect(decoded).toEqual(originalDecoded);

      expect(left.originRight).toEqual(original.originRight);
      expect(right.originRight).toEqual(original.originRight);
      expect(left.originLeft).toEqual(original.originLeft);
      expect(right.originLeft).toEqual({ c: run[j - 1]!.id.c, r: 1 });

      // Splitting never changes deletion/binding status (condition 4 preserved by construction).
      expect(left.deleted).toBe(original.deleted);
      expect(right.deleted).toBe(original.deleted);
      expect(left.deletedBy).toEqual(original.deletedBy);
      expect(right.deletedBy).toEqual(original.deletedBy);
      expect(left.bind).toBe(original.bind);
      expect(right.bind).toBe(original.bind);

      // The two split pieces are themselves re-mergeable back into the original.
      expect(canMergeBlocks(left, right)).toBe(true);
      const remerged = mergeBlocks(left, right);
      expect(decodeBlock(remerged)).toEqual(originalDecoded);
    }
  });

  it("splitBlockAt rejects a non-interior offset (0, length, or beyond)", () => {
    const block = blockFromRun(typedRun(1, 5));
    expect(() => splitBlockAt(block, 0)).toThrow();
    expect(() => splitBlockAt(block, 5)).toThrow();
    expect(() => splitBlockAt(block, 6)).toThrow();
    expect(() => splitBlockAt(block, -1)).toThrow();
  });

  it("canMergeBlocks / canFollowInBlock agree on which node sequences group into one block (Definition 7.5's four conditions)", () => {
    const run = typedRun(1, 3);
    for (let i = 1; i < run.length; i++) {
      expect(canFollowInBlock(run[i - 1]!, run[i]!)).toBe(true);
    }

    // Different replica — condition 1 fails.
    const wrongReplica: Node = { ...run[1]!, id: { c: run[1]!.id.c, r: 2 } };
    expect(canFollowInBlock(run[0]!, wrongReplica)).toBe(false);

    // Non-consecutive counter — condition 2 fails.
    const skippedCounter: Node = { ...run[1]!, id: { c: run[1]!.id.c + 1, r: 1 } };
    expect(canFollowInBlock(run[0]!, skippedCounter)).toBe(false);

    // Not anchored to predecessor — condition 3 fails.
    const wrongOriginLeft: Node = { ...run[1]!, originLeft: { c: 999, r: 1 } };
    expect(canFollowInBlock(run[0]!, wrongOriginLeft)).toBe(false);

    // Different deleted/bind — condition 4 fails.
    const differentDeleted: Node = { ...run[1]!, deleted: true, deletedBy: { c: 1, r: 9 } };
    expect(canFollowInBlock(run[0]!, differentDeleted)).toBe(false);
    const differentBind: Node = { ...run[1]!, bind: true };
    expect(canFollowInBlock(run[0]!, differentBind)).toBe(false);
  });
});
