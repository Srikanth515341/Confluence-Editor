import type { Block, Node } from "@collab-editor/engine";
import { canFollowInBlock, decodeBlock } from "@collab-editor/engine";
import { ByteReader, ByteWriter } from "./bytes.js";
import { ProtocolDecodeError } from "./errors.js";
import { decodeOptionalStamp, decodeStamp, encodeOptionalStamp, encodeStamp } from "./primitives.js";
import { readVarint, writeVarint } from "./varint.js";

/**
 * SNAPSHOT `form: STRUCTURE`'s `body` byte layout — Engine Spec §7.5's
 * block run-length encoding (Definition 7.5), REPLACING the Phase 9
 * one-record-per-node placeholder ("expected to be reworked once Phase 20
 * lands" — this is that phase). One block descriptor per maximal run
 * instead of one record per node — a sequential-typing-heavy document now
 * serializes at close to the same compression ratio the live engine's own
 * `PositionIndex` achieves in memory (Phase 20), not 1:1 per character.
 *
 *   varint  blockCount
 *   per block, in STRUCTURAL order (Engine Spec Definition 2.2 — the full
 *   node sequence, tombstones included, not vis(S); a receiving replica
 *   needs tombstones to correctly anchor future concurrent inserts):
 *     uint8   flags        bit0 hasOriginLeft, bit1 hasOriginRight,
 *                           bit2 bind, bit3 deleted, bit4 hasDeletedBy,
 *                           bits 5-7 reserved (must be 0)
 *     stamp   id            the block's FIRST node's identifier (r, cFirst)
 *     varint  count          number of nodes in this block (>=1)
 *     [stamp  originLeft]   present iff flags bit0 — the block's own, first node's origin
 *     [stamp  originRight]  present iff flags bit1 — Definition 7.5: shared/uniform for the
 *                            whole block, not re-derived per node (see @collab-editor/engine's
 *                            block.ts for why that's lossless for a validly-grouped run)
 *     varint  byteLength
 *     bytes   utf8           the block's `count` scalar values, re-encoded as a UTF-8 string —
 *                            same technique as Phase 7's OP_INSERT_RUN (`String.fromCodePoint`/
 *                            `codePointAt` round-trip), reused deliberately rather than
 *                            reinvented
 *     [stamp  deletedBy]    present iff flags bit4 — uniform for the whole block (Definition
 *                            7.5 condition 4)
 *
 * Encoding groups an already-decoded, FLAT `Node[]` (e.g. `engine.nodes`,
 * or a persisted operation log replayed into a fresh `Engine`) into
 * maximal runs via `canFollowInBlock` — independent of whatever internal
 * representation (block-compressed or not) produced that sequence, so
 * this format compresses just as well for a document seeded from a
 * genesis replay as for one read live off a running coordinator's own
 * `PositionIndex`.
 */
const FLAG_HAS_ORIGIN_LEFT = 0x01;
const FLAG_HAS_ORIGIN_RIGHT = 0x02;
const FLAG_BIND = 0x04;
const FLAG_DELETED = 0x08;
const FLAG_HAS_DELETED_BY = 0x10;
const KNOWN_FLAG_BITS =
  FLAG_HAS_ORIGIN_LEFT | FLAG_HAS_ORIGIN_RIGHT | FLAG_BIND | FLAG_DELETED | FLAG_HAS_DELETED_BY;

const textEncoder = new TextEncoder();
// ignoreBOM: true — without it, TextDecoder silently STRIPS a leading U+FEFF (a real, valid
// Unicode scalar value a Node can legitimately carry, Engine Spec §2.3) as if it were a
// byte-order mark, corrupting any block whose first character happens to be U+FEFF (found by
// this file's own 2,000-case round-trip property test generating it as an ordinary scalar).
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Groups a flat, structurally-ordered `Node[]` into maximal Definition 7.5 runs. Pure — reads only adjacency, never mutates its input. */
function groupIntoRuns(nodes: readonly Node[]): Node[][] {
  const runs: Node[][] = [];
  let current: Node[] = [];
  for (const node of nodes) {
    const prev = current[current.length - 1];
    if (prev !== undefined && canFollowInBlock(prev, node)) {
      current.push(node);
    } else {
      if (current.length > 0) {
        runs.push(current);
      }
      current = [node];
    }
  }
  if (current.length > 0) {
    runs.push(current);
  }
  return runs;
}

