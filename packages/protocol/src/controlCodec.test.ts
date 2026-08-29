import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ControlMessageType,
  GoodbyeReason,
  SessionRole,
  SnapshotForm,
  SyncMode,
  type ControlMessage,
} from "./controlMessages.js";
import { decodeControlFrame, encodeControlFrame } from "./controlCodec.js";
import { ProtocolDecodeError } from "./errors.js";
import { Channel, PROTOCOL_VERSION } from "./messages.js";
import { ByteWriter } from "./bytes.js";
import { writeVarint } from "./varint.js";

const idArb = fc.record({ c: fc.nat({ max: 5_000_000 }), r: fc.nat({ max: 500 }) });
const uuidArb = fc.uuid();
const bytesArb = fc.uint8Array({ maxLength: 40 });

const helloArb: fc.Arbitrary<ControlMessage> = fc.record({
  kind: fc.constant("hello" as const),
  documentId: uuidArb,
  ticket: bytesArb,
  lastServerSeq: fc.nat({ max: 5_000_000 }),
  unacked: fc.array(idArb, { maxLength: 10 }),
  clientCapabilities: fc.nat({ max: 0xff }),
});

const participantArb = fc.record({
  replicaId: fc.nat({ max: 500 }),
  userId: uuidArb,
  displayName: fc.string({ maxLength: 20 }),
});

const welcomeArb: fc.Arbitrary<ControlMessage> = fc.record({
  kind: fc.constant("welcome" as const),
  sessionId: uuidArb,
  replicaId: fc.nat({ max: 500 }),
  role: fc.constantFrom(SessionRole.VIEWER, SessionRole.EDITOR, SessionRole.OWNER),
  serverSeq: fc.nat({ max: 5_000_000 }),
  syncMode: fc.constantFrom(SyncMode.SNAPSHOT, SyncMode.CATCHUP, SyncMode.ALREADY_CURRENT),
  participants: fc.array(participantArb, { maxLength: 10 }),
});

const snapshotArb: fc.Arbitrary<ControlMessage> = fc.record({
  kind: fc.constant("snapshot" as const),
  seq: fc.nat({ max: 5_000_000 }),
  form: fc.constantFrom(SnapshotForm.PLAIN_TEXT, SnapshotForm.STRUCTURE),
  body: bytesArb,
});

const syncCompleteArb: fc.Arbitrary<ControlMessage> = fc.record({
  kind: fc.constant("syncComplete" as const),
  lastServerSeq: fc.nat({ max: 5_000_000 }),
  resentCount: fc.nat({ max: 5_000_000 }),
});

const pingArb: fc.Arbitrary<ControlMessage> = fc.record({
  kind: fc.constant("ping" as const),
  clientTimeMs: fc.nat({ max: Number.MAX_SAFE_INTEGER }),
  lastAppliedSeq: fc.nat({ max: 5_000_000 }),
});

const pongArb: fc.Arbitrary<ControlMessage> = fc.record({
  kind: fc.constant("pong" as const),
  clientTimeMs: fc.nat({ max: Number.MAX_SAFE_INTEGER }),
  serverSeq: fc.nat({ max: 5_000_000 }),
});

const leaveArb: fc.Arbitrary<ControlMessage> = fc.record({
  kind: fc.constant("leave" as const),
  lastAppliedSeq: fc.nat({ max: 5_000_000 }),
});

const goodbyeArb: fc.Arbitrary<ControlMessage> = fc.record({
  kind: fc.constant("goodbye" as const),
  reason: fc.constantFrom(
    GoodbyeReason.SHUTDOWN,
    GoodbyeReason.EVICTED,
    GoodbyeReason.PERMISSION_REVOKED,
    GoodbyeReason.PROTOCOL_VERSION_RETIRED,
  ),
  retryAfterMs: fc.nat({ max: 5_000_000 }),
});

const errorArb: fc.Arbitrary<ControlMessage> = fc.record({
  kind: fc.constant("error" as const),
  code: fc.nat({ max: 0xff }),
  fatal: fc.boolean(),
  message: fc.string({ maxLength: 60 }),
});

