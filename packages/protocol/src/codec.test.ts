import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Identifier } from "@collab-editor/engine";
import { Engine } from "@collab-editor/engine";
import { ByteWriter } from "./bytes.js";
import { debugProject, decodeFrame, encodeFrame } from "./codec.js";
import { ProtocolDecodeError } from "./errors.js";
import { expandInsertRun, opInsertToOperation } from "./expand.js";
import {
  Channel,
  type OpsMessage,
  OpsMessageType,
  PROTOCOL_VERSION,
  RejectReason,
} from "./messages.js";
import { writeVarint } from "./varint.js";

const idArb = fc.record({ c: fc.nat({ max: 5_000_000 }), r: fc.nat({ max: 500 }) });
const optionalIdArb = fc.option(idArb, { nil: null });
const scalarArb = fc.integer({ min: 0, max: 0x10ffff }).filter((cp) => cp < 0xd800 || cp > 0xdfff);
const rejectReasonArb = fc.constantFrom(
  ...(Object.values(RejectReason).filter((v) => typeof v === "number") as RejectReason[]),
);

const opInsertArb: fc.Arbitrary<OpsMessage> = fc.record({
  kind: fc.constant("opInsert" as const),
  seq: fc.constant(0),
  id: idArb,
  originLeft: optionalIdArb,
  originRight: optionalIdArb,
  bind: fc.boolean(),
  value: scalarArb,
});

// n >= 2 (§3.5.2)
const opInsertRunArb: fc.Arbitrary<OpsMessage> = fc.record({
  kind: fc.constant("opInsertRun" as const),
  seq: fc.constant(0),
  firstId: idArb,
  originLeft: optionalIdArb,
  originRight: optionalIdArb,
  bind: fc.boolean(),
  values: fc.array(scalarArb, { minLength: 2, maxLength: 20 }),
});

const opDeleteArb: fc.Arbitrary<OpsMessage> = fc.record({
  kind: fc.constant("opDelete" as const),
  seq: fc.constant(0),
  id: idArb,
  target: idArb,
});

// n >= 2 (§3.5.4)
const opDeleteBatchArb: fc.Arbitrary<OpsMessage> = fc.record({
  kind: fc.constant("opDeleteBatch" as const),
  seq: fc.constant(0),
  by: fc.nat({ max: 500 }),
  atFirst: fc.nat({ max: 5_000_000 }),
  targets: fc.array(idArb, { minLength: 2, maxLength: 20 }),
});

const opUndeleteArb: fc.Arbitrary<OpsMessage> = fc.record({
  kind: fc.constant("opUndelete" as const),
  seq: fc.constant(0),
  id: idArb,
  target: idArb,
});

// OP_ACK/OP_REJECT are server-only batches with no `seq` of their own (§3.5.7/§3.5.8).
const opAckArb: fc.Arbitrary<OpsMessage> = fc.record({
  kind: fc.constant("opAck" as const),
  acks: fc.array(fc.record({ ackSeq: fc.nat({ max: 5_000_000 }), ackedId: idArb }), {
    minLength: 1,
    maxLength: 10,
  }),
});

const opRejectArb: fc.Arbitrary<OpsMessage> = fc.record({
  kind: fc.constant("opReject" as const),
  rejects: fc.array(fc.record({ rejectedId: idArb, reason: rejectReasonArb }), {
    minLength: 1,
    maxLength: 10,
  }),
  detail: fc.string({ maxLength: 40 }),
});

const opsMessageArb: fc.Arbitrary<OpsMessage> = fc.oneof(
  opInsertArb,
  opInsertRunArb,
  opDeleteArb,
  opDeleteBatchArb,
  opUndeleteArb,
  opAckArb,
  opRejectArb,
);