export function encodeStructureSnapshotBody(nodes: readonly Node[]): Uint8Array {
  const writer = new ByteWriter();
  const runs = groupIntoRuns(nodes);
  writeVarint(writer, runs.length);
  for (const run of runs) {
    const first = run[0]!;
    let flags = 0;
    if (first.originLeft !== null) flags |= FLAG_HAS_ORIGIN_LEFT;
    if (first.originRight !== null) flags |= FLAG_HAS_ORIGIN_RIGHT;
    if (first.bind) flags |= FLAG_BIND;
    if (first.deleted) flags |= FLAG_DELETED;
    if (first.deletedBy !== null) flags |= FLAG_HAS_DELETED_BY;
    writer.writeByte(flags);
    encodeStamp(writer, first.id);
    writeVarint(writer, run.length);
    encodeOptionalStamp(writer, first.originLeft);
    encodeOptionalStamp(writer, first.originRight);
    const utf8 = textEncoder.encode(String.fromCodePoint(...run.map((n) => n.value)));
    writeVarint(writer, utf8.length);
    writer.writeBytes(utf8);
    encodeOptionalStamp(writer, first.deletedBy);
  }
  return writer.toUint8Array();
}

export function decodeStructureSnapshotBody(bytes: Uint8Array): Node[] {
  const reader = new ByteReader(bytes);
  const blockCount = readVarint(reader);
  const nodes: Node[] = [];
  for (let b = 0; b < blockCount; b++) {
    const flags = reader.readByte();
    if ((flags & ~KNOWN_FLAG_BITS) !== 0) {
      throw new ProtocolDecodeError(
        "RESERVED_FLAG_BITS_SET",
        "structure snapshot block flags byte has a reserved bit set (bits 5-7 must be 0)",
      );
    }
    const id = decodeStamp(reader);
    const count = readVarint(reader);
    if (count < 1) {
      throw new ProtocolDecodeError(
        "BLOCK_TOO_SHORT",
        `structure snapshot block declared count ${count}, must be >= 1`,
      );
    }
    const originLeft = decodeOptionalStamp(reader, (flags & FLAG_HAS_ORIGIN_LEFT) !== 0);
    const originRight = decodeOptionalStamp(reader, (flags & FLAG_HAS_ORIGIN_RIGHT) !== 0);
    const byteLength = readVarint(reader);
    const utf8 = reader.readBytes(byteLength);
    let text: string;
    try {
      text = textDecoder.decode(utf8);
    } catch {
      throw new ProtocolDecodeError(
        "INVALID_UTF8",
        "structure snapshot block's utf8 field is not valid UTF-8",
      );
    }
    const values = Array.from(text, (ch) => ch.codePointAt(0)!);
    if (values.length !== count) {
      throw new ProtocolDecodeError(
        "RUN_LENGTH_MISMATCH",
        `structure snapshot block declared count ${count} but utf8 decoded to ${values.length} scalar(s)`,
      );
    }
    const deletedBy = decodeOptionalStamp(reader, (flags & FLAG_HAS_DELETED_BY) !== 0);
    const block: Block = {
      r: id.r,
      cFirst: id.c,
      values,
      originLeft,
      originRight,
      deleted: (flags & FLAG_DELETED) !== 0,
      deletedBy,
      bind: (flags & FLAG_BIND) !== 0,
    };
    for (const n of decodeBlock(block)) {
      nodes.push(n);
    }
  }
  if (!reader.atEnd()) {
    throw new ProtocolDecodeError(
      "TRAILING_BYTES",
      `structure snapshot body has ${reader.remaining} unconsumed byte(s) after ${blockCount} block(s)`,
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
