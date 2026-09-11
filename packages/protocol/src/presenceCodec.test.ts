import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ByteWriter } from "./bytes.js";
import { Channel, PROTOCOL_VERSION } from "./messages.js";
import { decodePresenceFrame, encodePresenceFrame } from "./presenceCodec.js";
import { PresenceLeaveReason, PresenceMessageType, type PresenceMessage } from "./presenceMessages.js";
import { SessionRole } from "./controlMessages.js";
import { ProtocolDecodeError } from "./errors.js";
import { writeVarint } from "./varint.js";

const idArb = fc.record({ c: fc.nat({ max: 5_000_000 }), r: fc.nat({ max: 500 }) });
const uuidArb = fc.uuid();
const roleArb = fc.constantFrom(SessionRole.VIEWER, SessionRole.EDITOR, SessionRole.OWNER);

const presenceUpdateArb: fc.Arbitrary<PresenceMessage> = fc.record({
  kind: fc.constant("presenceUpdate" as const),
  replicaId: fc.nat({ max: 500 }),
  anchor: fc.option(idArb, { nil: null }),
  focus: fc.option(idArb, { nil: null }),
  collapsed: fc.boolean(),
});

const presenceJoinArb: fc.Arbitrary<PresenceMessage> = fc.record({
  kind: fc.constant("presenceJoin" as const),
  replicaId: fc.nat({ max: 500 }),
  userId: uuidArb,
  displayName: fc.string({ maxLength: 20 }),
  role: roleArb,
});

const presenceLeaveArb: fc.Arbitrary<PresenceMessage> = fc.record({
  kind: fc.constant("presenceLeave" as const),
  replicaId: fc.nat({ max: 500 }),
  reason: fc.constantFrom(PresenceLeaveReason.CLEAN, PresenceLeaveReason.STALE),
});

const rosterEntryArb = fc.record({
  replicaId: fc.nat({ max: 500 }),
  userId: uuidArb,
  displayName: fc.string({ maxLength: 20 }),
  role: roleArb,
});

const presenceRosterArb: fc.Arbitrary<PresenceMessage> = fc.record({
  kind: fc.constant("presenceRoster" as const),
  participants: fc.array(rosterEntryArb, { maxLength: 10 }),
});

