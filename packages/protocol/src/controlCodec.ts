import type { Identifier } from "@collab-editor/engine";
import { ByteReader, ByteWriter } from "./bytes.js";
import {
  CLIENT_CAP_ACCEPTS_OP_INSERT_RUN,
  CLIENT_CAP_ACCEPTS_STRUCTURE_SNAPSHOT,
  ControlMessageType,
  GoodbyeReason,
  isImplementedControlType,
  type ControlMessage,
  type GoodbyeMessage,
  type HelloMessage,
  type LeaveMessage,
  type ParticipantInfo,
  type PingMessage,
  type PongMessage,
  type SnapshotMessage,
  SnapshotForm,
  type SyncCompleteMessage,
  type WelcomeMessage,
  type ErrorMessage,
  SessionRole,
  SyncMode,
} from "./controlMessages.js";
import { Channel, PROTOCOL_VERSION } from "./messages.js";
import {
  decodeStamp,
  decodeString,
  decodeUuid,
  encodeStamp,
  encodeString,
  encodeUuid,
} from "./primitives.js";
import { ProtocolDecodeError } from "./errors.js";
import { readVarint, writeVarint } from "./varint.js";

export { CLIENT_CAP_ACCEPTS_OP_INSERT_RUN, CLIENT_CAP_ACCEPTS_STRUCTURE_SNAPSHOT };

export interface DecodeControlFrameOptions {
  readonly direction?: "clientOrigin" | "serverOrigin";
}

/** §3.6's own direction markers ("C→S" / "S→C") for each implemented type — enforced the same way Phase 7 enforces OP_ACK/OP_REJECT's directionality. */
const CLIENT_ORIGIN_TYPES: ReadonlySet<ControlMessageType> = new Set([
  ControlMessageType.HELLO,
  ControlMessageType.SYNC_COMPLETE,
  ControlMessageType.PING,
  ControlMessageType.LEAVE,
]);
const SERVER_ORIGIN_TYPES: ReadonlySet<ControlMessageType> = new Set([
  ControlMessageType.WELCOME,
  ControlMessageType.SNAPSHOT,
  ControlMessageType.PONG,
  ControlMessageType.GOODBYE,
  ControlMessageType.ERROR,
]);

function encodeHelloPayload(writer: ByteWriter, msg: HelloMessage): void {
  encodeUuid(writer, msg.documentId);
  writeVarint(writer, msg.ticket.length);
  writer.writeBytes(msg.ticket);
  writeVarint(writer, msg.lastServerSeq);
  writeVarint(writer, msg.unacked.length);
  for (const id of msg.unacked) {
    encodeStamp(writer, id);
  }
  writeVarint(writer, msg.clientCapabilities);
}

function decodeHelloPayload(reader: ByteReader): HelloMessage {
  const documentId = decodeUuid(reader);
  const ticketLength = readVarint(reader);
  const ticket = reader.readBytes(ticketLength);
  const lastServerSeq = readVarint(reader);
  const unackedCount = readVarint(reader);
  const unacked: Identifier[] = [];
  for (let i = 0; i < unackedCount; i++) {
    unacked.push(decodeStamp(reader));
  }
  const clientCapabilities = readVarint(reader);
  return { kind: "hello", documentId, ticket, lastServerSeq, unacked, clientCapabilities };
}

const KNOWN_ROLES: ReadonlySet<number> = new Set([
  SessionRole.VIEWER,
  SessionRole.EDITOR,
  SessionRole.OWNER,
]);
const KNOWN_SYNC_MODES: ReadonlySet<number> = new Set([
  SyncMode.SNAPSHOT,
  SyncMode.CATCHUP,
  SyncMode.ALREADY_CURRENT,
]);

function encodeWelcomePayload(writer: ByteWriter, msg: WelcomeMessage): void {
  encodeUuid(writer, msg.sessionId);
  writeVarint(writer, msg.replicaId);
  writer.writeByte(msg.role);
  writeVarint(writer, msg.serverSeq);
  writer.writeByte(msg.syncMode);
  writeVarint(writer, msg.participants.length);
  for (const p of msg.participants) {
    writeVarint(writer, p.replicaId);
    encodeUuid(writer, p.userId);
    encodeString(writer, p.displayName);
  }
}

function decodeWelcomePayload(reader: ByteReader): WelcomeMessage {
  const sessionId = decodeUuid(reader);
  const replicaId = readVarint(reader);
  const role = reader.readByte();
  if (!KNOWN_ROLES.has(role)) {
    throw new ProtocolDecodeError(
      "UNKNOWN_ROLE",
      `${role} is not one of the 3 defined SessionRole values`,
    );
  }
  const serverSeq = readVarint(reader);
  const syncMode = reader.readByte();
  if (!KNOWN_SYNC_MODES.has(syncMode)) {
    throw new ProtocolDecodeError(
      "UNKNOWN_SYNC_MODE",
      `${syncMode} is not one of the 3 defined SyncMode values`,
    );
  }
  const participantCount = readVarint(reader);
  const participants: ParticipantInfo[] = [];
  for (let i = 0; i < participantCount; i++) {
    const pReplicaId = readVarint(reader);
    const userId = decodeUuid(reader);
    const displayName = decodeString(reader);
    participants.push({ replicaId: pReplicaId, userId, displayName });
  }
  return {
    kind: "welcome",
    sessionId,
    replicaId,
    role: role as SessionRole,
    serverSeq,
    syncMode: syncMode as SyncMode,
    participants,
  };
}

