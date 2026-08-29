import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Identifier } from "@collab-editor/engine";
import { ByteReader, ByteWriter } from "./bytes.js";
import {
  decodeScalar,
  decodeStamp,
  decodeString,
  decodeUuid,
  encodeScalar,
  encodeStamp,
  encodeString,
  encodeUuid,
} from "./primitives.js";

describe("primitives — stamp (API Spec §3.1)", () => {
  it("round-trips 10,000 generated identifiers", () => {
    fc.assert(
      fc.property(
        fc.record({ c: fc.nat({ max: Number.MAX_SAFE_INTEGER }), r: fc.nat({ max: 1_000_000 }) }),
        (id: Identifier) => {
          const writer = new ByteWriter();
          encodeStamp(writer, id);
          const decoded = decodeStamp(new ByteReader(writer.toUint8Array()));
          return decoded.c === id.c && decoded.r === id.r;
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

describe("primitives — string", () => {
  it("round-trips arbitrary Unicode strings, including empty and multi-byte", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const writer = new ByteWriter();
        encodeString(writer, s);
        return decodeString(new ByteReader(writer.toUint8Array())) === s;
      }),
      { numRuns: 2_000 },
    );
  });
});

describe("primitives — uuid", () => {
  it("round-trips a canonical UUID string to 16 raw bytes and back", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const writer = new ByteWriter();
    encodeUuid(writer, uuid);
    expect(writer.toUint8Array().length).toBe(16);
    expect(decodeUuid(new ByteReader(writer.toUint8Array()))).toBe(uuid.toLowerCase());
  });

  it("rejects a malformed UUID string at encode time", () => {
    expect(() => encodeUuid(new ByteWriter(), "not-a-uuid")).toThrow(RangeError);
  });
});

describe("primitives — scalar (Engine Spec §2.3)", () => {
  it("round-trips every ASCII printable character and a sample of astral code points", () => {
    const codePoints = [0x41, 0x7a, 0x00, 0x7f, 0x1f600 /* emoji */, 0x10ffff];
    for (const cp of codePoints) {
      const writer = new ByteWriter();
      encodeScalar(writer, cp);
      expect(decodeScalar(new ByteReader(writer.toUint8Array()))).toBe(cp);
    }
  });

  it("rejects a lone surrogate half at encode time", () => {
    expect(() => encodeScalar(new ByteWriter(), 0xd800)).toThrow(RangeError);
  });

  it("rejects a code point above U+10FFFF at encode time", () => {
    expect(() => encodeScalar(new ByteWriter(), 0x110000)).toThrow(RangeError);
  });
});
