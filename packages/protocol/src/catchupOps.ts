// Phase 23 — single-operation wire encoding for CATCHUP_CHUNK payloads
// (API Spec §3.6.5). Each operation in a chunk is encoded as a complete
// OPS-channel single-op frame (seq: 0 — a placeholder; the real seq lives
// in `CatchupChunkMessage.throughSeq`/the persisted `operations.seq`
// column, never inside an individual op's own payload) via Phase 7's
// already-tested `operationToOpInsert`/`operationToOpDelete`/
// `operationToOpUndelete` + `encodeFrame`/`decodeFrame` — reusing the exact
// same shape `packages/server/src/db/operationStore.ts`'s
// `encodeOperationPayload`/`decodeOperationPayload` already use for a
// persisted operation's own `payload` column, rather than inventing a
// second, leaner single-operation wire format for what is otherwise the
// identical problem.

import type { Operation } from "@collab-editor/engine";
import { decodeFrame, encodeFrame } from "./codec.js";
import {
  opDeleteToOperation,
  opInsertToOperation,
  opUndeleteToOperation,
  operationToOpDelete,
  operationToOpInsert,
  operationToOpUndelete,
} from "./expand.js";

/** One operation, encoded as a complete single-op OPS-channel frame. */
export function encodeCatchupOperation(op: Operation): Uint8Array {
  const msg =
    op.kind === "insert"
      ? operationToOpInsert(op, 0)
      : op.kind === "delete"
        ? operationToOpDelete(op, 0)
        : operationToOpUndelete(op, 0);
  return encodeFrame(msg);
}

/** Inverse of {@link encodeCatchupOperation}. `direction: "clientOrigin"` is required (not incidental) — it's the only direction `decodeFrame` accepts a seq === 0 frame under, exactly what `encodeCatchupOperation` always writes. */
export function decodeCatchupOperation(bytes: Uint8Array): Operation {
  const msg = decodeFrame(bytes, { direction: "clientOrigin" });
  switch (msg.kind) {
    case "opInsert":
      return opInsertToOperation(msg);
    case "opDelete":
      return opDeleteToOperation(msg);
    case "opUndelete":
      return opUndeleteToOperation(msg);
    default:
      throw new Error(
        `decodeCatchupOperation: expected a single-operation frame (opInsert/opDelete/opUndelete), got ${msg.kind} — payload is corrupt`,
      );
  }
}
