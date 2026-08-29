import type { Node } from "@collab-editor/engine";
import { ByteReader, ByteWriter } from "./bytes.js";
import { ProtocolDecodeError } from "./errors.js";
import {
  decodeOptionalStamp,
  decodeScalar,
  decodeStamp,
  encodeOptionalStamp,
  encodeScalar,
  encodeStamp,
} from "./primitives.js";
import { readVarint, writeVarint } from "./varint.js";

/**
 * SNAPSHOT `form: STRUCTURE`'s `body` byte layout (API Spec §3.6.3
 * specifies the SNAPSHOT envelope but explicitly leaves the structure
 * serialization itself undefined for this phase — the real format depends
 * on block run-length encoding, Engine Spec §7.5, which isn't built until
 * Phase 20). This is a deliberate placeholder, not a guess at an existing
 * spec: it is EXPECTED to be replaced/reworked once Phase 20 lands, not
 * merely "possibly wrong" the way an unverified guess at an already-written
 * spec section would be (contrast Phase 5/7's build-now-cross-check-later
 * passes, which were guesses at text that already existed). Deliberately
 * simple for that reason — one record per node, no compression, no block
 * runs — reusing Phase 7's stamp/optional-stamp/scalar primitives so the
 * only new framing is the per-node record shape itself:
 *
 *   varint  nodeCount
 *   per node, in STRUCTURAL order (Engine Spec Definition 2.2 — this is
 *   the full node sequence, tombstones included, not vis(S); a receiving
 *   replica needs tombstones to correctly anchor future concurrent inserts):
 *     uint8   flags        bit0 hasOriginLeft, bit1 hasOriginRight,
 *                           bit2 bind, bit3 deleted, bit4 hasDeletedBy,
 *                           bits 5-7 reserved (must be 0)
 *     stamp   id
 *     [stamp  originLeft]  present iff flags bit0
 *     [stamp  originRight] present iff flags bit1
 *     varint  value         Unicode scalar (Engine Spec §2.3)
 *     [stamp  deletedBy]    present iff flags bit4
 */
const FLAG_HAS_ORIGIN_LEFT = 0x01;
const FLAG_HAS_ORIGIN_RIGHT = 0x02;
const FLAG_BIND = 0x04;
const FLAG_DELETED = 0x08;
const FLAG_HAS_DELETED_BY = 0x10;
const KNOWN_FLAG_BITS =
  FLAG_HAS_ORIGIN_LEFT | FLAG_HAS_ORIGIN_RIGHT | FLAG_BIND | FLAG_DELETED | FLAG_HAS_DELETED_BY;

export function encodeStructureSnapshotBody(nodes: readonly Node[]): Uint8Array {
  const writer = new ByteWriter();
  writeVarint(writer, nodes.length);
  for (const node of nodes) {
    let flags = 0;
    if (node.originLeft !== null) flags |= FLAG_HAS_ORIGIN_LEFT;
    if (node.originRight !== null) flags |= FLAG_HAS_ORIGIN_RIGHT;
    if (node.bind) flags |= FLAG_BIND;
    if (node.deleted) flags |= FLAG_DELETED;
    if (node.deletedBy !== null) flags |= FLAG_HAS_DELETED_BY;
    writer.writeByte(flags);
    encodeStamp(writer, node.id);
    encodeOptionalStamp(writer, node.originLeft);
    encodeOptionalStamp(writer, node.originRight);
    encodeScalar(writer, node.value);
    encodeOptionalStamp(writer, node.deletedBy);
  }
  return writer.toUint8Array();
}

export function decodeStructureSnapshotBody(bytes: Uint8Array): Node[] {
  const reader = new ByteReader(bytes);
  const count = readVarint(reader);
  const nodes: Node[] = [];
  for (let i = 0; i < count; i++) {
    const flags = reader.readByte();
    if ((flags & ~KNOWN_FLAG_BITS) !== 0) {
      throw new ProtocolDecodeError(
        "RESERVED_FLAG_BITS_SET",
        "structure snapshot node flags byte has a reserved bit set (bits 5-7 must be 0)",
      );
    }
    const id = decodeStamp(reader);
    const originLeft = decodeOptionalStamp(reader, (flags & FLAG_HAS_ORIGIN_LEFT) !== 0);
    const originRight = decodeOptionalStamp(reader, (flags & FLAG_HAS_ORIGIN_RIGHT) !== 0);
    const value = decodeScalar(reader);
    const deletedBy = decodeOptionalStamp(reader, (flags & FLAG_HAS_DELETED_BY) !== 0);
    nodes.push({
      id,
      value,
      originLeft,
      originRight,
      bind: (flags & FLAG_BIND) !== 0,
      deleted: (flags & FLAG_DELETED) !== 0,
      deletedBy,
    });
  }
  if (!reader.atEnd()) {
    throw new ProtocolDecodeError(
      "TRAILING_BYTES",
      `structure snapshot body has ${reader.remaining} unconsumed byte(s) after ${count} node(s)`,
    );
  }
  return nodes;
}

/** SNAPSHOT `form: PLAIN_TEXT`'s `body`: just UTF-8 bytes of the document text, no length-prefix framing beyond what the SNAPSHOT envelope's own `byteLength` already provides. */
export function encodeTextSnapshotBody(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function decodeTextSnapshotBody(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
