import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ByteReader, ByteWriter } from "./bytes.js";
import { ProtocolDecodeError } from "./errors.js";
import { readVarint, writeVarint } from "./varint.js";

function roundTrip(value: number): number {
  const writer = new ByteWriter();
  writeVarint(writer, value);
  const reader = new ByteReader(writer.toUint8Array());
  return readVarint(reader);
}

describe("varint", () => {
  // API Spec §3.1's required boundary values: the LEB128 7-bit group
  // boundaries (127/128, 16383/16384) and the value the DoD explicitly
  // names, 2^31 — the point at which JS's 32-bit bitwise operators would
  // silently corrupt a naive implementation (see varint.ts's doc comment).
  it.each([
    0,
    1,
    127,
    128,
    16383,
    16384,
    2 ** 31,
    2 ** 31 - 1,
    2 ** 31 + 1,
    Number.MAX_SAFE_INTEGER,
  ])("round-trips %i", (value) => {
    expect(roundTrip(value)).toBe(value);
  });

  it("round-trips 10,000 generated non-negative integers", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (value) => roundTrip(value) === value,
      ),
      { numRuns: 10_000 },
    );
  });

  it("uses exactly 1 byte for 0 and for 127 (the 7-bit boundary)", () => {
    const w0 = new ByteWriter();
    writeVarint(w0, 0);
    expect(w0.toUint8Array()).toEqual(Uint8Array.of(0));

    const w127 = new ByteWriter();
    writeVarint(w127, 127);
    expect(w127.toUint8Array()).toEqual(Uint8Array.of(127));
  });

  it("uses exactly 2 bytes starting at 128", () => {
    const w = new ByteWriter();
    writeVarint(w, 128);
    expect(w.toUint8Array().length).toBe(2);
  });

  it("rejects negative values at encode time", () => {
    expect(() => writeVarint(new ByteWriter(), -1)).toThrow(RangeError);
  });

  it("rejects non-integer values at encode time", () => {
    expect(() => writeVarint(new ByteWriter(), 1.5)).toThrow(RangeError);
  });

  it("rejects a varint with more than 10 continuation-flagged bytes as VARINT_OVERFLOW, not a crash", () => {
    const malformed = new Uint8Array(12).fill(0x80); // every byte says "more follows"
    const reader = new ByteReader(malformed);
    expect(() => readVarint(reader)).toThrow(ProtocolDecodeError);
    try {
      readVarint(new ByteReader(malformed));
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolDecodeError);
      expect((err as ProtocolDecodeError).reason).toBe("VARINT_OVERFLOW");
    }
  });

  it("rejects a truncated varint (buffer ends mid-continuation) with a specific error, not a crash", () => {
    const truncated = Uint8Array.of(0x80); // says "more follows" but nothing does
    const reader = new ByteReader(truncated);
    expect(() => readVarint(reader)).toThrow(ProtocolDecodeError);
  });
});