const clientOriginArb = fc.oneof(helloArb, syncCompleteArb, pingArb, leaveArb);
const serverOriginArb = fc.oneof(welcomeArb, snapshotArb, pongArb, goodbyeArb, errorArb);

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
function sameMessage(a: ControlMessage, b: ControlMessage): boolean {
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

describe("CONTROL codec — round-trip (API Spec §3.6)", () => {
  it("decode(encode(msg)) === msg for 5,000 generated client-origin messages (HELLO/SYNC_COMPLETE/PING/LEAVE)", () => {
    fc.assert(
      fc.property(clientOriginArb, (msg) =>
        sameMessage(
          decodeControlFrame(encodeControlFrame(msg), { direction: "clientOrigin" }),
          msg,
        ),
      ),
      { numRuns: 5_000 },
    );
  });

  it("decode(encode(msg)) === msg for 5,000 generated server-origin messages (WELCOME/SNAPSHOT/PONG/GOODBYE/ERROR)", () => {
    fc.assert(
      fc.property(serverOriginArb, (msg) =>
        sameMessage(
          decodeControlFrame(encodeControlFrame(msg), { direction: "serverOrigin" }),
          msg,
        ),
      ),
      { numRuns: 5_000 },
    );
  });
});

describe("CONTROL codec — envelope and type numbers (§3.2, §3.6)", () => {
  it("uses channel = CONTROL (0x03), matching Phase 8's Channel enum", () => {
    const bytes = encodeControlFrame({ kind: "ping", clientTimeMs: 1, lastAppliedSeq: 0 });
    expect(bytes[0]).toBe(PROTOCOL_VERSION);
    expect(bytes[1]).toBe(Channel.CONTROL);
    expect(bytes[1]).toBe(0x03);
  });

  it("uses the exact spec-mandated CONTROL message type numbers", () => {
    expect(ControlMessageType.HELLO).toBe(0x01);
    expect(ControlMessageType.WELCOME).toBe(0x02);
    expect(ControlMessageType.SNAPSHOT).toBe(0x03);
    expect(ControlMessageType.CATCHUP_BEGIN).toBe(0x04);
    expect(ControlMessageType.CATCHUP_CHUNK).toBe(0x05);
    expect(ControlMessageType.CATCHUP_END).toBe(0x06);
    expect(ControlMessageType.ALREADY_HAVE).toBe(0x07);
    expect(ControlMessageType.SYNC_COMPLETE).toBe(0x08);
    expect(ControlMessageType.PERMISSION_CHANGED).toBe(0x09);
    expect(ControlMessageType.ERROR).toBe(0x0a);
    expect(ControlMessageType.PING).toBe(0x0b);
    expect(ControlMessageType.PONG).toBe(0x0c);
    expect(ControlMessageType.LEAVE).toBe(0x0d);
    expect(ControlMessageType.GOODBYE).toBe(0x0e);
  });

  it("uses the exact spec-mandated GOODBYE reason values", () => {
    expect(GoodbyeReason.SHUTDOWN).toBe(0);
    expect(GoodbyeReason.EVICTED).toBe(1);
    expect(GoodbyeReason.PERMISSION_REVOKED).toBe(2);
    expect(GoodbyeReason.PROTOCOL_VERSION_RETIRED).toBe(3);
  });
});

describe("CONTROL codec — directionality (§3.6's C→S / S→C markers)", () => {
  it("rejects a client-origin decode of a server-only message (WELCOME)", () => {
    const bytes = encodeControlFrame({
      kind: "welcome",
      sessionId: randomUUID(),
      replicaId: 1,
      role: SessionRole.EDITOR,
      serverSeq: 0,
      syncMode: SyncMode.SNAPSHOT,
      participants: [],
    });
    expect(() => decodeControlFrame(bytes, { direction: "clientOrigin" })).toThrow(
      ProtocolDecodeError,
    );
    try {
      decodeControlFrame(bytes, { direction: "clientOrigin" });
      expect.unreachable();
    } catch (err) {
      expect((err as ProtocolDecodeError).reason).toBe("MESSAGE_NOT_VALID_FROM_CLIENT");
    }
  });

  it("rejects a server-origin decode of a client-only message (HELLO)", () => {
    const bytes = encodeControlFrame({
      kind: "hello",
      documentId: randomUUID(),
      ticket: new Uint8Array(),
      lastServerSeq: 0,
      unacked: [],
      clientCapabilities: 0,
    });
    expect(() => decodeControlFrame(bytes, { direction: "serverOrigin" })).toThrow(
      ProtocolDecodeError,
    );
    try {
      decodeControlFrame(bytes, { direction: "serverOrigin" });
      expect.unreachable();
    } catch (err) {
      expect((err as ProtocolDecodeError).reason).toBe("MESSAGE_NOT_VALID_FROM_SERVER");
    }
  });

  it("rejects a reserved-but-unimplemented type (CATCHUP_BEGIN) with a specific error, not a crash", () => {
    const writer = new ByteWriter();
    writer.writeByte(PROTOCOL_VERSION);
    writer.writeByte(Channel.CONTROL);
    writer.writeByte(ControlMessageType.CATCHUP_BEGIN);
    const bytes = writer.toUint8Array();
    expect(() => decodeControlFrame(bytes)).toThrow(ProtocolDecodeError);
    try {
      decodeControlFrame(bytes);
      expect.unreachable();
    } catch (err) {
      expect((err as ProtocolDecodeError).reason).toBe("UNIMPLEMENTED_MESSAGE_TYPE");
    }
  });

  it("rejects a frame declaring the wrong channel", () => {
    const bytes = new Uint8Array([PROTOCOL_VERSION, Channel.OPS, ControlMessageType.PING]);
    expect(() => decodeControlFrame(bytes)).toThrow(ProtocolDecodeError);
  });
});

describe("CONTROL codec — malformed frame rejection", () => {
  it("rejects an unknown GOODBYE reason", () => {
    const writer = new ByteWriter();
    writer.writeByte(PROTOCOL_VERSION);
    writer.writeByte(Channel.CONTROL);
    writer.writeByte(ControlMessageType.GOODBYE);
    writer.writeByte(0x99);
    writeVarint(writer, 0);
    expect(() => decodeControlFrame(writer.toUint8Array(), { direction: "serverOrigin" })).toThrow(
      ProtocolDecodeError,
    );
  });

  it("rejects a truncated frame with a specific error, not a crash", () => {
    const truncated = new Uint8Array([PROTOCOL_VERSION, Channel.CONTROL, ControlMessageType.HELLO]);
    expect(() => decodeControlFrame(truncated)).toThrow(ProtocolDecodeError);
  });
});
