import type { Identifier, Node } from "@collab-editor/engine";
import { ByteReader, ByteWriter } from "./bytes.js";
import { ProtocolDecodeError } from "./errors.js";
import { decodeOptionalStamp, decodeStamp, encodeOptionalStamp, encodeStamp } from "./primitives.js";
import { readVarint, writeVarint } from "./varint.js";

/**
 * SNAPSHOT `form: STRUCTURE`'s `body` byte layout — a Fugue-native chain
 * run-length encoding, REPLACING Phase 20's YATA-era block format
 * (`Block`/`canFollowInBlock`/`decodeBlock`, deleted outright as part of
 * the Fugue port, 2026-09-05 — see CLAUDE.md's "Fugue port" entry).
 *
 * *** THIS IS A GENUINE REDESIGN, NOT A FIELD RENAME OF THE OLD FORMAT ***
 * The old block format's own grouping condition depended on TWO
 * origin-boundary facts that Fugue simply does not have: a chained
 * `originLeft` (node j's origin is node j-1's id) AND a SHARED
 * `originRight` uniform across the whole block (Definition 7.5's own
 * condition 3). A Fugue node carries only ONE causal reference (`parent`)
 * plus a `side` bit, and there is no "shared right boundary" concept to
 * preserve at all. The chain condition below was hand-derived from
 * `FugueTree.decidePlacement`'s own behavior (the SAME derivation
 * `expand.ts`'s `expandInsertRun` needed, and for the identical reason —
 * see that file's own doc comment for the full trace) and verified by
 * this file's own round-trip tests, not carried over from the retired
 * design.
 *
 * A "chain block" is a maximal run of nodes n[0..k-1], in STRUCTURAL order
 * (Engine Spec Definition 2.2 — tombstones included, never vis(S); a
 * receiver needs tombstones to correctly anchor future concurrent
 * inserts), such that for every j in 1..k-1:
 *   - n[j].id is the immediate next counter on the SAME replica as n[0]
 *     (`n[j].id.c === n[0].id.c + j`, `n[j].id.r === n[0].id.r`);
 *   - n[j].parent === n[j-1].id AND n[j].side === "R" — exactly the shape
 *     a purely sequential, uninterrupted local typing/paste burst produces
 *     (see expand.ts's own doc comment for why this holds unconditionally
 *     for such a burst, not merely "usually");
 *   - n[j].bind, n[j].deleted, and n[j].deletedBy are all IDENTICAL to
 *     n[0]'s — a block's tombstone/bind state is uniform, encoded once,
 *     the same design choice the retired format made (Definition 7.5
 *     condition 4's own reasoning: a contiguous locally-typed run is
 *     overwhelmingly likely to be deleted as a unit too, e.g. selecting
 *     and deleting a whole pasted paragraph).
 * Any node that breaks this condition starts a NEW block — the format
 * degrades gracefully to one node per block (`count: 1`) for a
 * non-chaining structure; correctness never depends on any real-world
 * document actually chaining, only compression ratio does.
 *
 *   varint  blockCount
 *   per block, in STRUCTURAL order:
 *     uint8   flags        bit0 hasParent (block's OWN first node's
 *                           parent), bit1 side ("R" if set, "L" if clear —
 *                           the first node's own side), bit2 bind,
 *                           bit3 deleted, bit4 hasDeletedBy, bits 5-7
 *                           reserved (must be 0)
 *     stamp   id            the block's FIRST node's identifier (r, cFirst)
 *     varint  count          number of nodes in this block (>=1)
 *     [stamp  parent]       present iff flags bit0 — the block's own first
 *                            node's `parent` (nodes 1..count-1's parent is
 *                            always implicit — the immediately preceding
 *                            node in this SAME block, per the chain
 *                            condition above, so it is never re-encoded)
 *     varint  byteLength
 *     bytes   utf8           the block's `count` scalar values, re-encoded
 *                            as a UTF-8 string — same technique as
 *                            OP_INSERT_RUN (`String.fromCodePoint`/
 *                            `codePointAt` round-trip)
 *     [stamp  deletedBy]    present iff flags bit4 — uniform for the whole
 *                            block
 *
 * Encoding groups an already-decoded, FLAT `Node[]` (e.g. `engine.nodes`,
 * or a persisted operation log replayed into a fresh `Engine`) — a plain
 * function over the public `Node` shape, with no dependency on
 * `@collab-editor/engine`'s internal `FugueTree` representation at all.
 */
