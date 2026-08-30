import type { Operation } from "@collab-editor/engine";
import {
  expandDeleteBatch,
  expandInsertRun,
  opDeleteToOperation,
  opInsertToOperation,
  opUndeleteToOperation,
  operationToOpDelete,
  operationToOpInsert,
  operationToOpUndelete,
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