describe("presenceCodec — round trip (2,000 cases each)", () => {
  it("presenceUpdate: server→client (replicaId present on the wire)", () => {
    fc.assert(
      fc.property(presenceUpdateArb, (msg) => {
        const bytes = encodePresenceFrame(msg, { direction: "serverOrigin" });
        const decoded = decodePresenceFrame(bytes, { direction: "serverOrigin" });
        expect(decoded).toEqual(msg);
      }),
      { numRuns: 2000 },
    );
  });

  it("presenceUpdate: client→server (replicaId omitted from the wire, decodes as 0)", () => {
    fc.assert(
      fc.property(presenceUpdateArb, (msg) => {
        const sent = { ...msg, replicaId: 0 } as PresenceMessage; // client never populates replicaId
        const bytes = encodePresenceFrame(sent, { direction: "clientOrigin" });
        const decoded = decodePresenceFrame(bytes, { direction: "clientOrigin" });
        expect(decoded).toEqual(sent);
      }),
      { numRuns: 2000 },
    );
  });

  it("presenceJoin", () => {
    fc.assert(
      fc.property(presenceJoinArb, (msg) => {
        const bytes = encodePresenceFrame(msg);
        expect(decodePresenceFrame(bytes, { direction: "serverOrigin" })).toEqual(msg);
      }),
      { numRuns: 2000 },
    );
  });

  it("presenceLeave", () => {
    fc.assert(
      fc.property(presenceLeaveArb, (msg) => {
        const bytes = encodePresenceFrame(msg);
        expect(decodePresenceFrame(bytes, { direction: "serverOrigin" })).toEqual(msg);
      }),
      { numRuns: 2000 },
    );
  });

  it("presenceRoster", () => {
    fc.assert(
      fc.property(presenceRosterArb, (msg) => {
        const bytes = encodePresenceFrame(msg);
        expect(decodePresenceFrame(bytes, { direction: "serverOrigin" })).toEqual(msg);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("presenceCodec — envelope and directionality", () => {
  it("stamps the PRESENCE channel byte (0x02), distinct from OPS/CONTROL", () => {
    const bytes = encodePresenceFrame({
      kind: "presenceLeave",
      replicaId: 1,
      reason: PresenceLeaveReason.CLEAN,
    });
    expect(bytes[0]).toBe(PROTOCOL_VERSION);
    expect(bytes[1]).toBe(Channel.PRESENCE);
    expect(bytes[2]).toBe(PresenceMessageType.PRESENCE_LEAVE);
  });

  it("rejects PRESENCE_JOIN arriving with clientOrigin direction — server-only (§3.8)", () => {
    const bytes = encodePresenceFrame({
      kind: "presenceJoin",
      replicaId: 1,
      userId: "11111111-1111-1111-1111-111111111111",
      displayName: "A",
      role: SessionRole.EDITOR,
    });
    expect(() => decodePresenceFrame(bytes, { direction: "clientOrigin" })).toThrow(ProtocolDecodeError);
  });

  it("rejects PRESENCE_LEAVE arriving with clientOrigin direction — server-only (§3.8)", () => {
    const bytes = encodePresenceFrame({ kind: "presenceLeave", replicaId: 1, reason: PresenceLeaveReason.STALE });
    expect(() => decodePresenceFrame(bytes, { direction: "clientOrigin" })).toThrow(ProtocolDecodeError);
  });

  it("rejects PRESENCE_ROSTER arriving with clientOrigin direction — server-only (§3.8)", () => {
    const bytes = encodePresenceFrame({ kind: "presenceRoster", participants: [] });
    expect(() => decodePresenceFrame(bytes, { direction: "clientOrigin" })).toThrow(ProtocolDecodeError);
  });

  it("accepts PRESENCE_UPDATE from either direction", () => {
    const clientBytes = encodePresenceFrame(
      { kind: "presenceUpdate", replicaId: 0, anchor: null, focus: null, collapsed: true },
      { direction: "clientOrigin" },
    );
    expect(decodePresenceFrame(clientBytes, { direction: "clientOrigin" }).kind).toBe("presenceUpdate");
    const serverBytes = encodePresenceFrame(
      { kind: "presenceUpdate", replicaId: 7, anchor: null, focus: null, collapsed: true },
      { direction: "serverOrigin" },
    );
    expect(decodePresenceFrame(serverBytes, { direction: "serverOrigin" }).kind).toBe("presenceUpdate");
  });

  it("client-sent presenceUpdate never carries a replicaId byte on the wire (genuinely omitted, not zero-valued)", () => {
    const withReplica = encodePresenceFrame(
      { kind: "presenceUpdate", replicaId: 0, anchor: null, focus: null, collapsed: false },
      { direction: "clientOrigin" },
    );
    const withReplicaServer = encodePresenceFrame(
      { kind: "presenceUpdate", replicaId: 0, anchor: null, focus: null, collapsed: false },
      { direction: "serverOrigin" },
    );
    // serverOrigin encodes one extra varint byte (replicaId=0) that clientOrigin omits entirely.
    expect(withReplicaServer.length).toBe(withReplica.length + 1);
  });

  it("rejects a reserved bit set in presenceUpdate's flags byte", () => {
    const writer = new ByteWriter();
    writer.writeByte(PROTOCOL_VERSION);
    writer.writeByte(Channel.PRESENCE);
    writer.writeByte(PresenceMessageType.PRESENCE_UPDATE);
    writer.writeByte(0b1000); // bit 3 is reserved
    const bytes = writer.toUint8Array();
    expect(() => decodePresenceFrame(bytes, { direction: "clientOrigin" })).toThrow(ProtocolDecodeError);
  });

  it("rejects an unknown role byte in presenceJoin", () => {
    const writer = new ByteWriter();
    writer.writeByte(PROTOCOL_VERSION);
    writer.writeByte(Channel.PRESENCE);
    writer.writeByte(PresenceMessageType.PRESENCE_JOIN);
    writeVarint(writer, 1);
    for (let i = 0; i < 16; i++) writer.writeByte(0); // 16 raw uuid bytes
    writeVarint(writer, 0); // empty displayName
    writer.writeByte(99); // not a real SessionRole
    expect(() => decodePresenceFrame(writer.toUint8Array(), { direction: "serverOrigin" })).toThrow(
      ProtocolDecodeError,
    );
  });

  it("rejects an unknown reason byte in presenceLeave", () => {
    const writer = new ByteWriter();
    writer.writeByte(PROTOCOL_VERSION);
    writer.writeByte(Channel.PRESENCE);
    writer.writeByte(PresenceMessageType.PRESENCE_LEAVE);
    writeVarint(writer, 1);
    writer.writeByte(99);
    expect(() => decodePresenceFrame(writer.toUint8Array(), { direction: "serverOrigin" })).toThrow(
      ProtocolDecodeError,
    );
  });

  it("rejects an unrecognized message type", () => {
    const writer = new ByteWriter();
    writer.writeByte(PROTOCOL_VERSION);
    writer.writeByte(Channel.PRESENCE);
    writer.writeByte(0x0f);
    expect(() => decodePresenceFrame(writer.toUint8Array())).toThrow(ProtocolDecodeError);
  });

  it("rejects the wrong channel byte", () => {
    const writer = new ByteWriter();
    writer.writeByte(PROTOCOL_VERSION);
    writer.writeByte(Channel.OPS);
    writer.writeByte(PresenceMessageType.PRESENCE_LEAVE);
    expect(() => decodePresenceFrame(writer.toUint8Array())).toThrow(ProtocolDecodeError);
  });

  it("rejects trailing bytes after a valid payload", () => {
    const bytes = encodePresenceFrame({ kind: "presenceLeave", replicaId: 1, reason: PresenceLeaveReason.CLEAN });
    const withGarbage = new Uint8Array([...bytes, 0xff]);
    expect(() => decodePresenceFrame(withGarbage, { direction: "serverOrigin" })).toThrow(ProtocolDecodeError);
  });

  it("rejects a truncated frame", () => {
    const bytes = encodePresenceFrame({ kind: "presenceLeave", replicaId: 1, reason: PresenceLeaveReason.CLEAN });
    expect(() =>
      decodePresenceFrame(bytes.slice(0, bytes.length - 1), { direction: "serverOrigin" }),
    ).toThrow(ProtocolDecodeError);
  });
});
