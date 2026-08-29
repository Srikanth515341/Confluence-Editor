import type {
  DeleteOperation,
  Identifier,
  InsertOperation,
  UndeleteOperation,
} from "@collab-editor/engine";
import type {
  OpDeleteBatchMessage,
  OpDeleteMessage,
  OpInsertMessage,
  OpInsertRunMessage,
  OpUndeleteMessage,
} from "./messages.js";

// --- OpsMessage <-> engine Operation (1:1 message types) --------------------

export function opInsertToOperation(msg: OpInsertMessage): InsertOperation {
  return {
    kind: "insert",
    id: msg.id,
    value: msg.value,
    originLeft: msg.originLeft,
    originRight: msg.originRight,
    bind: msg.bind,
  };
}

export function operationToOpInsert(op: InsertOperation, seq = 0): OpInsertMessage {
  return {
    kind: "opInsert",
    seq,
    id: op.id,
    originLeft: op.originLeft,
    originRight: op.originRight,
    bind: op.bind,
    value: op.value,
  };
}

export function opDeleteToOperation(msg: OpDeleteMessage): DeleteOperation {
  return { kind: "delete", id: msg.id, target: msg.target };
}

export function operationToOpDelete(op: DeleteOperation, seq = 0): OpDeleteMessage {
  return { kind: "opDelete", seq, id: op.id, target: op.target };
}

export function opUndeleteToOperation(msg: OpUndeleteMessage): UndeleteOperation {
  return { kind: "undelete", id: msg.id, target: msg.target };
}

export function operationToOpUndelete(op: UndeleteOperation, seq = 0): OpUndeleteMessage {
  return { kind: "opUndelete", seq, id: op.id, target: op.target };
}

// --- OP_INSERT_RUN / OP_DELETE_BATCH expansion (API Spec §3.5.2) -----------

/**
 * Expands an OP_INSERT_RUN into one InsertOperation per character, exactly
 * per API Spec §3.5.2. Two things are easy to get backwards here, so both
 * are called out explicitly:
 *
 * 1. `id.c` is `firstId.c + j` for the j-th character — this relies on
 *    the SAME fact Engine Spec §3.4 relies on for block run-length
 *    encoding: consecutive local `mint()`s produce consecutive counters,
 *    so the run's own counters need never be listed individually.
 * 2. `originLeft` CHAINS forward (node j's originLeft is node j-1's id,
 *    for j > 0; only node 0 uses the run's own `originLeft`) — this is
 *    what makes the run behave, under `integrate()`, exactly like the
 *    characters having been typed one at a time via separate
 *    `localInsert()` calls, each anchored on the one immediately before
 *    it. `originRight`, in contrast, does NOT chain — every expanded node
 *    gets the SAME `originRight`, the run's own shared right boundary, not
 *    its predecessor (§3.5.2's expansion table states this explicitly:
 *    "SAME right origin for EVERY node in the run, not the predecessor").
 *    Chaining originRight too would anchor each character only against
 *    its immediate successor rather than the run's actual right neighbor
 *    at insertion time, changing where `integrate()` places the run
 *    relative to concurrent inserts anchored at that same boundary.
 *
 * `bind` applies uniformly to every expanded node — §3.5.2 models a run as
 * one grapheme-cluster-uniform burst, so there is no per-character bind
 * bit on the wire.
 */
export function expandInsertRun(msg: OpInsertRunMessage): InsertOperation[] {
  const ops: InsertOperation[] = [];
  for (let j = 0; j < msg.values.length; j++) {
    const id: Identifier = { c: msg.firstId.c + j, r: msg.firstId.r };
    const originLeft: Identifier | null =
      j === 0 ? msg.originLeft : { c: msg.firstId.c + j - 1, r: msg.firstId.r };
    ops.push({
      kind: "insert",
      id,
      value: msg.values[j]!,
      originLeft,
      originRight: msg.originRight,
      bind: msg.bind,
    });
  }
  return ops;
}

/** Expands an OP_DELETE_BATCH into one DeleteOperation per target, using the batch's own consecutive counters starting at `atFirst` on replica `by` (see {@link OpDeleteBatchMessage}, §3.5.4). */
export function expandDeleteBatch(msg: OpDeleteBatchMessage): DeleteOperation[] {
  return msg.targets.map((target, i) => ({
    kind: "delete" as const,
    id: { c: msg.atFirst + i, r: msg.by },
    target,
  }));
}
