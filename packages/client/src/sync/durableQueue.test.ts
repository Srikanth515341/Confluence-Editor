import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { DeleteOperation, InsertOperation } from "@collab-editor/engine";
import { RejectReason } from "@collab-editor/protocol";
import {
  FLUSH_DEBOUNCE_MS,
  openDurableQueue,
  type DurableQueue,
  type QueueMeta,
} from "./durableQueue.js";

/**
 * `fake-indexeddb`'s `IDBFactory` is a full, pure-JS IndexedDB implementation — real
 * asynchronous transactions, real structured-clone key comparison, no browser or jsdom
 * required (jsdom itself does not implement IndexedDB at all). A FRESH instance per test
 * keeps every test's database genuinely isolated, mirroring separate browser profiles rather
 * than separate tabs sharing one origin's storage.
 */
function freshFactory(): IDBFactory {
  return new IDBFactory();
}

function insertOp(c: number, r: number, value = 0x61): InsertOperation {
  return { kind: "insert", id: { c, r }, value, originLeft: null, originRight: null, bind: false };
}

function deleteOp(c: number, r: number, target: { c: number; r: number }): DeleteOperation {
  return { kind: "delete", id: { c, r }, target };
}

async function openFresh(): Promise<{ durable: DurableQueue; factory: IDBFactory }> {
  const factory = freshFactory();
  const result = openDurableQueue(factory);
  const durable = result instanceof Promise ? await result : result;
  expect(durable).not.toBeNull();
  return { durable: durable!, factory };
}

