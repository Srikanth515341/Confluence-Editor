import type { Identifier } from "@collab-editor/engine";
import { ByteReader, ByteWriter } from "./bytes.js";
import { ProtocolDecodeError } from "./errors.js";
import { readVarint, writeVarint } from "./varint.js";

/**
 * A stamp is the wire form of an OBSEQ identifier: (varint counter, varint
 * replica) — API Spec §3.1. There is no separate operation UUID anywhere in
 * this protocol; see messages.ts's top-of-file comment for the identity
 * decision this reflects (API Spec §1.4, Engine Spec I1).
 */
export function encodeStamp(writer: ByteWriter, id: Identifier): void {
  writeVarint(writer, id.c);
  writeVarint(writer, id.r);
}

export function decodeStamp(reader: ByteReader): Identifier {
  const c = readVarint(reader);
  const r = readVarint(reader);
  return { c, r };
}

/**
 * An insert's `parent` (Fugue port, 2026-09-05 — the retired `originLeft`/
 * `originRight` pair's single successor) is `null` (a document-root
 * attachment) about as often as it is a real identifier, so absence is
 * signaled by a presence bit in the message's flags byte (API Spec §1.4) —
 * a stamp is written/read only when the caller has already confirmed, via
 * that bit, that one is present. These two helpers exist so every call
 * site spells that out the same way rather than re-deriving the branch.
 */
export function encodeOptionalStamp(writer: ByteWriter, id: Identifier | null): void {
  if (id !== null) {
    encodeStamp(writer, id);
  }
}

export function decodeOptionalStamp(reader: ByteReader, present: boolean): Identifier | null {
  return present ? decodeStamp(reader) : null;
}

const textEncoder = new TextEncoder();
// ignoreBOM: true — see codec.ts's own textDecoder comment (same bug, same fix, found
// incidentally while building Phase 20's block-aware SNAPSHOT body encoder): without it, a
// string field whose first character legitimately IS U+FEFF gets silently corrupted on decode.
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** varint byte length + UTF-8 bytes (API Spec §3.1). */
export function encodeString(writer: ByteWriter, value: string): void {
  const utf8 = textEncoder.encode(value);
  writeVarint(writer, utf8.length);
  writer.writeBytes(utf8);
}

export function decodeString(reader: ByteReader): string {
  const length = readVarint(reader);
  const utf8 = reader.readBytes(length);
  try {
    return textDecoder.decode(utf8);
  } catch {
    throw new ProtocolDecodeError("INVALID_UTF8", "string field is not valid UTF-8");
  }
}

const UUID_PATTERN = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;

/** 16 raw bytes, not the 36-character text form (API Spec §3.1) — used by CONTROL/PRESENCE (Phases 9, 31), exercised here only at the primitive level. */
export function encodeUuid(writer: ByteWriter, uuid: string): void {
  const match = UUID_PATTERN.exec(uuid);
  if (!match) {
    throw new RangeError(`encodeUuid: "${uuid}" is not a canonical UUID string`);
  }
  const hex = match.slice(1).join("");
  for (let i = 0; i < 16; i++) {
    writer.writeByte(parseInt(hex.substring(i * 2, i * 2 + 2), 16));
  }
}

export function decodeUuid(reader: ByteReader): string {
  const bytes = reader.readBytes(16);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Valid Unicode scalar values exclude the surrogate range (Engine Spec §2.3
// — a Node carries one scalar value, never a lone surrogate half).
const SURROGATE_LOW = 0xd800;
const SURROGATE_HIGH = 0xdfff;
const MAX_SCALAR = 0x10ffff;

/** A single Unicode scalar value (a Node's `value`, Engine Spec §2.3), as a varint code point. */
export function encodeScalar(writer: ByteWriter, codePoint: number): void {
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > MAX_SCALAR ||
    (codePoint >= SURROGATE_LOW && codePoint <= SURROGATE_HIGH)
  ) {
    throw new RangeError(`encodeScalar: ${codePoint} is not a valid Unicode scalar value`);
  }
  writeVarint(writer, codePoint);
}

export function decodeScalar(reader: ByteReader): number {
  const codePoint = readVarint(reader);
  if (codePoint > MAX_SCALAR || (codePoint >= SURROGATE_LOW && codePoint <= SURROGATE_HIGH)) {
    throw new ProtocolDecodeError(
      "INVALID_SCALAR",
      `${codePoint} is not a valid Unicode scalar value`,
    );
  }
  return codePoint;
}