const KNOWN_SNAPSHOT_FORMS: ReadonlySet<number> = new Set([
  SnapshotForm.PLAIN_TEXT,
  SnapshotForm.STRUCTURE,
]);

function encodeSnapshotPayload(writer: ByteWriter, msg: SnapshotMessage): void {
  writeVarint(writer, msg.seq);
  writer.writeByte(msg.form);
  writeVarint(writer, msg.body.length);
  writer.writeBytes(msg.body);
}

function decodeSnapshotPayload(reader: ByteReader): SnapshotMessage {
  const seq = readVarint(reader);
  const form = reader.readByte();
  if (!KNOWN_SNAPSHOT_FORMS.has(form)) {
    throw new ProtocolDecodeError(
      "UNKNOWN_SNAPSHOT_FORM",
      `${form} is not one of the 2 defined SnapshotForm values`,
    );
  }
  const byteLength = readVarint(reader);
  const body = reader.readBytes(byteLength);
  return { kind: "snapshot", seq, form: form as SnapshotForm, body: new Uint8Array(body) };
}

function encodeSyncCompletePayload(writer: ByteWriter, msg: SyncCompleteMessage): void {
  writeVarint(writer, msg.lastServerSeq);
  writeVarint(writer, msg.resentCount);
}

function decodeSyncCompletePayload(reader: ByteReader): SyncCompleteMessage {
  const lastServerSeq = readVarint(reader);
  const resentCount = readVarint(reader);
  return { kind: "syncComplete", lastServerSeq, resentCount };
}

function encodePingPayload(writer: ByteWriter, msg: PingMessage): void {
  writeVarint(writer, msg.clientTimeMs);
  writeVarint(writer, msg.lastAppliedSeq);
}

function decodePingPayload(reader: ByteReader): PingMessage {
  const clientTimeMs = readVarint(reader);
  const lastAppliedSeq = readVarint(reader);
  return { kind: "ping", clientTimeMs, lastAppliedSeq };
}

function encodePongPayload(writer: ByteWriter, msg: PongMessage): void {
  writeVarint(writer, msg.clientTimeMs);
  writeVarint(writer, msg.serverSeq);
}

function decodePongPayload(reader: ByteReader): PongMessage {
  const clientTimeMs = readVarint(reader);
  const serverSeq = readVarint(reader);
  return { kind: "pong", clientTimeMs, serverSeq };
}

function encodeLeavePayload(writer: ByteWriter, msg: LeaveMessage): void {
  writeVarint(writer, msg.lastAppliedSeq);
}

function decodeLeavePayload(reader: ByteReader): LeaveMessage {
  const lastAppliedSeq = readVarint(reader);
  return { kind: "leave", lastAppliedSeq };
}

const KNOWN_GOODBYE_REASONS: ReadonlySet<number> = new Set([
  GoodbyeReason.SHUTDOWN,
  GoodbyeReason.EVICTED,
  GoodbyeReason.PERMISSION_REVOKED,
  GoodbyeReason.PROTOCOL_VERSION_RETIRED,
]);

function encodeGoodbyePayload(writer: ByteWriter, msg: GoodbyeMessage): void {
  writer.writeByte(msg.reason);
  writeVarint(writer, msg.retryAfterMs);
}

function decodeGoodbyePayload(reader: ByteReader): GoodbyeMessage {
  const reason = reader.readByte();
  if (!KNOWN_GOODBYE_REASONS.has(reason)) {
    throw new ProtocolDecodeError(
      "UNKNOWN_GOODBYE_REASON",
      `${reason} is not one of the 4 defined GoodbyeReason values`,
    );
  }
  const retryAfterMs = readVarint(reader);
  return { kind: "goodbye", reason: reason as GoodbyeReason, retryAfterMs };
}

function encodeErrorPayload(writer: ByteWriter, msg: ErrorMessage): void {
  if (msg.code < 0 || msg.code > 0xff) {
    throw new RangeError(`encodeErrorPayload: code ${msg.code} does not fit in a uint8`);
  }
  writer.writeByte(msg.code);
  writer.writeByte(msg.fatal ? 1 : 0);
  encodeString(writer, msg.message);
}

function decodeErrorPayload(reader: ByteReader): ErrorMessage {
  const code = reader.readByte();
  const fatal = reader.readByte() !== 0;
  const message = decodeString(reader);
  return { kind: "error", code, fatal, message };
}