/** Structural equality, field by field — deliberately not a key-order-sensitive JSON.stringify. */
function sameMessage(a: OpsMessage, b: OpsMessage): boolean {
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** OP_ACK/OP_REJECT are server→client only — decode them accordingly throughout this file. */
function decodeServerFrame(bytes: Uint8Array): OpsMessage {
  return decodeFrame(bytes, { direction: "serverOrigin" });
}

describe("codec — round-trip (API/Protocol/Data Spec §3.5)", () => {
  it("decode(encode(msg)) === msg for 10,000 generated messages of every OPS type", () => {
    fc.assert(
      fc.property(opsMessageArb, (msg) => {
        const direction =
          msg.kind === "opAck" || msg.kind === "opReject" ? "serverOrigin" : "clientOrigin";
        return sameMessage(decodeFrame(encodeFrame(msg), { direction }), msg);
      }),
      { numRuns: 10_000 },
    );
  });
});

describe("codec — envelope (§3.2)", () => {
  it("is exactly 3 bytes, with the payload starting immediately at offset 3 — no frame-level flags byte", () => {
    const msg: OpsMessage = {
      kind: "opDelete",
      seq: 0,
      id: { c: 1, r: 1 },
      target: { c: 2, r: 2 },
    };
    const bytes = encodeFrame(msg);
    // envelope: protocolVersion, channel, messageType
    expect(bytes[0]).toBe(PROTOCOL_VERSION);
    expect(bytes[1]).toBe(Channel.OPS);
    expect(bytes[2]).toBe(OpsMessageType.OP_DELETE);
    // payload starts at offset 3: seq(0)=1 byte, target stamp=2 bytes, at=1 byte, by=1 byte -> total payload 5 bytes
    expect(bytes.length).toBe(3 + 5);
  });

  it("uses the exact spec-mandated numeric message type values", () => {
    expect(OpsMessageType.OP_INSERT).toBe(0x01);
    expect(OpsMessageType.OP_INSERT_RUN).toBe(0x02);
    expect(OpsMessageType.OP_DELETE).toBe(0x03);
    expect(OpsMessageType.OP_DELETE_BATCH).toBe(0x04);
    expect(OpsMessageType.OP_UNDELETE).toBe(0x05);
    expect(OpsMessageType.OP_ACK).toBe(0x10);
    expect(OpsMessageType.OP_REJECT).toBe(0x11);
  });

  it("uses the exact spec-mandated channel values", () => {
    expect(Channel.OPS).toBe(0x01);
    expect(Channel.PRESENCE).toBe(0x02);
    expect(Channel.CONTROL).toBe(0x03);
  });

  it("uses the exact spec-mandated 7 reject reason codes, in order", () => {
    expect(RejectReason.PERMISSION_DENIED).toBe(0x01);
    expect(RejectReason.SESSION_EXPIRED).toBe(0x02);
    expect(RejectReason.IDENTITY_MISMATCH).toBe(0x03);
    expect(RejectReason.MALFORMED).toBe(0x04);
    expect(RejectReason.RATE_LIMITED).toBe(0x05);
    expect(RejectReason.OFFLINE_WINDOW_EXCEEDED).toBe(0x06);
    expect(RejectReason.DOCUMENT_LOCKED).toBe(0x07);
  });
});

describe("codec — OP_INSERT_RUN expansion (§3.5.2)", () => {
  it("expands a 2,000-character run identically to 2,000 individual OP_INSERT frames, verified by feeding both into separate engines", () => {
    const REPLICA_A = 1;
    const REPLICA_B = 2;
    const N = 2000;

    // Engine A originates the run the normal way: 2,000 sequential
    // localInsert() calls at the end of the document produce consecutive
    // counters and the exact chained-originLeft / shared-originRight shape
    // expand.ts documents.
    const originEngine = new Engine(REPLICA_A);
    const chars = Array.from({ length: N }, (_, i) => 0x61 + (i % 26));
    const ops = chars.map((value) => originEngine.localInsert(originEngine.text().length, value));

    const runMsg = {
      kind: "opInsertRun" as const,
      seq: 0,
      firstId: ops[0]!.id,
      originLeft: ops[0]!.originLeft,
      originRight: ops[0]!.originRight,
      bind: ops[0]!.bind, // ASCII, so uniformly false across the whole run — satisfies §3.5.2's "bind applies to the WHOLE run"
      values: chars,
    };

    // Round-trip the run through the wire codec before expanding it, so
    // this exercises the real encode/decode path, not just expandInsertRun
    // on a hand-built message.
    const decodedRun = decodeFrame(encodeFrame(runMsg));
    if (decodedRun.kind !== "opInsertRun") {
      throw new Error("expected opInsertRun");
    }
    const expandedFromRun = expandInsertRun(decodedRun);

    const engineFromRun = new Engine(REPLICA_B);
    for (const op of expandedFromRun) {
      engineFromRun.applyRemote(op);
    }

    // The comparison side: 2,000 separate OP_INSERT frames, each round-tripped individually.
    const engineFromIndividualFrames = new Engine(REPLICA_B + 1);
    for (const op of ops) {
      const insertMsg = {
        kind: "opInsert" as const,
        seq: 0,
        id: op.id,
        originLeft: op.originLeft,
        originRight: op.originRight,
        bind: op.bind,
        value: op.value,
      };
      const decoded = decodeFrame(encodeFrame(insertMsg));
      if (decoded.kind !== "opInsert") {
        throw new Error("expected opInsert");
      }
      engineFromIndividualFrames.applyRemote(opInsertToOperation(decoded));
    }

    expect(expandedFromRun).toHaveLength(N);
    expect(engineFromRun.text()).toBe(originEngine.text());
    expect(engineFromIndividualFrames.text()).toBe(originEngine.text());
    expect(engineFromRun.text()).toBe(engineFromIndividualFrames.text());
    expect(engineFromRun.nodes.map((n) => n.id)).toEqual(
      engineFromIndividualFrames.nodes.map((n) => n.id),
    );
  });
});

describe("codec — malformed frame rejection (§3.2, §3.5)", () => {
  it("rejects an unsupported protocol version", () => {
    const bytes = Uint8Array.of(0x02, Channel.OPS, OpsMessageType.OP_INSERT, 0);
    expect(() => decodeFrame(bytes)).toThrow(ProtocolDecodeError);
  });

  it("rejects a reserved bit in OP_INSERT's flags byte (bits 3-7)", () => {
    const writer = new ByteWriter();
    writer.writeByte(PROTOCOL_VERSION);
    writer.writeByte(Channel.OPS);
    writer.writeByte(OpsMessageType.OP_INSERT);
    writeVarint(writer, 0); // seq
    writer.writeByte(0x08); // bit 3 is reserved

    expect(() => decodeFrame(writer.toUint8Array())).toThrow(ProtocolDecodeError);
    try {
      decodeFrame(writer.toUint8Array());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolDecodeError);
      expect((err as ProtocolDecodeError).reason).toBe("RESERVED_FLAG_BITS_SET");
    }
  });

  it("rejects a client-origin frame with a nonzero seq", () => {
    const writer = new ByteWriter();
    writer.writeByte(PROTOCOL_VERSION);
    writer.writeByte(Channel.OPS);
    writer.writeByte(OpsMessageType.OP_DELETE);
    writeVarint(writer, 7); // seq !== 0
    writeVarint(writer, 1); // target.c
    writeVarint(writer, 1); // target.r
    writeVarint(writer, 5); // at
    writeVarint(writer, 5); // by

    expect(() => decodeFrame(writer.toUint8Array(), { direction: "clientOrigin" })).toThrow(
      ProtocolDecodeError,
    );
    try {
      decodeFrame(writer.toUint8Array(), { direction: "clientOrigin" });
      expect.unreachable();
    } catch (err) {
      expect((err as ProtocolDecodeError).reason).toBe("NONZERO_CLIENT_SEQ");
    }
    // Identical bytes are valid as a server-origin frame — seq is a legitimate server-assigned value there.
    expect(() => decodeFrame(writer.toUint8Array(), { direction: "serverOrigin" })).not.toThrow();
  });

  it("rejects a client-origin OP_ACK — OP_ACK is server->client only", () => {
    const msg: OpsMessage = { kind: "opAck", acks: [{ ackSeq: 1, ackedId: { c: 1, r: 1 } }] };
    const bytes = encodeFrame(msg);
    expect(() => decodeFrame(bytes, { direction: "clientOrigin" })).toThrow(ProtocolDecodeError);
    try {
      decodeFrame(bytes, { direction: "clientOrigin" });
      expect.unreachable();
    } catch (err) {
      expect((err as ProtocolDecodeError).reason).toBe("MESSAGE_NOT_VALID_FROM_CLIENT");
    }
    expect(decodeServerFrame(bytes)).toEqual(msg);
  });

  it("rejects a client-origin OP_REJECT — OP_REJECT is server->client only", () => {
    const msg: OpsMessage = {
      kind: "opReject",
      rejects: [{ rejectedId: { c: 1, r: 1 }, reason: RejectReason.RATE_LIMITED }],
      detail: "",
    };
    const bytes = encodeFrame(msg);
    expect(() => decodeFrame(bytes, { direction: "clientOrigin" })).toThrow(ProtocolDecodeError);
  });

  it("rejects an OP_INSERT_RUN declaring fewer than 2 characters", () => {
    const writer = new ByteWriter();
    writer.writeByte(PROTOCOL_VERSION);
    writer.writeByte(Channel.OPS);
    writer.writeByte(OpsMessageType.OP_INSERT_RUN);
    writeVarint(writer, 0); // seq
    writer.writeByte(0); // flags
    writeVarint(writer, 1); // firstId.c
    writeVarint(writer, 1); // firstId.r
    writeVarint(writer, 1); // count = 1, invalid (n >= 2)
    writeVarint(writer, 1); // byteLength
    writer.writeByte(0x61); // 'a'

    expect(() => decodeFrame(writer.toUint8Array())).toThrow(ProtocolDecodeError);
    try {
      decodeFrame(writer.toUint8Array());
      expect.unreachable();
    } catch (err) {
      expect((err as ProtocolDecodeError).reason).toBe("RUN_TOO_SHORT");
    }
  });

  it("rejects an OP_DELETE_BATCH declaring fewer than 2 targets", () => {
    const writer = new ByteWriter();
    writer.writeByte(PROTOCOL_VERSION);
    writer.writeByte(Channel.OPS);
    writer.writeByte(OpsMessageType.OP_DELETE_BATCH);
    writeVarint(writer, 0); // seq
    writeVarint(writer, 1); // by
    writeVarint(writer, 1); // atFirst
    writeVarint(writer, 1); // count = 1, invalid (n >= 2)
    writeVarint(writer, 5); // target.c
    writeVarint(writer, 5); // target.r

    expect(() => decodeFrame(writer.toUint8Array())).toThrow(ProtocolDecodeError);
    try {
      decodeFrame(writer.toUint8Array());
      expect.unreachable();
    } catch (err) {
      expect((err as ProtocolDecodeError).reason).toBe("BATCH_TOO_SHORT");
    }
  });

  it("rejects an OP_INSERT_RUN whose declared count doesn't match its decoded UTF-8 text length", () => {
    const writer = new ByteWriter();
    writer.writeByte(PROTOCOL_VERSION);
    writer.writeByte(Channel.OPS);
    writer.writeByte(OpsMessageType.OP_INSERT_RUN);
    writeVarint(writer, 0); // seq
    writer.writeByte(0); // flags
    writeVarint(writer, 1); // firstId.c
    writeVarint(writer, 1); // firstId.r
    writeVarint(writer, 5); // count = 5, but only 2 chars follow
    const utf8 = new TextEncoder().encode("ab");
    writeVarint(writer, utf8.length);
    writer.writeBytes(utf8);

    expect(() => decodeFrame(writer.toUint8Array())).toThrow(ProtocolDecodeError);
    try {
      decodeFrame(writer.toUint8Array());
      expect.unreachable();
    } catch (err) {
      expect((err as ProtocolDecodeError).reason).toBe("RUN_LENGTH_MISMATCH");
    }
  });

  it("does not crash on a truncated frame — throws ProtocolDecodeError instead", () => {
    const truncated = Uint8Array.of(PROTOCOL_VERSION, Channel.OPS, OpsMessageType.OP_INSERT, 0);
    expect(() => decodeFrame(truncated)).toThrow(ProtocolDecodeError);
  });

  it("rejects an unrecognized channel", () => {
    const bytes = Uint8Array.of(PROTOCOL_VERSION, 0x7f, 0, 0, 0);
    expect(() => decodeFrame(bytes)).toThrow(ProtocolDecodeError);
  });

  it("rejects an unrecognized OP_REJECT reason code", () => {
    const writer = new ByteWriter();
    writer.writeByte(PROTOCOL_VERSION);
    writer.writeByte(Channel.OPS);
    writer.writeByte(OpsMessageType.OP_REJECT);
    writeVarint(writer, 1); // count
    writeVarint(writer, 1); // rejectedId.c
    writeVarint(writer, 1); // rejectedId.r
    writer.writeByte(0x99); // not one of the 7 defined reasons
    writeVarint(writer, 0); // detailLength

    expect(() => decodeFrame(writer.toUint8Array(), { direction: "serverOrigin" })).toThrow(
      ProtocolDecodeError,
    );
  });

  it("rejects trailing bytes after a valid payload", () => {
    const msg: OpsMessage = { kind: "opAck", acks: [{ ackSeq: 1, ackedId: { c: 1, r: 1 } }] };
    const frame = encodeFrame(msg);
    const withGarbage = new Uint8Array(frame.length + 1);
    withGarbage.set(frame);
    withGarbage[frame.length] = 0xff;
    expect(() => decodeServerFrame(withGarbage)).toThrow(ProtocolDecodeError);
  });
});

