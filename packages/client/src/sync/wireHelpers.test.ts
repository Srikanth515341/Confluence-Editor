import { describe, expect, it } from "vitest";
import { Engine, type InsertOperation, type Operation } from "@collab-editor/engine";
import { expandInsertRun, type OpInsertRunMessage } from "@collab-editor/protocol";
import { operationsToRunMessages, operationsToWireMessages } from "./wireHelpers.js";

/** Mints `text.length` sequential local inserts against a fresh engine, starting at position 0 — exactly the shape `SyncClient.localInsertText` produces (chained `parent`, `side: "R"` — Fugue port, 2026-09-05; see expand.ts's own doc comment for the hand-traced derivation). */
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
      expect(msg.firstParent).toEqual(ops[0]!.parent);
      expect(msg.firstSide).toEqual(ops[0]!.side);
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
        parent: ops[0]!.parent,
        side: ops[0]!.side,
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

describe("REGRESSION, fixed (found + fixed 2026-09-06, Phase 25 DUR-06 investigation) — operationsToRunMessages must not coalesce reconciled, non-chained inserts", () => {
  // Root cause (see wireHelpers.ts's own doc comment on operationsToRunMessages/continuesRun for
  // the full account): grouping used to check ONLY `ops[j].bind === ops[i].bind`, never the actual
  // chain relationship expandInsertRun's decoder hardcodes for every run member after the first:
  // `ops[j].parent === ops[j-1].id && ops[j].side === "R"`. That relationship genuinely holds for
  // this function's ORIGINAL caller (SyncClient.localInsertText's synchronous typing burst) but is
  // NOT guaranteed for its Phase 24 caller, operationsToWireMessages, used by
  // finishHandshakeAfterAlreadyHave to coalesce reconcileOfflineQueue's independently re-anchored
  // reconciliation resends. Two reconciled inserts sharing consecutive counters (inevitable: same
  // engine, minted back-to-back) and the same `bind` flag (near-certain for ordinary text, since
  // `bind` defaults false) used to be wrongly coalesced into ONE OP_INSERT_RUN, which can only
  // encode the FIRST operation's true parent/side — every subsequent operation's true parent/side
  // was silently discarded and replaced on decode by expandInsertRun's hardcoded chain-continuation
  // assumption.
  //
  // This requires NO fault injection, delay, duplication, or reordering to reach — it was a
  // deterministic wire-encoding defect triggered by ordinary reconnection reconciliation whenever
  // any client goes offline with 2+ unacked/un-reconciled inserts that don't happen to form a true
  // parent chain. This is what produced DUR-06's field-level node corruption (parent/side
  // mismatches between server and client on shared node ids) roughly half the time it failed to
  // converge — confirmed by direct base64/field-level diffing of the divergent replicas'
  // materialized text and node structure before this fix was written.
  it("two independently-anchored reconciled inserts sharing consecutive counters and the same bind flag, but NOT a true parent chain, are emitted as SEPARATE OP_INSERT messages, preserving both true parent/side fields", () => {
    const engine = new Engine(22);
    const opA = engine.localInsert(0, "P".codePointAt(0)!); // anchors under root, side "R"
    const opB = engine.localInsert(0, "Q".codePointAt(0)!); // anchors BEFORE opA -> parent=opA.id, side "L"
    expect(opB.parent).toEqual(opA.id);
    expect(opB.side).toBe("L");

    // reconcileOfflineQueue's own resend path.
    const messages = operationsToWireMessages([opA, opB]);

    // FIXED: no longer coalesced — opB does not form a true parent chain off opA (side "L", not
    // the "R" expandInsertRun's decoder would assume for a run continuation).
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.kind)).toEqual(["opInsert", "opInsert"]);

    // Both operations' TRUE fields survive the wire round trip exactly.
    expect(messages[0]).toEqual({
      kind: "opInsert",
      seq: 0,
      id: opA.id,
      parent: opA.parent,
      side: opA.side,
      bind: opA.bind,
      value: opA.value,
    });
    expect(messages[1]).toEqual({
      kind: "opInsert",
      seq: 0,
      id: opB.id,
      parent: opB.parent,
      side: opB.side,
      bind: opB.bind,
      value: opB.value,
    });
  });

  it("still correctly coalesces a genuine chain within a reconciliation resend (e.g. two consecutively-typed offline characters, replayed back to back)", () => {
    const engine = new Engine(33);
    const opA = engine.localInsert(0, "X".codePointAt(0)!); // parent: null, side: "R"
    const opB = engine.localInsert(1, "Y".codePointAt(0)!); // continues the chain: parent=opA.id, side "R"
    expect(opB.parent).toEqual(opA.id);
    expect(opB.side).toBe("R");

    const messages = operationsToWireMessages([opA, opB]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.kind).toBe("opInsertRun");

    const decoded = expandInsertRun(messages[0] as OpInsertRunMessage);
    expect(decoded).toEqual([opA, opB]);
  });

  it("a chain that breaks partway through a batch splits into multiple runs/individual messages, rather than merging everything or falling back to all-individual", () => {
    const engine = new Engine(44);
    // A genuine 2-chain: op0 -> op1 (op1.parent === op0.id, side "R").
    const op0 = engine.localInsert(0, "A".codePointAt(0)!);
    const op1 = engine.localInsert(1, "B".codePointAt(0)!);
    expect(op1.parent).toEqual(op0.id);
    expect(op1.side).toBe("R");

    // op2: independently anchored elsewhere — breaks the chain from op1.
    const op2 = engine.localInsert(0, "C".codePointAt(0)!);
    expect(op2.parent).not.toEqual(op1.id);

    // A fresh, genuine 2-chain: op3 -> op4.
    const op3 = engine.localInsert(0, "D".codePointAt(0)!);
    const op4 = engine.localInsert(1, "E".codePointAt(0)!);
    expect(op4.parent).toEqual(op3.id);
    expect(op4.side).toBe("R");
    // op3 itself must not continue op2's chain, or this wouldn't be testing a genuine break.
    expect(op3.side === "R" && op3.parent !== null && op3.parent.c === op2.id.c && op3.parent.r === op2.id.r).toBe(false);

    const messages = operationsToRunMessages([op0, op1, op2, op3, op4]);

    // Expected: run(op0,op1), individual(op2), run(op3,op4) — 3 messages, not 1 (over-merged)
    // and not 5 (wrongly degraded to all-individual from a single break).
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.kind)).toEqual(["opInsertRun", "opInsert", "opInsertRun"]);
    if (messages[0]!.kind === "opInsertRun") {
      expect(messages[0]!.values).toEqual([op0.value, op1.value]);
    }
    expect((messages[1] as { id: typeof op2.id }).id).toEqual(op2.id);
    if (messages[2]!.kind === "opInsertRun") {
      expect(messages[2]!.values).toEqual([op3.value, op4.value]);
    }
  });

  it("localInsertText's own synchronous typing burst still coalesces into exactly one run, unaffected by the fix (no wire-efficiency regression on the common path)", () => {
    const engine = new Engine(1);
    const ops: InsertOperation[] = [];
    let at = 0;
    for (const ch of "a".repeat(2000)) {
      ops.push(engine.localInsert(at, ch.codePointAt(0)!));
      at += 1;
    }
    const messages = operationsToRunMessages(ops);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.kind).toBe("opInsertRun");
    if (messages[0]!.kind === "opInsertRun") {
      expect(messages[0]!.values).toHaveLength(2000);
    }
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