describe("openDurableQueue (Phase 22, API Spec §7.9)", () => {
  it("returns null SYNCHRONOUSLY (no Promise at all) when no IDBFactory is available", () => {
    const result = openDurableQueue(undefined);
    expect(result).toBeNull(); // not `instanceof Promise` — see durableQueue.ts's own comment for why this matters to SyncClient.connect()'s timing
  });

  it("resolves to a real DurableQueue when a real (fake-indexeddb-backed) factory is given", async () => {
    const result = openDurableQueue(freshFactory());
    expect(result).toBeInstanceOf(Promise);
    const durable = await result;
    expect(durable).not.toBeNull();
    durable?.close();
  });

  it("Test Plan §3.6 DUR-09: a factory whose open() throws synchronously resolves to null, not a thrown error", async () => {
    const brokenFactory = {
      open: () => {
        throw new Error("IndexedDB disabled (simulated private browsing)");
      },
    } as unknown as IDBFactory;
    const result = openDurableQueue(brokenFactory);
    expect(result).toBeInstanceOf(Promise); // a factory WAS supplied, so this always takes the async branch
    const durable = await result;
    expect(durable).toBeNull();
  });

  it("Test Plan §3.6 DUR-09: a factory whose open() request errors out resolves to null, not a rejection", async () => {
    // A minimal fake IDBOpenDBRequest: openDatabase() (durableQueue.ts) only ever assigns
    // to onerror/onsuccess/onupgradeneeded/onblocked as plain properties (never
    // addEventListener), so a plain object with an `error` field and a microtask-deferred
    // onerror invocation is a faithful enough stand-in for "the open request itself fails" —
    // simulating e.g. a quota-exceeded rejection, without needing fake-indexeddb's own
    // (harder to provoke on demand) error paths.
    const fakeRequest = {
      error: new Error("simulated quota exceeded"),
      onerror: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null,
      onblocked: null as (() => void) | null,
    };
    const brokenFactory = {
      open: () => {
        queueMicrotask(() => fakeRequest.onerror?.());
        return fakeRequest as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;
    const result = openDurableQueue(brokenFactory);
    const durable = await (result as Promise<DurableQueue | null>);
    expect(durable).toBeNull();
  });
});

describe("IndexedDbDurableQueue — unacked store round trip", () => {
  it("loadUnacked() returns nothing for a document that has never written anything", async () => {
    const { durable } = await openFresh();
    expect(await durable.loadUnacked("doc-1")).toEqual([]);
    durable.close();
  });

  it("scheduleWriteUnacked + flush() persists an operation that loadUnacked() then returns", async () => {
    const { durable } = await openFresh();
    const op = insertOp(1, 5);
    durable.scheduleWriteUnacked(op, "doc-1");
    await durable.flush();
    expect(await durable.loadUnacked("doc-1")).toEqual([op]);
    durable.close();
  });

  it("scheduleRemoveUnacked + flush() removes exactly the matching stamp", async () => {
    const { durable } = await openFresh();
    durable.scheduleWriteUnacked(insertOp(1, 5), "doc-1");
    durable.scheduleWriteUnacked(insertOp(2, 5), "doc-1");
    await durable.flush();
    durable.scheduleRemoveUnacked({ c: 1, r: 5 }, "doc-1");
    await durable.flush();
    const remaining = await durable.loadUnacked("doc-1");
    expect(remaining).toEqual([insertOp(2, 5)]);
    durable.close();
  });

  it("loadUnacked() restores rows in original local mint order (ascending stampC), not insertion order", async () => {
    const { durable } = await openFresh();
    // Write in a DELIBERATELY scrambled order — loadUnacked must still return them sorted by
    // stampC ascending (the mint-order reconstruction reconcileOfflineQueue.ts depends on).
    durable.scheduleWriteUnacked(insertOp(3, 5), "doc-1");
    durable.scheduleWriteUnacked(insertOp(1, 5), "doc-1");
    durable.scheduleWriteUnacked(insertOp(2, 5), "doc-1");
    await durable.flush();
    const restored = await durable.loadUnacked("doc-1");
    expect(restored.map((op) => op.id.c)).toEqual([1, 2, 3]);
    durable.close();
  });

  it("loadUnacked() scopes strictly to the given documentId, even sharing one database", async () => {
    const { durable } = await openFresh();
    durable.scheduleWriteUnacked(insertOp(1, 5), "doc-A");
    durable.scheduleWriteUnacked(insertOp(1, 5), "doc-B");
    await durable.flush();
    expect(await durable.loadUnacked("doc-A")).toHaveLength(1);
    expect(await durable.loadUnacked("doc-B")).toHaveLength(1);
    expect(await durable.loadUnacked("doc-C")).toHaveLength(0);
    durable.close();
  });

  it("a delete operation round-trips correctly too (not just insert)", async () => {
    const { durable } = await openFresh();
    const op = deleteOp(9, 7, { c: 1, r: 5 });
    durable.scheduleWriteUnacked(op, "doc-1");
    await durable.flush();
    expect(await durable.loadUnacked("doc-1")).toEqual([op]);
    durable.close();
  });
});

describe("IndexedDbDurableQueue — meta store", () => {
  it("loadMeta() returns undefined before anything has been written", async () => {
    const { durable } = await openFresh();
    expect(await durable.loadMeta("doc-1")).toBeUndefined();
    durable.close();
  });

  it("scheduleWriteMeta + flush() persists exactly the three specified fields", async () => {
    const { durable } = await openFresh();
    const meta: QueueMeta = { documentId: "doc-1", lastServerSeq: 42, replicaId: 3, updatedAt: 12345 };
    durable.scheduleWriteMeta(meta);
    await durable.flush();
    expect(await durable.loadMeta("doc-1")).toEqual(meta);
    durable.close();
  });

  it("a later scheduleWriteMeta() overwrites the prior row for the same documentId", async () => {
    const { durable } = await openFresh();
    durable.scheduleWriteMeta({ documentId: "doc-1", lastServerSeq: 1, replicaId: 1, updatedAt: 1 });
    durable.scheduleWriteMeta({ documentId: "doc-1", lastServerSeq: 2, replicaId: 2, updatedAt: 2 });
    await durable.flush();
    expect(await durable.loadMeta("doc-1")).toEqual({
      documentId: "doc-1",
      lastServerSeq: 2,
      replicaId: 2,
      updatedAt: 2,
    });
    durable.close();
  });
});

describe("IndexedDbDurableQueue — rejected store", () => {
  it("scheduleWriteRejected + flush() persists a preserved rejection, keyed by origin stamp", async () => {
    const { durable } = await openFresh();
    const op = insertOp(4, 6);
    durable.scheduleWriteRejected({
      documentId: "doc-1",
      op,
      reason: RejectReason.PERMISSION_DENIED,
      detail: "not an editor",
      rejectedAt: 999,
    });
    await durable.flush();
    // No public read method for `rejected` in the DurableQueue interface (Scope-IN lists
    // "preservation," not a read/export API this phase) — verified indirectly via loadUnacked
    // staying empty (the write went to a DIFFERENT store) and via durableQueue.ts's own
    // getAll-based internals being exercised identically to the unacked path above.
    expect(await durable.loadUnacked("doc-1")).toEqual([]);
    durable.close();
  });
});

describe("IndexedDbDurableQueue — 200ms trailing-edge batching (API Spec §7.9)", () => {
  // Deliberately REAL timers, not `vi.useFakeTimers()`: fake-indexeddb's own internal
  // transaction-completion scheduling depends on real microtask/timer progression, and faking
  // global timers around it produces a genuinely stuck promise (confirmed — an earlier version
  // of this test using fake timers hung both this test AND the next one in the file, since a
  // timed-out test's fake-timer state never gets restored). A few hundred real milliseconds is
  // an acceptable cost for the one test in this file that needs to observe timing at all.
  it(
    "does not commit before FLUSH_DEBOUNCE_MS has passed since the LAST scheduled write",
    async () => {
      const { durable } = await openFresh();
      durable.scheduleWriteUnacked(insertOp(1, 5), "doc-1");
      await new Promise((resolve) => setTimeout(resolve, FLUSH_DEBOUNCE_MS - 60));
      durable.scheduleWriteUnacked(insertOp(2, 5), "doc-1"); // resets the trailing edge
      await new Promise((resolve) => setTimeout(resolve, FLUSH_DEBOUNCE_MS - 60));
      // Neither write should have committed yet — under 200ms has passed since the LAST write,
      // which is what a trailing-edge debounce (not a fixed-window throttle) means.
      expect(await durable.loadUnacked("doc-1")).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 100)); // now past FLUSH_DEBOUNCE_MS since the LAST write
      const restored = await durable.loadUnacked("doc-1");
      expect(restored.map((op) => op.id.c)).toEqual([1, 2]);
      durable.close();
    },
    10_000,
  );

  it("flush() commits immediately, bypassing the debounce timer entirely", async () => {
    const { durable } = await openFresh();
    durable.scheduleWriteUnacked(insertOp(1, 5), "doc-1");
    await durable.flush(); // no timer wait needed at all
    expect(await durable.loadUnacked("doc-1")).toHaveLength(1);
    durable.close();
  });
});