describe("codec — debugProject (mandatory, used by all logging and test failure messages)", () => {
  const sampleId: Identifier = { c: 42, r: 3 };

  const samples: OpsMessage[] = [
    {
      kind: "opInsert",
      seq: 0,
      id: sampleId,
      originLeft: null,
      originRight: null,
      bind: false,
      value: 0x61,
    },
    {
      kind: "opInsertRun",
      seq: 0,
      firstId: sampleId,
      originLeft: null,
      originRight: null,
      bind: false,
      values: [0x61, 0x62, 0x63],
    },
    { kind: "opDelete", seq: 0, id: sampleId, target: { c: 1, r: 1 } },
    {
      kind: "opDeleteBatch",
      seq: 0,
      by: 3,
      atFirst: 42,
      targets: [
        { c: 1, r: 1 },
        { c: 2, r: 1 },
      ],
    },
    { kind: "opUndelete", seq: 0, id: sampleId, target: { c: 1, r: 1 } },
    { kind: "opAck", acks: [{ ackSeq: 5, ackedId: sampleId }] },
    {
      kind: "opReject",
      rejects: [{ rejectedId: sampleId, reason: RejectReason.RATE_LIMITED }],
      detail: "too fast",
    },
  ];

  it.each(samples.map((msg) => [msg.kind, msg] as const))(
    "produces JSON-serializable, readable output for %s",
    (_kind, msg) => {
      const frame = encodeFrame(msg);
      const projected = debugProject(frame);
      expect(() => JSON.stringify(projected)).not.toThrow();
      const json = JSON.stringify(projected);
      expect(json).toContain(String(msg.kind));
    },
  );

  it("never throws, even on a malformed frame — returns a malformed-frame diagnostic object instead", () => {
    const garbage = Uint8Array.of(0xff, 0xff, 0xff, 0xff);
    const projected = debugProject(garbage) as { malformed: boolean };
    expect(projected.malformed).toBe(true);
    expect(() => JSON.stringify(projected)).not.toThrow();
  });
});

describe("codec — measured frame size (API/Protocol/Data Spec §1.3)", () => {
  it("a single insert at counters near 50,000, replica ids 1-8, encodes to exactly 18 bytes", () => {
    const near50k = 50_000;
    const msg: OpsMessage = {
      kind: "opInsert",
      seq: 0,
      id: { c: near50k, r: 2 },
      originLeft: { c: near50k - 1, r: 2 },
      originRight: { c: near50k - 2, r: 1 },
      bind: false,
      value: 0x61, // ASCII 'a'
    };
    const bytes = encodeFrame(msg);
    // §1.3: "Binary (chosen): One insert = 18 B" — measured exactly, not approximately,
    // now that the envelope carries no extraneous frame-level flags byte.
    expect(bytes.length).toBe(18);
  });
});
