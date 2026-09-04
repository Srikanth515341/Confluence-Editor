import { describe, expect, it } from "vitest";
import { Engine, type InsertOperation, type Operation } from "@collab-editor/engine";
import { operationsToRunMessages, operationsToWireMessages } from "./wireHelpers.js";

/** Mints `text.length` sequential local inserts against a fresh engine, starting at position 0 — exactly the shape `SyncClient.localInsertText` produces (chained originLeft, shared originRight, Phase 7's own equivalence check). */
function sequentialInserts(text: string): InsertOperation[] {
  const engine = new Engine(1);
  const ops: InsertOperation[] = [];
  let at = 0;
  for (const ch of text) {
    ops.push(engine.localInsert(at, ch.codePointAt(0)!));
    at += 1;
  }
  return ops;
}

describe("operationsToRunMessages — API Spec §3.5.2 wire coalescing", () => {
  it("coalesces a long uniform-bind run into exactly ONE OP_INSERT_RUN (Test Plan MUT-01: paste 2,000 chars -> one frame)", () => {
    const ops = sequentialInserts("a".repeat(2000));
    const messages = operationsToRunMessages(ops);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.kind).toBe("opInsertRun");
    if (msg.kind === "opInsertRun") {
      expect(msg.values).toHaveLength(2000);
      expect(msg.firstId).toEqual(ops[0]!.id);
      expect(msg.originLeft).toEqual(ops[0]!.originLeft);
      expect(msg.originRight).toEqual(ops[0]!.originRight);
      expect(msg.bind).toBe(false);
    }
  });

  it("a single character never becomes a run (API Spec §3.5.2 requires n >= 2)", () => {
    const ops = sequentialInserts("a");
    const messages = operationsToRunMessages(ops);
    expect(messages).toEqual([
      {
        kind: "opInsert",
        seq: 0,
        id: ops[0]!.id,
        originLeft: ops[0]!.originLeft,
        originRight: ops[0]!.originRight,
        bind: ops[0]!.bind,
        value: ops[0]!.value,
      },
    ]);
  });

  it("splits into separate messages at a bind-flag change (a combining mark cannot share a run with an ordinary character, §3.5.2: bind applies to the WHOLE run)", () => {
    // "e" + combining acute (U+0301) + "f": bind = [false, true, false] — three distinct groups.
    const ops = sequentialInserts("éf");
    const messages = operationsToRunMessages(ops);
    expect(messages.map((m) => m.kind)).toEqual(["opInsert", "opInsert", "opInsert"]);
  });

  it("groups a same-bind run of exactly 2 into one OP_INSERT_RUN, matching the n>=2 minimum exactly", () => {
    const ops = sequentialInserts("ab");
    const messages = operationsToRunMessages(ops);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.kind).toBe("opInsertRun");
  });

  it("an empty operation list produces no messages", () => {
    expect(operationsToRunMessages([])).toEqual([]);
  });
});

describe("operationsToWireMessages — Phase 24 mixed insert/delete coalescing (RC-32: '400 operations ... in one response')", () => {
  it("coalesces a long run of consecutive inserts into ONE OP_INSERT_RUN, matching operationsToRunMessages exactly", () => {
    const ops: Operation[] = sequentialInserts("a".repeat(400));
    const messages = operationsToWireMessages(ops);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.kind).toBe("opInsertRun");
    if (messages[0]!.kind === "opInsertRun") {
      expect(messages[0]!.values).toHaveLength(400);
    }
  });

  it("coalesces a run of consecutive deletes (same replica, consecutive id.c) into ONE OP_DELETE_BATCH", () => {
    const engine = new Engine(1);
    for (const ch of "abcde") {
      engine.localInsert(0, ch.codePointAt(0)!);
    }
    // localDelete(0, 5) mints 5 deletes with consecutive counters from this ONE engine.
    const ops = engine.localDelete(0, 5);
    const messages = operationsToWireMessages(ops);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      kind: "opDeleteBatch",
      seq: 0,
      by: 1,
      atFirst: ops[0]!.id.c,
      targets: ops.map((op) => op.target),
    });
  });

  it("a lone delete never becomes a batch (API Spec §3.5.4 requires n >= 2)", () => {
    const engine = new Engine(1);
    engine.localInsert(0, 0x61);
    const ops = engine.localDelete(0, 1);
    const messages = operationsToWireMessages(ops);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.kind).toBe("opDelete");
  });

  it("splits into separate groups at an insert/delete kind boundary", () => {
    const engine = new Engine(1);
    const insertOps: Operation[] = [
      engine.localInsert(0, 0x61),
      engine.localInsert(1, 0x62),
    ];
    const deleteOps = engine.localDelete(0, 2);
    const ops: Operation[] = [...insertOps, ...deleteOps];
    const messages = operationsToWireMessages(ops);
    // One coalesced insert run, then one coalesced delete batch -- exactly 2 messages, not 4.
    expect(messages.map((m) => m.kind)).toEqual(["opInsertRun", "opDeleteBatch"]);
  });

  it("an empty operation list produces no messages", () => {
    expect(operationsToWireMessages([])).toEqual([]);
  });
});
