import type { Identifier } from "@collab-editor/engine";
import { serializeId } from "@collab-editor/engine";
import { ByteReader, ByteWriter } from "./bytes.js";
import { ProtocolDecodeError } from "./errors.js";
import {
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
import {
  decodeOptionalStamp,
  decodeStamp,
  encodeOptionalStamp,
  encodeStamp,
} from "./primitives.js";
import { readVarint, writeVarint } from "./varint.js";

/** Which side produced the frame being decoded — governs the `seq` check and the OP_ACK/OP_REJECT directionality check below. */
export interface DecodeFrameOptions {
  readonly direction?: "clientOrigin" | "serverOrigin";
}

// --- OP_INSERT / OP_INSERT_RUN flags byte (§3.5.1, §3.5.2) ------------------
// bits 3-7 MUST be 0 — a set reserved bit is a malformed frame, so a future
// protocol version using a bit this build doesn't know about is never
// silently misinterpreted.
const FLAG_HAS_ORIGIN_LEFT = 0x01;
const FLAG_HAS_ORIGIN_RIGHT = 0x02;
const FLAG_BIND = 0x04;
const INSERT_FLAGS_KNOWN_BITS = FLAG_HAS_ORIGIN_LEFT | FLAG_HAS_ORIGIN_RIGHT | FLAG_BIND;

function checkNoReservedBits(
  byte: number,
  knownBits: number,
  reason: string,
  message: string,
): void {
  if ((byte & ~knownBits) !== 0) {
    throw new ProtocolDecodeError(reason, message);
  }
}

/** Every bidirectional OPS message's `seq` must be 0 coming from a client — the server is the only party allowed to assign a nonzero value (§3.5.1). */
function readAndCheckSeq(reader: ByteReader, direction: "clientOrigin" | "serverOrigin"): number {
  const seq = readVarint(reader);
  if (direction === "clientOrigin" && seq !== 0) {
    throw new ProtocolDecodeError(
      "NONZERO_CLIENT_SEQ",
      `client-origin frame must have seq === 0, got ${seq}`,
    );
  }
  return seq;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

// --- per-message-type payload codecs ----------------------------------------

function encodeOpInsertPayload(writer: ByteWriter, msg: OpInsertMessage): void {
  writeVarint(writer, msg.seq);
  let flags = 0;
  if (msg.originLeft !== null) flags |= FLAG_HAS_ORIGIN_LEFT;
  if (msg.originRight !== null) flags |= FLAG_HAS_ORIGIN_RIGHT;
  if (msg.bind) flags |= FLAG_BIND;
  writer.writeByte(flags);
  encodeStamp(writer, msg.id);
  encodeOptionalStamp(writer, msg.originLeft);
  encodeOptionalStamp(writer, msg.originRight);
  writeVarint(writer, msg.value);
}

function decodeOpInsertPayload(
  reader: ByteReader,
  direction: "clientOrigin" | "serverOrigin",
): OpInsertMessage {
  const seq = readAndCheckSeq(reader, direction);
  const flags = reader.readByte();
  checkNoReservedBits(
    flags,
    INSERT_FLAGS_KNOWN_BITS,
    "RESERVED_FLAG_BITS_SET",
    "OP_INSERT flags byte has a reserved bit set (bits 3-7 must be 0)",
  );
  const id = decodeStamp(reader);
  const originLeft = decodeOptionalStamp(reader, (flags & FLAG_HAS_ORIGIN_LEFT) !== 0);
  const originRight = decodeOptionalStamp(reader, (flags & FLAG_HAS_ORIGIN_RIGHT) !== 0);
  const value = readVarint(reader);
  return {
    kind: "opInsert",
    seq,
    id,
    originLeft,
    originRight,
    bind: (flags & FLAG_BIND) !== 0,
    value,
  };
}

function encodeOpInsertRunPayload(writer: ByteWriter, msg: OpInsertRunMessage): void {
  if (msg.values.length < 2) {
    throw new RangeError(
      "encodeOpInsertRunPayload: a run must contain at least 2 characters (n >= 2, §3.5.2)",
    );
  }
  writeVarint(writer, msg.seq);
  let flags = 0;
  if (msg.originLeft !== null) flags |= FLAG_HAS_ORIGIN_LEFT;
  if (msg.originRight !== null) flags |= FLAG_HAS_ORIGIN_RIGHT;
  if (msg.bind) flags |= FLAG_BIND;
  writer.writeByte(flags);
  encodeStamp(writer, msg.firstId);
  encodeOptionalStamp(writer, msg.originLeft);
  encodeOptionalStamp(writer, msg.originRight);
  writeVarint(writer, msg.values.length);
  const utf8 = textEncoder.encode(String.fromCodePoint(...msg.values));
  writeVarint(writer, utf8.length);
  writer.writeBytes(utf8);
}

function decodeOpInsertRunPayload(
  reader: ByteReader,
  direction: "clientOrigin" | "serverOrigin",
): OpInsertRunMessage {
  const seq = readAndCheckSeq(reader, direction);
  const flags = reader.readByte();
  checkNoReservedBits(
    flags,
    INSERT_FLAGS_KNOWN_BITS,
    "RESERVED_FLAG_BITS_SET",
    "OP_INSERT_RUN flags byte has a reserved bit set (bits 3-7 must be 0)",
  );
  const firstId = decodeStamp(reader);
  const originLeft = decodeOptionalStamp(reader, (flags & FLAG_HAS_ORIGIN_LEFT) !== 0);
  const originRight = decodeOptionalStamp(reader, (flags & FLAG_HAS_ORIGIN_RIGHT) !== 0);
  const count = readVarint(reader);
  if (count < 2) {
    throw new ProtocolDecodeError(
      "RUN_TOO_SHORT",
      `OP_INSERT_RUN declared count ${count}, must be >= 2`,
    );
  }
  const byteLength = readVarint(reader);
  const utf8 = reader.readBytes(byteLength);
  let text: string;
  try {
    text = textDecoder.decode(utf8);
  } catch {
    throw new ProtocolDecodeError("INVALID_UTF8", "OP_INSERT_RUN's utf8 field is not valid UTF-8");
  }
  const values = Array.from(text, (ch) => ch.codePointAt(0)!);
  if (values.length !== count) {
    throw new ProtocolDecodeError(
      "RUN_LENGTH_MISMATCH",
      `OP_INSERT_RUN declared count ${count} but utf8 decoded to ${values.length} scalar(s)`,
    );
  }
  return {
    kind: "opInsertRun",
    seq,
    firstId,
    originLeft,
    originRight,
    bind: (flags & FLAG_BIND) !== 0,
    values,
  };
}

function encodeOpDeletePayload(writer: ByteWriter, msg: OpDeleteMessage): void {
  writeVarint(writer, msg.seq);
  encodeStamp(writer, msg.target);
  writeVarint(writer, msg.id.c); // at
  writeVarint(writer, msg.id.r); // by
}

function decodeOpDeletePayload(
  reader: ByteReader,
  direction: "clientOrigin" | "serverOrigin",
): OpDeleteMessage {
  const seq = readAndCheckSeq(reader, direction);
  const target = decodeStamp(reader);
  const at = readVarint(reader);
  const by = readVarint(reader);
  return { kind: "opDelete", seq, id: { c: at, r: by }, target };
}

function encodeOpDeleteBatchPayload(writer: ByteWriter, msg: OpDeleteBatchMessage): void {
  if (msg.targets.length < 2) {
    throw new RangeError(
      "encodeOpDeleteBatchPayload: a batch must contain at least 2 targets (n >= 2, §3.5.4)",
    );
  }
  writeVarint(writer, msg.seq);
  writeVarint(writer, msg.by);
  writeVarint(writer, msg.atFirst);
  writeVarint(writer, msg.targets.length);
  for (const target of msg.targets) {
    encodeStamp(writer, target);
  }
}

function decodeOpDeleteBatchPayload(
  reader: ByteReader,
  direction: "clientOrigin" | "serverOrigin",
): OpDeleteBatchMessage {
  const seq = readAndCheckSeq(reader, direction);
  const by = readVarint(reader);
  const atFirst = readVarint(reader);
  const count = readVarint(reader);
  if (count < 2) {
    throw new ProtocolDecodeError(
      "BATCH_TOO_SHORT",
      `OP_DELETE_BATCH declared count ${count}, must be >= 2`,
    );
  }
  const targets: Identifier[] = [];
  for (let i = 0; i < count; i++) {
    targets.push(decodeStamp(reader));
  }
  return { kind: "opDeleteBatch", seq, by, atFirst, targets };
}

function encodeOpUndeletePayload(writer: ByteWriter, msg: OpUndeleteMessage): void {
  writeVarint(writer, msg.seq);
  encodeStamp(writer, msg.target);
  writeVarint(writer, msg.id.c); // at
  writeVarint(writer, msg.id.r); // by
}

function decodeOpUndeletePayload(
  reader: ByteReader,
  direction: "clientOrigin" | "serverOrigin",
): OpUndeleteMessage {
  const seq = readAndCheckSeq(reader, direction);
  const target = decodeStamp(reader);
  const at = readVarint(reader);
  const by = readVarint(reader);
  return { kind: "opUndelete", seq, id: { c: at, r: by }, target };
}

function encodeOpAckPayload(writer: ByteWriter, msg: OpAckMessage): void {
  writeVarint(writer, msg.acks.length);
  for (const ack of msg.acks) {
    writeVarint(writer, ack.ackSeq);
    encodeStamp(writer, ack.ackedId);
  }
}

function decodeOpAckPayload(reader: ByteReader): OpAckMessage {
  const count = readVarint(reader);
  const acks: AckEntry[] = [];
  for (let i = 0; i < count; i++) {
    const ackSeq = readVarint(reader);
    const ackedId = decodeStamp(reader);
    acks.push({ ackSeq, ackedId });
  }
  return { kind: "opAck", acks };
}

const REJECT_REASON_VALUES = new Set<number>(
  Object.values(RejectReason).filter((v) => typeof v === "number"),
);

function encodeOpRejectPayload(writer: ByteWriter, msg: OpRejectMessage): void {
  writeVarint(writer, msg.rejects.length);
  for (const reject of msg.rejects) {
    encodeStamp(writer, reject.rejectedId);
    writer.writeByte(reject.reason);
  }
  const detailBytes = textEncoder.encode(msg.detail);
  writeVarint(writer, detailBytes.length);
  if (detailBytes.length > 0) {
    writer.writeBytes(detailBytes);
  }
}

function decodeOpRejectPayload(reader: ByteReader): OpRejectMessage {
  const count = readVarint(reader);
  const rejects: RejectEntry[] = [];
  for (let i = 0; i < count; i++) {
    const rejectedId = decodeStamp(reader);
    const reason = reader.readByte();
    if (!REJECT_REASON_VALUES.has(reason)) {
      throw new ProtocolDecodeError(
        "UNKNOWN_REJECT_REASON",
        `${reason} is not one of the 7 defined RejectReason codes`,
      );
    }
    rejects.push({ rejectedId, reason: reason as RejectReason });
  }
  const detailLength = readVarint(reader);
  let detail = "";
  if (detailLength > 0) {
    const detailBytes = reader.readBytes(detailLength);
    try {
      detail = textDecoder.decode(detailBytes);
    } catch {
      throw new ProtocolDecodeError("INVALID_UTF8", "OP_REJECT's detail field is not valid UTF-8");
    }
  }
  return { kind: "opReject", rejects, detail };
}

// --- frame-level encode/decode ----------------------------------------------

function messageTypeOf(msg: OpsMessage): OpsMessageType {
  switch (msg.kind) {
    case "opInsert":
      return OpsMessageType.OP_INSERT;
    case "opInsertRun":
      return OpsMessageType.OP_INSERT_RUN;
    case "opDelete":
      return OpsMessageType.OP_DELETE;
    case "opDeleteBatch":
      return OpsMessageType.OP_DELETE_BATCH;
    case "opUndelete":
      return OpsMessageType.OP_UNDELETE;
    case "opAck":
      return OpsMessageType.OP_ACK;
    case "opReject":
      return OpsMessageType.OP_REJECT;
  }
}

/**
 * Encodes one OPS message to a complete frame: the 3-byte envelope
 * (protocolVersion, channel, messageType — §3.2), immediately followed by
 * the message-specific payload at offset 3 — there is no frame-level
 * flags byte, length prefix, or correlation id (§3.2's explicit "No ..."
 * list).
 */
export function encodeFrame(msg: OpsMessage): Uint8Array {
  const writer = new ByteWriter();
  writer.writeByte(PROTOCOL_VERSION);
  writer.writeByte(Channel.OPS);
  writer.writeByte(messageTypeOf(msg));

  switch (msg.kind) {
    case "opInsert":
      encodeOpInsertPayload(writer, msg);
      break;
    case "opInsertRun":
      encodeOpInsertRunPayload(writer, msg);
      break;
    case "opDelete":
      encodeOpDeletePayload(writer, msg);
      break;
    case "opDeleteBatch":
      encodeOpDeleteBatchPayload(writer, msg);
      break;
    case "opUndelete":
      encodeOpUndeletePayload(writer, msg);
      break;
    case "opAck":
      encodeOpAckPayload(writer, msg);
      break;
    case "opReject":
      encodeOpRejectPayload(writer, msg);
      break;
  }

  return writer.toUint8Array();
}

/**
 * Decodes a complete frame back into an {@link OpsMessage}. Rejects with a
 * {@link ProtocolDecodeError} — never a raw crash — for: an unrecognized
 * protocol version, an unrecognized channel, a reserved flag bit set
 * inside a message-specific flags byte, a client-origin frame whose `seq`
 * is not 0, a client-origin OP_ACK/OP_REJECT (both are server→client only,
 * §3.5.7/§3.5.8), a run/batch declaring fewer than 2 members, a run whose
 * declared count doesn't match its decoded UTF-8 text, an unrecognized
 * message type, an unrecognized OP_REJECT reason, or a frame that runs out
 * of bytes mid-field / has trailing bytes after a valid payload.
 */
export function decodeFrame(bytes: Uint8Array, opts: DecodeFrameOptions = {}): OpsMessage {
  const direction = opts.direction ?? "clientOrigin";
  const reader = new ByteReader(bytes);

  const protocolVersion = reader.readByte();
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolDecodeError(
      "UNSUPPORTED_PROTOCOL_VERSION",
      `frame declares protocol version ${protocolVersion}, this build supports ${PROTOCOL_VERSION}`,
    );
  }

  const channel = reader.readByte();
  if (channel !== Channel.OPS) {
    throw new ProtocolDecodeError(
      "UNSUPPORTED_CHANNEL",
      `channel ${channel} is not implemented — only OPS (${Channel.OPS}) exists as of Phase 7`,
    );
  }

  const messageType = reader.readByte();

  if (
    direction === "clientOrigin" &&
    (messageType === OpsMessageType.OP_ACK || messageType === OpsMessageType.OP_REJECT)
  ) {
    throw new ProtocolDecodeError(
      "MESSAGE_NOT_VALID_FROM_CLIENT",
      "OP_ACK/OP_REJECT are server→client only (§3.5.7/§3.5.8) and cannot be a client-origin frame",
    );
  }

  let msg: OpsMessage;
  switch (messageType) {
    case OpsMessageType.OP_INSERT:
      msg = decodeOpInsertPayload(reader, direction);
      break;
    case OpsMessageType.OP_INSERT_RUN:
      msg = decodeOpInsertRunPayload(reader, direction);
      break;
    case OpsMessageType.OP_DELETE:
      msg = decodeOpDeletePayload(reader, direction);
      break;
    case OpsMessageType.OP_DELETE_BATCH:
      msg = decodeOpDeleteBatchPayload(reader, direction);
      break;
    case OpsMessageType.OP_UNDELETE:
      msg = decodeOpUndeletePayload(reader, direction);
      break;
    case OpsMessageType.OP_ACK:
      msg = decodeOpAckPayload(reader);
      break;
    case OpsMessageType.OP_REJECT:
      msg = decodeOpRejectPayload(reader);
      break;
    default:
      throw new ProtocolDecodeError(
        "UNKNOWN_MESSAGE_TYPE",
        `${messageType} is not a known OPS message type`,
      );
  }

  if (!reader.atEnd()) {
    throw new ProtocolDecodeError(
      "TRAILING_BYTES",
      `frame has ${reader.remaining} unconsumed byte(s) after a valid ${msg.kind} payload`,
    );
  }
  return msg;
}

// --- debugProject ------------------------------------------------------------

function stampToDebug(id: Identifier | null): string | null {
  return id === null ? null : serializeId(id);
}

/**
 * Projects a raw frame to a JSON-serializable object for logging and test
 * failure messages (mandatory per this phase's scope) — every field
 * decoded, plus stamps rendered via the same `c:r` convention the engine
 * itself uses ({@link serializeId}) so a frame and an engine-side node can
 * be visually cross-referenced in a log line.
 *
 * Deliberately tolerant: if `decodeFrame` throws, this catches it and
 * returns a `{ malformed: true, reason, message }` object instead of
 * throwing itself — a log line or test-failure message must never itself
 * crash while trying to explain what went wrong.
 */
export function debugProject(bytes: Uint8Array): unknown {
  let msg: OpsMessage;
  try {
    msg = decodeFrame(bytes, { direction: "clientOrigin" });
  } catch (clientErr) {
    // Retry as a server-origin frame before giving up — debugProject is a
    // read-only diagnostic, not a validity check, and OP_ACK/OP_REJECT are
    // only ever legally server-origin.
    try {
      msg = decodeFrame(bytes, { direction: "serverOrigin" });
    } catch {
      const reason = clientErr instanceof ProtocolDecodeError ? clientErr.reason : "DECODE_ERROR";
      const message = clientErr instanceof Error ? clientErr.message : String(clientErr);
      return { malformed: true, byteLength: bytes.length, reason, message };
    }
  }

  switch (msg.kind) {
    case "opInsert":
      return {
        messageType: msg.kind,
        seq: msg.seq,
        id: stampToDebug(msg.id),
        originLeft: stampToDebug(msg.originLeft),
        originRight: stampToDebug(msg.originRight),
        bind: msg.bind,
        value: msg.value,
        char: String.fromCodePoint(msg.value),
      };
    case "opInsertRun":
      return {
        messageType: msg.kind,
        seq: msg.seq,
        firstId: stampToDebug(msg.firstId),
        originLeft: stampToDebug(msg.originLeft),
        originRight: stampToDebug(msg.originRight),
        bind: msg.bind,
        count: msg.values.length,
        text: String.fromCodePoint(...msg.values),
      };
    case "opDelete":
      return {
        messageType: msg.kind,
        seq: msg.seq,
        id: stampToDebug(msg.id),
        target: stampToDebug(msg.target),
      };
    case "opDeleteBatch":
      return {
        messageType: msg.kind,
        seq: msg.seq,
        by: msg.by,
        atFirst: msg.atFirst,
        count: msg.targets.length,
        targets: msg.targets.map(stampToDebug),
      };
    case "opUndelete":
      return {
        messageType: msg.kind,
        seq: msg.seq,
        id: stampToDebug(msg.id),
        target: stampToDebug(msg.target),
      };
    case "opAck":
      return {
        messageType: msg.kind,
        count: msg.acks.length,
        acks: msg.acks.map((a) => ({ ackSeq: a.ackSeq, ackedId: stampToDebug(a.ackedId) })),
      };
    case "opReject":
      return {
        messageType: msg.kind,
        count: msg.rejects.length,
        rejects: msg.rejects.map((r) => ({
          rejectedId: stampToDebug(r.rejectedId),
          reason: RejectReason[r.reason],
        })),
        detail: msg.detail,
      };
  }
}
