import type { Operation } from "@collab-editor/engine";
import {
  expandDeleteBatch,
  expandInsertRun,
  opDeleteToOperation,
  opInsertToOperation,
  opUndeleteToOperation,
  type OpsMessage,
} from "@collab-editor/protocol";

/**
 * Expands any inbound OPS message into the one or more engine Operations it
 * represents. `decodeFrame({ direction: "clientOrigin" })` already rejects
 * OP_ACK/OP_REJECT (server→client only, API Spec §3.5.7/§3.5.8) before this
 * is ever called, so every `msg.kind` reaching here is one of the five
 * bidirectional types.
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
      throw new Error(
        `toOperations: ${msg.kind} is server→client only and should never reach the ingest path`,
      );
  }
}
