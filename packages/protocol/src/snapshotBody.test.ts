import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Node } from "@collab-editor/engine";
import { Engine } from "@collab-editor/engine";
import {
  decodeStructureSnapshotBody,
  decodeTextSnapshotBody,
  encodeStructureSnapshotBody,
  encodeTextSnapshotBody,
} from "./snapshotBody.js";
import { ProtocolDecodeError } from "./errors.js";

function sameNodes(a: readonly Node[], b: readonly Node[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((n, i) => {
    const m = b[i]!;
    return (
      n.id.c === m.id.c &&
      n.id.r === m.id.r &&
      n.value === m.value &&
      n.bind === m.bind &&
      n.deleted === m.deleted &&
      JSON.stringify(n.originLeft) === JSON.stringify(m.originLeft) &&
      JSON.stringify(n.originRight) === JSON.stringify(m.originRight) &&
      JSON.stringify(n.deletedBy) === JSON.stringify(m.deletedBy)
    );
  });
}

describe("structure snapshot body — round-trip against a real Engine's node list", () => {
  it("round-trips an engine with inserts, deletes, and concurrent structure", () => {
    const a = new Engine(1);
    const b = new Engine(2);
    a.localInsert(0, 0x68); // h
    a.localInsert(1, 0x69); // i
    const opsFromA = [a.localInsert(2, 0x21)]; // !
    for (const op of opsFromA) b.applyRemote(op);
    b.localInsert(3, 0x3f); // ?
    // concurrent delete on a's "i"
    const [delOp] = a.localDelete(1, 1);
    b.applyRemote(delOp!);

    const body = encodeStructureSnapshotBody(a.nodes);
    const decoded = decodeStructureSnapshotBody(body);
    expect(sameNodes(decoded, a.nodes)).toBe(true);
    expect(decoded.some((n) => n.deleted)).toBe(true);
  });

  it("round-trips an empty document", () => {
    const engine = new Engine(1);
    const body = encodeStructureSnapshotBody(engine.nodes);
    expect(decodeStructureSnapshotBody(body)).toEqual([]);
  });

  it("round-trips 2,000 generated node descriptors (property test)", () => {
    const nodeArb = fc.record({
      id: fc.record({ c: fc.nat({ max: 5_000_000 }), r: fc.nat({ max: 500 }) }),
      value: fc.integer({ min: 0, max: 0x10ffff }).filter((cp) => cp < 0xd800 || cp > 0xdfff),
      originLeft: fc.option(fc.record({ c: fc.nat({ max: 5_000_000 }), r: fc.nat({ max: 500 }) }), {
        nil: null,
      }),
      originRight: fc.option(
        fc.record({ c: fc.nat({ max: 5_000_000 }), r: fc.nat({ max: 500 }) }),
        { nil: null },
      ),
      bind: fc.boolean(),
      deleted: fc.boolean(),
      deletedBy: fc.option(fc.record({ c: fc.nat({ max: 5_000_000 }), r: fc.nat({ max: 500 }) }), {
        nil: null,
      }),
    });
    fc.assert(
      fc.property(fc.array(nodeArb, { maxLength: 30 }), (nodes) =>
        sameNodes(decodeStructureSnapshotBody(encodeStructureSnapshotBody(nodes)), nodes),
      ),
      { numRuns: 2_000 },
    );
  });

  it("rejects a reserved flag bit set", () => {
    // Hand-build a malformed body: nodeCount=1, flags byte with bit 5 set (reserved).
    const bytes = new Uint8Array([1, 0b0010_0000, 1, 1, 0x61]);
    expect(() => decodeStructureSnapshotBody(bytes)).toThrow(ProtocolDecodeError);
  });
});

describe("plain-text snapshot body", () => {
  it("round-trips arbitrary Unicode text", () => {
    fc.assert(
      fc.property(
        fc.string(),
        (text) => decodeTextSnapshotBody(encodeTextSnapshotBody(text)) === text,
      ),
      { numRuns: 1_000 },
    );
  });
});
