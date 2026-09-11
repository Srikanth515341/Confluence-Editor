import type { Identifier } from "@collab-editor/engine";
import { ByteReader, ByteWriter } from "./bytes.js";
import { ProtocolDecodeError } from "./errors.js";
import { Channel, PROTOCOL_VERSION } from "./messages.js";
import {
  decodeOptionalStamp,
  decodeString,
  decodeUuid,
  encodeOptionalStamp,
  encodeString,
  encodeUuid,
} from "./primitives.js";
import { SessionRole } from "./controlMessages.js";
import {
  PresenceLeaveReason,
  PresenceMessageType,
  type PresenceJoinMessage,
  type PresenceLeaveMessage,
  type PresenceMessage,
  type PresenceRosterEntry,
  type PresenceRosterMessage,
  type PresenceUpdateMessage,
} from "./presenceMessages.js";
import { readVarint, writeVarint } from "./varint.js";

export interface EncodePresenceFrameOptions {
  /**
   * Only meaningful for `presenceUpdate` (API Spec §3.8's own "omitted C→S,
   * present S→C" field) — every other message kind here is unconditionally
   * server-only regardless of this option. Defaults to `"serverOrigin"`,
   * matching the common case (a server rebroadcasting an update it just
   * received, or constructing JOIN/LEAVE/ROSTER, all of which are
   * server-only anyway) — a client sending its OWN update must pass
   * `{ direction: "clientOrigin" }` explicitly so `replicaId` is genuinely
   * omitted from the wire, not merely zero-valued.
   */
  readonly direction?: "clientOrigin" | "serverOrigin";
}

export interface DecodePresenceFrameOptions {
  readonly direction?: "clientOrigin" | "serverOrigin";
}

/** §3.8's own direction markers for each message type — PRESENCE_JOIN/LEAVE/ROSTER are S→C only; PRESENCE_UPDATE is bidirectional. */
const SERVER_ONLY_TYPES: ReadonlySet<PresenceMessageType> = new Set([
  PresenceMessageType.PRESENCE_JOIN,
  PresenceMessageType.PRESENCE_LEAVE,
  PresenceMessageType.PRESENCE_ROSTER,
]);

const FLAG_ANCHOR_PRESENT = 0x01;
const FLAG_FOCUS_PRESENT = 0x02;
const FLAG_COLLAPSED = 0x04;
const KNOWN_FLAG_BITS = FLAG_ANCHOR_PRESENT | FLAG_FOCUS_PRESENT | FLAG_COLLAPSED;

function encodePresenceUpdatePayload(
  writer: ByteWriter,
  msg: PresenceUpdateMessage,
  direction: "clientOrigin" | "serverOrigin",
): void {
  // §3.8's own field order: replicaId (when present), THEN the flags byte, THEN the optional
  // identifiers — NOT flags-first. Matched literally here since this is a wire layout, not a
  // convention this project gets to choose.
  if (direction === "serverOrigin") {
    writeVarint(writer, msg.replicaId);
  }
  const flags =
    (msg.anchor !== null ? FLAG_ANCHOR_PRESENT : 0) |
    (msg.focus !== null ? FLAG_FOCUS_PRESENT : 0) |
    (msg.collapsed ? FLAG_COLLAPSED : 0);
  writer.writeByte(flags);
  encodeOptionalStamp(writer, msg.anchor);
  encodeOptionalStamp(writer, msg.focus);
}

function decodePresenceUpdatePayload(
  reader: ByteReader,
  direction: "clientOrigin" | "serverOrigin",
): PresenceUpdateMessage {
  const replicaId = direction === "serverOrigin" ? readVarint(reader) : 0;
  const flags = reader.readByte();
  if ((flags & ~KNOWN_FLAG_BITS) !== 0) {
    throw new ProtocolDecodeError(
      "RESERVED_BIT_SET",
      `presenceUpdate flags byte ${flags} sets a reserved bit`,
    );
  }
  const anchor: Identifier | null = decodeOptionalStamp(reader, (flags & FLAG_ANCHOR_PRESENT) !== 0);
  const focus: Identifier | null = decodeOptionalStamp(reader, (flags & FLAG_FOCUS_PRESENT) !== 0);
  const collapsed = (flags & FLAG_COLLAPSED) !== 0;
  return { kind: "presenceUpdate", replicaId, anchor, focus, collapsed };
}

const KNOWN_ROLES: ReadonlySet<number> = new Set([SessionRole.VIEWER, SessionRole.EDITOR, SessionRole.OWNER]);

function encodePresenceJoinPayload(writer: ByteWriter, msg: PresenceJoinMessage): void {
  writeVarint(writer, msg.replicaId);
  encodeUuid(writer, msg.userId);
  encodeString(writer, msg.displayName);
  writer.writeByte(msg.role);
}

function decodePresenceJoinPayload(reader: ByteReader): PresenceJoinMessage {
  const replicaId = readVarint(reader);
  const userId = decodeUuid(reader);
  const displayName = decodeString(reader);
  const role = reader.readByte();
  if (!KNOWN_ROLES.has(role)) {
    throw new ProtocolDecodeError("UNKNOWN_ROLE", `${role} is not one of the 3 defined SessionRole values`);
  }
  return { kind: "presenceJoin", replicaId, userId, displayName, role: role as SessionRole };
}

const KNOWN_LEAVE_REASONS: ReadonlySet<number> = new Set([
  PresenceLeaveReason.CLEAN,
  PresenceLeaveReason.STALE,
]);

function encodePresenceLeavePayload(writer: ByteWriter, msg: PresenceLeaveMessage): void {
  writeVarint(writer, msg.replicaId);
  writer.writeByte(msg.reason);
}

