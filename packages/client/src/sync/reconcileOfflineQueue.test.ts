import { describe, expect, it } from "vitest";
import { Engine, type DeleteOperation, type InsertOperation } from "@collab-editor/engine";
import { reconcileOfflineQueue, visibleIndexAfter, visibleIndexOfTarget } from "./reconcileOfflineQueue.js";

describe("reconcileOfflineQueue (Phase 22) — the client-only 'no session resumption' resolution", () => {
  it("re-mints a single offline insert under the NEW engine's replica id, preserving content and position", () => {
    const oldEngine = new Engine(1);
    const op = oldEngine.localInsert(0, 0x78); // 'x', minted under replica 1

    const newEngine = new Engine(2); // a fresh SNAPSHOT always assigns a brand-new replica id
    const resent = reconcileOfflineQueue(newEngine, [op]);

    expect(resent).toHaveLength(1);
    expect(resent[0]!.id.r).toBe(2); // new replica id, NOT the old op's replica id (1)
    expect(newEngine.text()).toBe("x");
  });

  it("chains consecutively-typed characters correctly (later ops anchor to EARLIER ops' NEW identities, not their stale ones)", () => {
    const oldEngine = new Engine(1);
    const a = oldEngine.localInsert(0, 0x61); // 'a'
    const b = oldEngine.localInsert(1, 0x62); // 'b', originLeft = a's OLD id
    const c = oldEngine.localInsert(2, 0x63); // 'c', originLeft = b's OLD id
    expect(oldEngine.text()).toBe("abc");

    const newEngine = new Engine(2);
    const resent = reconcileOfflineQueue(newEngine, [a, b, c]);

    expect(newEngine.text()).toBe("abc"); // NOT "a" + "b" + "c" scattered at position 0 each time
    expect(resent.every((op) => op.id.r === 2)).toBe(true);
  });

  it("anchors correctly onto content that already existed before the offline queue (not part of this replay batch)", () => {
    const newEngine = new Engine(2);
    newEngine.localInsert(0, 0x41); // 'A' — pre-existing content from the SNAPSHOT itself
    newEngine.localInsert(1, 0x42); // 'B'
    const existingA = newEngine.nodes[0]!;

    // An offline op typed by the OLD engine, anchored right after 'A' (same identifier space —
    // identifiers are globally stable, so this old op's originLeft genuinely matches the new
    // engine's own 'A' node).
    const offlineOp: InsertOperation = {
      kind: "insert",
      id: { c: 99, r: 1 },
      value: 0x78, // 'x'
      originLeft: existingA.id,
      originRight: null,
      bind: false,
    };

    const resent = reconcileOfflineQueue(newEngine, [offlineOp]);
    expect(resent).toHaveLength(1);
    expect(newEngine.text()).toBe("AxB"); // landed between A and B, per its own anchor
  });

  it("an offline delete targeting a node the other client concurrently deleted is silently skipped, not re-applied", () => {
    const newEngine = new Engine(2);
    const op = newEngine.localInsert(0, 0x78); // 'x' — inserted, then concurrently deleted by "the other client"
    newEngine.localDelete(0, 1);
    expect(newEngine.text()).toBe("");

    const offlineDelete: DeleteOperation = { kind: "delete", id: { c: 99, r: 1 }, target: op.id };
    const resent = reconcileOfflineQueue(newEngine, [offlineDelete]);

    expect(resent).toHaveLength(0); // nothing to re-delete — already gone
    expect(newEngine.text()).toBe("");
  });

  it("an offline delete targeting still-live content re-mints correctly under the new replica id", () => {
    const newEngine = new Engine(2);
    const op = newEngine.localInsert(0, 0x78); // pre-existing 'x', still live in the fresh snapshot

    const offlineDelete: DeleteOperation = { kind: "delete", id: { c: 99, r: 1 }, target: op.id };
    const resent = reconcileOfflineQueue(newEngine, [offlineDelete]);

    expect(resent).toHaveLength(1);
    expect(resent[0]!.id.r).toBe(2);
    expect(newEngine.text()).toBe("");
  });

  it("an insert-then-delete of the SAME character within one offline batch reconciles to a no-op document, both re-minted", () => {
    const oldEngine = new Engine(1);
    const insertOp = oldEngine.localInsert(0, 0x78); // 'x'
    const [deleteOp] = oldEngine.localDelete(0, 1); // delete it again, offline
    expect(oldEngine.text()).toBe("");

    const newEngine = new Engine(2);
    const resent = reconcileOfflineQueue(newEngine, [insertOp, deleteOp!]);

    expect(resent).toHaveLength(2); // both the insert AND the delete were re-minted
    expect(newEngine.text()).toBe(""); // net effect: nothing visible, matching the original intent
  });

  it("an empty queue reconciles to nothing", () => {
    const newEngine = new Engine(2);
    expect(reconcileOfflineQueue(newEngine, [])).toEqual([]);
  });
});

describe("visibleIndexAfter / visibleIndexOfTarget — the position-resolution helpers", () => {
  it("visibleIndexAfter(engine, null) is always 0 (document start)", () => {
    const engine = new Engine(1);
    engine.localInsert(0, 0x61);
    expect(visibleIndexAfter(engine, null)).toBe(0);
  });

  it("visibleIndexAfter correctly excludes an anchor that has since been tombstoned from the count", () => {
    const engine = new Engine(1);
    const a = engine.localInsert(0, 0x61); // 'a'
    engine.localInsert(1, 0x62); // 'b'
    engine.localDelete(0, 1); // delete 'a' — now tombstoned
    expect(engine.text()).toBe("b");
    // "insert right after a" should still resolve to visible index 0 (a contributes 0, since
    // it's no longer visible) — i.e., the new content lands right before 'b', where 'a' used
    // to be, not after 'b'.
    expect(visibleIndexAfter(engine, a.id)).toBe(0);
  });

  it("visibleIndexAfter falls back to 0 for a genuinely nonexistent anchor", () => {
    const engine = new Engine(1);
    engine.localInsert(0, 0x61);
    expect(visibleIndexAfter(engine, { c: 999, r: 999 })).toBe(0);
  });

  it("visibleIndexOfTarget returns null for a tombstoned node", () => {
    const engine = new Engine(1);
    const a = engine.localInsert(0, 0x61);
    engine.localDelete(0, 1);
    expect(visibleIndexOfTarget(engine, a.id)).toBeNull();
  });

  it("visibleIndexOfTarget returns null for a nonexistent identifier", () => {
    const engine = new Engine(1);
    expect(visibleIndexOfTarget(engine, { c: 999, r: 999 })).toBeNull();
  });

  it("visibleIndexOfTarget returns the correct 0-based visible index for a live node", () => {
    const engine = new Engine(1);
    engine.localInsert(0, 0x61); // 'a' — visible index 0
    const b = engine.localInsert(1, 0x62); // 'b' — visible index 1
    expect(visibleIndexOfTarget(engine, b.id)).toBe(1);
  });
});
