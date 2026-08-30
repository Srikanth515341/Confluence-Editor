import type { InsertOperation, Operation } from "@collab-editor/engine";
import {
  expandDeleteBatch,
  expandInsertRun,
  opDeleteToOperation,
  opInsertToOperation,
  opUndeleteToOperation,
  operationToOpDelete,
  operationToOpInsert,
  operationToOpUndelete,
  type OpInsertRunMessage,
  type OpsMessage,
} from "@collab-editor/protocol";

/**
 * Expands any inbound OPS message into the engine Operation(s) it
 * represents — the client-side mirror of `packages/server/src/ingest.ts`'s
 * `toOperations`. Duplicated rather than imported: `packages/client` must
 * not depend on `@collab-editor/server` (a client-side module has no
 * business depending on the server package), and this is a small, stable,
 * pure function built entirely from Phase 7's `@collab-editor/protocol`
 * exports.
 */
export function toOperations(msg: OpsMessage): Operation[] {
  switch (msg.kind) {
    case "opInsert":
      return [opInsertToOperation(msg)];
    case "opInsertRun":
      return expandInsertRun(msg);
    case "opDelete":
      return [opDeleteToOperation(msg)];
    case "opDeleteBatch":
      return expandDeleteBatch(msg);
    case "opUndelete":
      return [opUndeleteToOperation(msg)];
    case "opAck":
    case "opReject":
      throw new Error(`toOperations: ${msg.kind} carries no operation to apply`);
  }
}

/** The reverse direction: one locally-minted engine Operation to the OPS message that carries it (always `seq: 0` — client-origin, API Spec §3.5.1). */
export function operationToOpsMessage(op: Operation): OpsMessage {
  switch (op.kind) {
    case "insert":
      return operationToOpInsert(op, 0);
    case "delete":
      return operationToOpDelete(op, 0);
    case "undelete":
      return operationToOpUndelete(op, 0);
  }
}

/**
 * Coalesces a sequence of locally-minted `InsertOperation`s (as produced by
 * calling `Engine.localInsert()` once per character, in ascending-position
 * order — Phase 12's `SyncClient.localInsertText`) into as few OPS
 * messages as possible, per API Spec §3.5.2: consecutive characters from
 * one run mint CONSECUTIVE counters by construction (Engine Spec §3.4), so
 * any maximal run of two or more with the SAME `bind` flag (§3.5.2 models a
 * run as one grapheme-cluster-uniform burst — there is no per-character
 * bind bit on the wire) becomes one OP_INSERT_RUN; everything else
 * (singletons, or a bind-flag change) falls back to individual OP_INSERT
 * messages. This is what turns a 2,000-character paste into ONE wire frame
 * instead of 2,000 (Test Plan MUT-01), while still coalescing correctly
 * around any embedded combining marks in less common inputs.
 */
export function operationsToRunMessages(ops: readonly InsertOperation[]): OpsMessage[] {
  const messages: OpsMessage[] = [];
  let i = 0;
  while (i < ops.length) {
    let j = i + 1;
    while (j < ops.length && ops[j]!.bind === ops[i]!.bind) {
      j += 1;
    }
    const group = ops.slice(i, j);
    const first = group[0]!;
    if (group.length >= 2) {
      const runMsg: OpInsertRunMessage = {
        kind: "opInsertRun",
        seq: 0,
        firstId: first.id,
        originLeft: first.originLeft,
        originRight: first.originRight,
        bind: first.bind,
        values: group.map((op) => op.value),
      };
      messages.push(runMsg);
    } else {
      messages.push(operationToOpInsert(first, 0));
    }
    i = j;
  }
  return messages;
}