function decodePresenceLeavePayload(reader: ByteReader): PresenceLeaveMessage {
  const replicaId = readVarint(reader);
  const reason = reader.readByte();
  if (!KNOWN_LEAVE_REASONS.has(reason)) {
    throw new ProtocolDecodeError(
      "UNKNOWN_PRESENCE_LEAVE_REASON",
      `${reason} is not one of the 2 defined PresenceLeaveReason values`,
    );
  }
  return { kind: "presenceLeave", replicaId, reason: reason as PresenceLeaveReason };
}

function encodePresenceRosterPayload(writer: ByteWriter, msg: PresenceRosterMessage): void {
  writeVarint(writer, msg.participants.length);
  for (const p of msg.participants) {
    writeVarint(writer, p.replicaId);
    encodeUuid(writer, p.userId);
    encodeString(writer, p.displayName);
    writer.writeByte(p.role);
  }
}

function decodePresenceRosterPayload(reader: ByteReader): PresenceRosterMessage {
  const count = readVarint(reader);
  const participants: PresenceRosterEntry[] = [];
  for (let i = 0; i < count; i++) {
    const replicaId = readVarint(reader);
    const userId = decodeUuid(reader);
    const displayName = decodeString(reader);
    const role = reader.readByte();
    if (!KNOWN_ROLES.has(role)) {
      throw new ProtocolDecodeError("UNKNOWN_ROLE", `${role} is not one of the 3 defined SessionRole values`);
    }
    participants.push({ replicaId, userId, displayName, role: role as SessionRole });
  }
  return { kind: "presenceRoster", participants };
}

function messageTypeOf(msg: PresenceMessage): PresenceMessageType {
  switch (msg.kind) {
    case "presenceUpdate":
      return PresenceMessageType.PRESENCE_UPDATE;
    case "presenceJoin":
      return PresenceMessageType.PRESENCE_JOIN;
    case "presenceLeave":
      return PresenceMessageType.PRESENCE_LEAVE;
    case "presenceRoster":
      return PresenceMessageType.PRESENCE_ROSTER;
  }
}

/** Encodes one PRESENCE message to a complete frame: the 3-byte envelope (§3.2) — `channel = PRESENCE` — followed by the message-specific payload, same shape as OPS/CONTROL framing. */
export function encodePresenceFrame(msg: PresenceMessage, opts: EncodePresenceFrameOptions = {}): Uint8Array {
  const direction = opts.direction ?? "serverOrigin";
  const writer = new ByteWriter();
  writer.writeByte(PROTOCOL_VERSION);
  writer.writeByte(Channel.PRESENCE);
  writer.writeByte(messageTypeOf(msg));

  switch (msg.kind) {
    case "presenceUpdate":
      encodePresenceUpdatePayload(writer, msg, direction);
      break;
    case "presenceJoin":
      encodePresenceJoinPayload(writer, msg);
      break;
    case "presenceLeave":
      encodePresenceLeavePayload(writer, msg);
      break;
    case "presenceRoster":
      encodePresenceRosterPayload(writer, msg);
      break;
  }

  return writer.toUint8Array();
}

/**
 * Decodes a complete PRESENCE frame. Rejects with {@link ProtocolDecodeError}
 * for: an unsupported protocol version, a non-PRESENCE channel byte, a
 * server-only message type (JOIN/LEAVE/ROSTER) arriving with
 * `direction: "clientOrigin"`, an unrecognized message type, a reserved bit
 * set in `presenceUpdate`'s flags byte, an unrecognized role/reason byte, or
 * a frame that runs out of bytes mid-field / has trailing bytes after a
 * valid payload — the same malformed-frame discipline established for OPS
 * (Phase 7) and CONTROL (Phase 9).
 */
export function decodePresenceFrame(
  bytes: Uint8Array,
  opts: DecodePresenceFrameOptions = {},
): PresenceMessage {
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
  if (channel !== Channel.PRESENCE) {
    throw new ProtocolDecodeError("WRONG_CHANNEL", `expected PRESENCE (${Channel.PRESENCE}), got channel ${channel}`);
  }

  const messageType = reader.readByte();
  if (
    messageType !== PresenceMessageType.PRESENCE_UPDATE &&
    messageType !== PresenceMessageType.PRESENCE_JOIN &&
    messageType !== PresenceMessageType.PRESENCE_LEAVE &&
    messageType !== PresenceMessageType.PRESENCE_ROSTER
  ) {
    throw new ProtocolDecodeError("UNKNOWN_MESSAGE_TYPE", `${messageType} is not a known PRESENCE message type`);
  }

  if (direction === "clientOrigin" && SERVER_ONLY_TYPES.has(messageType)) {
    throw new ProtocolDecodeError(
      "MESSAGE_NOT_VALID_FROM_CLIENT",
      `PRESENCE message type ${messageType} is server→client only (§3.8)`,
    );
  }

  let msg: PresenceMessage;
  switch (messageType) {
    case PresenceMessageType.PRESENCE_UPDATE:
      msg = decodePresenceUpdatePayload(reader, direction);
      break;
    case PresenceMessageType.PRESENCE_JOIN:
      msg = decodePresenceJoinPayload(reader);
      break;
    case PresenceMessageType.PRESENCE_LEAVE:
      msg = decodePresenceLeavePayload(reader);
      break;
    case PresenceMessageType.PRESENCE_ROSTER:
      msg = decodePresenceRosterPayload(reader);
      break;
  }

  if (!reader.atEnd()) {
    throw new ProtocolDecodeError(
      "TRAILING_BYTES",
      `frame has ${reader.remaining} unconsumed byte(s) after a valid ${msg.kind} payload`,
    );
  }
  return msg;
}
