import type { ByteReader, ByteWriter } from "./bytes.js";
import { ProtocolDecodeError } from "./errors.js";

/**
 * LEB128 unsigned varint (API Spec §3.1) — the primitive every other field
 * in this codec is built from: counters run into the tens of thousands
 * quickly (Lamport clock, API Spec §1.3's ~18-byte-insert measurement), so
 * a fixed-width integer would waste bytes on the common case, while a
 * varint stays 1 byte for small values (replica ids, short strings) and
 * grows only as needed.
 *
 * Deliberately implemented with division/modulo, never bitwise operators —
 * JS's `<<`/`>>>`/`|` coerce operands to signed 32-bit integers, which would
 * silently corrupt any value at or above 2^31. The DoD explicitly requires
 * round-tripping 2^31, so this is not a hypothetical concern.
 */
export function writeVarint(writer: ByteWriter, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`writeVarint: value must be a non-negative integer, got ${value}`);
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`writeVarint: value ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  let v = value;
  for (;;) {
    const low7 = v % 128;
    v = Math.floor(v / 128);
    if (v === 0) {
      writer.writeByte(low7);
      return;
    }
    writer.writeByte(low7 | 0x80);
  }
}

// A varint encoding more bytes than this could only be a corrupt/hostile
// frame — 10 groups of 7 bits covers every value up to Number.MAX_SAFE_INTEGER
// (2^53) with room to spare, so anything longer is rejected outright rather
// than read into an unbounded loop.
const MAX_VARINT_BYTES = 10;

export function readVarint(reader: ByteReader): number {
  let result = 0;
  let multiplier = 1;
  let bytesRead = 0;
  let byte: number;
  do {
    if (bytesRead >= MAX_VARINT_BYTES) {
      throw new ProtocolDecodeError(
        "VARINT_OVERFLOW",
        "varint exceeds the maximum encodable length",
      );
    }
    byte = reader.readByte();
    result += (byte & 0x7f) * multiplier;
    multiplier *= 128;
    bytesRead += 1;
  } while ((byte & 0x80) !== 0);
  if (result > Number.MAX_SAFE_INTEGER) {
    throw new ProtocolDecodeError(
      "VARINT_OVERFLOW",
      "decoded varint exceeds Number.MAX_SAFE_INTEGER",
    );
  }
  return result;
}
