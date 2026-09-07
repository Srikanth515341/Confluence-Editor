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
    parent: msg.parent,
    side: msg.side,
    bind: msg.bind,
  };
}

export function operationToOpInsert(op: InsertOperation, seq = 0): OpInsertMessage {
  return {
    kind: "opInsert",
    seq,
    id: op.id,
    parent: op.parent,
    side: op.side,
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
 * Expands an OP_INSERT_RUN into one InsertOperation per character.
 *
 * Fugue port (2026-09-05) — this is no longer a literal translation of a
 * pre-existing spec table (the old §3.5.2 expansion table described
 * `originLeft`/`originRight` chaining, which no longer exists); it is a
 * hand-traced re-derivation against `FugueTree.decidePlacement`'s own
 * logic, verified by an exact round-trip test against a real `Engine`
 * (see codec.test.ts's "expands a 2,000-character run identically to
 * 2,000 individual OP_INSERT frames" test):
 *
 * 1. `id.c` is `firstId.c + j` for the j-th character, exactly as before —
 *    consecutive local `mint()`s produce consecutive counters (Engine
 *    Spec §3.4), so the run's own counters need never be listed
 *    individually.
 * 2. Node 0 uses the run's own `firstParent`/`firstSide` — this is
 *    `Engine.localInsert()`'s own `decidePlacement()` output at the
 *    moment the FIRST character of the run was minted.
 * 3. For every node j >= 1, `parent` is ALWAYS `{c: firstId.c + j - 1, r:
 *    firstId.r}` (the immediately preceding character in this SAME run)
 *    and `side` is ALWAYS `"R"`. This holds unconditionally, not just for
 *    "the common case": `FugueTree.attach()` gives a freshly-created node
 *    zero children, so the VERY NEXT `decidePlacement()` call at the
 *    position immediately following it — which is exactly what minting
 *    the run's next character does, since nothing else can interleave
 *    within one synchronous `localInsertText()` burst — always finds
 *    "the node immediately before this position has no right children
 *    yet" and returns `{parent: <that node>, side: "R"}`. There is no
 *    Fugue analogue of the retired "shared originRight for the whole
 *    run" field at all: Fugue has no second, separately-tracked boundary
 *    reference to share.
 *
 * `bind` applies uniformly to every expanded node — §3.5.2 models a run as
 * one grapheme-cluster-uniform burst, so there is no per-character bind
 * bit on the wire.
 */
export function expandInsertRun(msg: OpInsertRunMessage): InsertOperation[] {
  const ops: InsertOperation[] = [];
  for (let j = 0; j < msg.values.length; j++) {
    const id: Identifier = { c: msg.firstId.c + j, r: msg.firstId.r };
    const parent: Identifier | null =
      j === 0 ? msg.firstParent : { c: msg.firstId.c + j - 1, r: msg.firstId.r };
    const side: "L" | "R" = j === 0 ? msg.firstSide : "R";
    ops.push({
      kind: "insert",
      id,
      value: msg.values[j]!,
      parent,
      side,
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