function messageTypeOf(msg: ControlMessage): ControlMessageType {
  switch (msg.kind) {
    case "hello":
      return ControlMessageType.HELLO;
    case "welcome":
      return ControlMessageType.WELCOME;
    case "snapshot":
      return ControlMessageType.SNAPSHOT;
    case "syncComplete":
      return ControlMessageType.SYNC_COMPLETE;
    case "ping":
      return ControlMessageType.PING;
    case "pong":
      return ControlMessageType.PONG;
    case "leave":
      return ControlMessageType.LEAVE;
    case "goodbye":
      return ControlMessageType.GOODBYE;
    case "error":
      return ControlMessageType.ERROR;
  }
}

/** Encodes one CONTROL message to a complete frame: the 3-byte envelope (§3.2) followed immediately by the message-specific payload — same shape as OPS framing (Phase 7), just `channel = CONTROL`. */
export function encodeControlFrame(msg: ControlMessage): Uint8Array {
  const writer = new ByteWriter();
  writer.writeByte(PROTOCOL_VERSION);
  writer.writeByte(Channel.CONTROL);
  writer.writeByte(messageTypeOf(msg));

  switch (msg.kind) {
    case "hello":
      encodeHelloPayload(writer, msg);
      break;
    case "welcome":
      encodeWelcomePayload(writer, msg);
      break;
    case "snapshot":
      encodeSnapshotPayload(writer, msg);
      break;
    case "syncComplete":
      encodeSyncCompletePayload(writer, msg);
      break;
    case "ping":
      encodePingPayload(writer, msg);
      break;
    case "pong":
      encodePongPayload(writer, msg);
      break;
    case "leave":
      encodeLeavePayload(writer, msg);
      break;
    case "goodbye":
      encodeGoodbyePayload(writer, msg);
      break;
    case "error":
      encodeErrorPayload(writer, msg);
      break;
  }

  return writer.toUint8Array();
}

/**
 * Decodes a complete CONTROL frame. Rejects with {@link ProtocolDecodeError}
 * for: an unsupported protocol version, a non-CONTROL channel byte, a
 * message type on the wrong side of its §3.6 C→S/S→C direction, a
 * reserved-but-unimplemented type (CATCHUP_BEGIN/CHUNK/END, ALREADY_HAVE,
 * PERMISSION_CHANGED — reason `UNIMPLEMENTED_MESSAGE_TYPE`), an
 * unrecognized type, or a frame that runs out of bytes mid-field / has
 * trailing bytes after a valid payload.
 */
export function decodeControlFrame(
  bytes: Uint8Array,
  opts: DecodeControlFrameOptions = {},
): ControlMessage {
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
  if (channel !== Channel.CONTROL) {
    throw new ProtocolDecodeError(
      "WRONG_CHANNEL",
      `expected CONTROL (${Channel.CONTROL}), got channel ${channel}`,
    );
  }

  const messageType = reader.readByte();

  if (!isImplementedControlType(messageType)) {
    throw new ProtocolDecodeError(
      "UNIMPLEMENTED_MESSAGE_TYPE",
      `CONTROL message type ${messageType} is reserved but not implemented until a later phase`,
    );
  }

  const expectFromClient = CLIENT_ORIGIN_TYPES.has(messageType);
  const expectFromServer = SERVER_ORIGIN_TYPES.has(messageType);
  if (direction === "clientOrigin" && expectFromServer) {
    throw new ProtocolDecodeError(
      "MESSAGE_NOT_VALID_FROM_CLIENT",
      `CONTROL message type ${messageType} is server→client only (§3.6)`,
    );
  }
  if (direction === "serverOrigin" && expectFromClient) {
    throw new ProtocolDecodeError(
      "MESSAGE_NOT_VALID_FROM_SERVER",
      `CONTROL message type ${messageType} is client→server only (§3.6)`,
    );
  }

  let msg: ControlMessage;
  switch (messageType) {
    case ControlMessageType.HELLO:
      msg = decodeHelloPayload(reader);
      break;
    case ControlMessageType.WELCOME:
      msg = decodeWelcomePayload(reader);
      break;
    case ControlMessageType.SNAPSHOT:
      msg = decodeSnapshotPayload(reader);
      break;
    case ControlMessageType.SYNC_COMPLETE:
      msg = decodeSyncCompletePayload(reader);
      break;
    case ControlMessageType.PING:
      msg = decodePingPayload(reader);
      break;
    case ControlMessageType.PONG:
      msg = decodePongPayload(reader);
      break;
    case ControlMessageType.LEAVE:
      msg = decodeLeavePayload(reader);
      break;
    case ControlMessageType.GOODBYE:
      msg = decodeGoodbyePayload(reader);
      break;
    case ControlMessageType.ERROR:
      msg = decodeErrorPayload(reader);
      break;
    default:
      // Unreachable: isImplementedControlType() above already filtered to exactly these 9 cases.
      throw new ProtocolDecodeError(
        "UNKNOWN_MESSAGE_TYPE",
        `${messageType} is not a known CONTROL message type`,
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
