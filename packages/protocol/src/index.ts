// Binary wire codec and message types shared between client and server.
// See API/Protocol/Data Spec v1.0 §1.3 (format decision), §1.4 (origin
// stamps as identity), §3.1 (primitives), §3.2 (envelope), §3.5 (OPS
// messages). Pure module: no network, no DOM — testable standalone.

export const PROTOCOL_PACKAGE_NAME = "@collab-editor/protocol";

export { ProtocolDecodeError } from "./errors.js";
export { ByteReader, ByteWriter } from "./bytes.js";
export { readVarint, writeVarint } from "./varint.js";
export {
  decodeOptionalStamp,
  decodeScalar,
  decodeStamp,
  decodeString,
  decodeUuid,
  encodeOptionalStamp,
  encodeScalar,
  encodeStamp,
  encodeString,
  encodeUuid,
} from "./primitives.js";
export {
  type AckEntry,
  Channel,
  type OpAckMessage,
  type OpDeleteBatchMessage,
  type OpDeleteMessage,
  type OpInsertMessage,
  type OpInsertRunMessage,
  type OpRejectMessage,
  type OpsMessage,
  OpsMessageType,
  type OpUndeleteMessage,
  PROTOCOL_VERSION,
  type RejectEntry,
  RejectReason,
} from "./messages.js";
export { type DecodeFrameOptions, debugProject, decodeFrame, encodeFrame } from "./codec.js";
export {
  expandDeleteBatch,
  expandInsertRun,
  opDeleteToOperation,
  opInsertToOperation,
  opUndeleteToOperation,
  operationToOpDelete,
  operationToOpInsert,
  operationToOpUndelete,
} from "./expand.js";
