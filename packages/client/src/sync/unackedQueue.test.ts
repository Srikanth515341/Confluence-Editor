import { describe, expect, it } from "vitest";
import type { Identifier, InsertOperation, Operation } from "@collab-editor/engine";
import type { DurableQueue, QueueMeta, RejectedRecord } from "./durableQueue.js";
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

/** A trivial in-memory recorder standing in for a real IndexedDB-backed DurableQueue — proves UnackedQueue calls through to its durable backend correctly, without touching real (or fake) IndexedDB at all. See durableQueue.test.ts for the real IndexedDB-backed coverage. */
class RecordingDurableQueue implements DurableQueue {
  readonly writes: Array<{ documentId: string; op: Operation }> = [];
  readonly removals: Array<{ documentId: string; id: Identifier }> = [];
  readonly rejections: RejectedRecord[] = [];
  readonly metaWrites: QueueMeta[] = [];

  async loadUnacked(): Promise<Operation[]> {
    return [];
  }
  async loadRejected(): Promise<RejectedRecord[]> {
    return [];
  }
  async loadMeta(): Promise<QueueMeta | undefined> {
    return undefined;
  }
  scheduleWriteUnacked(op: Operation, documentId: string): void {
    this.writes.push({ documentId, op });
  }
  scheduleRemoveUnacked(id: Identifier, documentId: string): void {
    this.removals.push({ documentId, id });
  }
  scheduleWriteRejected(record: RejectedRecord): void {
    this.rejections.push(record);
  }
  scheduleWriteMeta(meta: QueueMeta): void {
    this.metaWrites.push(meta);
  }
  async flush(): Promise<void> {}
  async clearRejected(): Promise<void> {}
  close(): void {}
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

  it("get() returns the operation for a known stamp, undefined for an unknown one", () => {
    const queue = new UnackedQueue();
    const op = insertOp(1, 1);
    queue.add(op);
    expect(queue.get({ c: 1, r: 1 })).toBe(op);
    expect(queue.get({ c: 99, r: 99 })).toBeUndefined();
  });
});

describe("UnackedQueue — durable backend (Phase 22, API Spec §7.9)", () => {
  it("add() schedules a durable write only AFTER attachDurable() has been called", () => {
    const queue = new UnackedQueue();
    const durable = new RecordingDurableQueue();
    queue.add(insertOp(1, 1)); // before attaching — no durable backend to write to yet
    expect(durable.writes).toHaveLength(0);

    queue.attachDurable(durable, "doc-1");
    queue.add(insertOp(2, 1));
    expect(durable.writes).toEqual([{ documentId: "doc-1", op: insertOp(2, 1) }]);
  });

  it("ack() schedules the durable removal BEFORE deleting in-memory (API Spec §7.9's stated ordering)", () => {
    const queue = new UnackedQueue();
    const durable = new RecordingDurableQueue();
    queue.attachDurable(durable, "doc-1");
    const op = insertOp(1, 1);
    queue.add(op);

    let sizeAtRemovalTime = -1;
    // Observe UnackedQueue's own in-memory state at the moment the durable removal is
    // scheduled — proves the durable call happens while the entry is STILL present in memory,
    // i.e. durable-first, not memory-first.
    const originalRemove = durable.scheduleRemoveUnacked.bind(durable);
    durable.scheduleRemoveUnacked = (id, documentId) => {
      sizeAtRemovalTime = queue.size;
      originalRemove(id, documentId);
    };

    queue.ack(op.id);
    expect(sizeAtRemovalTime).toBe(1); // still present when the durable call fired
    expect(queue.size).toBe(0); // gone immediately after
    expect(durable.removals).toEqual([{ documentId: "doc-1", id: { c: 1, r: 1 } }]);
  });

  it("restoreEntries() populates the in-memory map WITHOUT scheduling redundant durable writes", () => {
    const queue = new UnackedQueue();
    const durable = new RecordingDurableQueue();
    queue.restoreEntries([insertOp(1, 1), insertOp(2, 1)]);
    queue.attachDurable(durable, "doc-1"); // attached AFTER restore, as syncClient.ts actually does it
    expect(queue.size).toBe(2);
    expect(durable.writes).toHaveLength(0); // the restored entries came FROM durable storage already
  });
});
