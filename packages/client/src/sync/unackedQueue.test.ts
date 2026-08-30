import { describe, expect, it } from "vitest";
import type { InsertOperation } from "@collab-editor/engine";
import { UnackedQueue } from "./unackedQueue.js";

function insertOp(c: number, r: number): InsertOperation {
  return {
    kind: "insert",
    id: { c, r },
    value: 0x61,
    originLeft: null,
    originRight: null,
    bind: false,
  };
}

describe("UnackedQueue (API Spec §7.9), keyed by origin stamp", () => {
  it("tracks added operations and reports size", () => {
    const queue = new UnackedQueue();
    queue.add(insertOp(1, 1));
    queue.add(insertOp(2, 1));
    expect(queue.size).toBe(2);
    expect(queue.has({ c: 1, r: 1 })).toBe(true);
  });

  it("ack() removes exactly the matching stamp, leaving others", () => {
    const queue = new UnackedQueue();
    queue.add(insertOp(1, 1));
    queue.add(insertOp(2, 1));
    queue.ack({ c: 1, r: 1 });
    expect(queue.size).toBe(1);
    expect(queue.has({ c: 1, r: 1 })).toBe(false);
    expect(queue.has({ c: 2, r: 1 })).toBe(true);
  });

  it("ack() on an unknown stamp is a harmless no-op", () => {
    const queue = new UnackedQueue();
    queue.add(insertOp(1, 1));
    queue.ack({ c: 99, r: 99 });
    expect(queue.size).toBe(1);
  });

  it("re-adding the same origin stamp overwrites rather than duplicating", () => {
    const queue = new UnackedQueue();
    queue.add(insertOp(1, 1));
    queue.add(insertOp(1, 1));
    expect(queue.size).toBe(1);
  });

  it("clear() empties the queue", () => {
    const queue = new UnackedQueue();
    queue.add(insertOp(1, 1));
    queue.add(insertOp(2, 1));
    queue.clear();
    expect(queue.size).toBe(0);
  });

  it("ids() returns exactly the stamps of everything still unacked", () => {
    const queue = new UnackedQueue();
    queue.add(insertOp(1, 1));
    queue.add(insertOp(2, 2));
    const ids = queue.ids();
    expect(ids).toEqual(
      expect.arrayContaining([
        { c: 1, r: 1 },
        { c: 2, r: 2 },
      ]),
    );
    expect(ids).toHaveLength(2);
  });
});