const FLAG_HAS_PARENT = 0x01;
const FLAG_SIDE_R = 0x02;
const FLAG_BIND = 0x04;
const FLAG_DELETED = 0x08;
const FLAG_HAS_DELETED_BY = 0x10;
const KNOWN_FLAG_BITS = FLAG_HAS_PARENT | FLAG_SIDE_R | FLAG_BIND | FLAG_DELETED | FLAG_HAS_DELETED_BY;

const textEncoder = new TextEncoder();
// ignoreBOM: true — without it, TextDecoder silently STRIPS a leading U+FEFF (a real, valid
// Unicode scalar value a Node can legitimately carry, Engine Spec §2.3) as if it were a
// byte-order mark, corrupting any block whose first character happens to be U+FEFF (found by
// this file's own 2,000-case round-trip property test generating it as an ordinary scalar).
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function idsEqual(a: Identifier | null, b: Identifier | null): boolean {
  if (a === null || b === null) return a === b;
  return a.c === b.c && a.r === b.r;
}

/**
 * True iff `next` can be appended to a chain block whose current last node
 * is `prev` — the hand-derived condition described in this file's own
 * header comment above.
 */
function canChainAfter(prev: Node, next: Node): boolean {
  return (
    next.id.r === prev.id.r &&
    next.id.c === prev.id.c + 1 &&
    next.parent !== null &&
    next.parent.r === prev.id.r &&
    next.parent.c === prev.id.c &&
    next.side === "R" &&
    next.bind === prev.bind &&
    next.deleted === prev.deleted &&
    idsEqual(next.deletedBy, prev.deletedBy)
  );
}

/** Groups a flat, structurally-ordered `Node[]` into maximal chain blocks. Pure — reads only adjacency, never mutates its input. */
function groupIntoChainBlocks(nodes: readonly Node[]): Node[][] {
  const blocks: Node[][] = [];
  let current: Node[] = [];
  for (const node of nodes) {
    const prev = current[current.length - 1];
    if (prev !== undefined && canChainAfter(prev, node)) {
      current.push(node);
    } else {
      if (current.length > 0) {
        blocks.push(current);
      }
      current = [node];
    }
  }
  if (current.length > 0) {
    blocks.push(current);
  }
  return blocks;
}

export function encodeStructureSnapshotBody(nodes: readonly Node[]): Uint8Array {
  const writer = new ByteWriter();
  const blocks = groupIntoChainBlocks(nodes);
  writeVarint(writer, blocks.length);
  for (const block of blocks) {
    const first = block[0]!;
    let flags = 0;
    if (first.parent !== null) flags |= FLAG_HAS_PARENT;
    if (first.side === "R") flags |= FLAG_SIDE_R;
    if (first.bind) flags |= FLAG_BIND;
    if (first.deleted) flags |= FLAG_DELETED;
    if (first.deletedBy !== null) flags |= FLAG_HAS_DELETED_BY;
    writer.writeByte(flags);
    encodeStamp(writer, first.id);
    writeVarint(writer, block.length);
    encodeOptionalStamp(writer, first.parent);
    const utf8 = textEncoder.encode(String.fromCodePoint(...block.map((n) => n.value)));
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
    const firstParent = decodeOptionalStamp(reader, (flags & FLAG_HAS_PARENT) !== 0);
    const firstSide: "L" | "R" = (flags & FLAG_SIDE_R) !== 0 ? "R" : "L";
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
    const deleted = (flags & FLAG_DELETED) !== 0;
    const bind = (flags & FLAG_BIND) !== 0;
    for (let j = 0; j < count; j++) {
      const nodeId: Identifier = { c: id.c + j, r: id.r };
      const parent: Identifier | null = j === 0 ? firstParent : { c: id.c + j - 1, r: id.r };
      const side: "L" | "R" = j === 0 ? firstSide : "R";
      nodes.push({
        id: nodeId,
        value: values[j]!,
        parent,
        side,
        bind,
        deleted,
        deletedBy,
      });
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
