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
      JSON.stringify(n.parent) === JSON.stringify(m.parent) &&
      n.side === m.side &&
      JSON.stringify(n.deletedBy) === JSON.stringify(m.deletedBy)
    );
  });
}

describe("structure snapshot body — round-trip against a real Engine's node list", () => {
  it("round-trips an engine with inserts, deletes, and concurrent structure", () => {
    const a = new Engine(1);
    const b = new Engine(2);
    const hOp = a.localInsert(0, 0x68); // h
    const iOp = a.localInsert(1, 0x69); // i
    // Genuine bug found while fixing this file's own build (2026-09-05, Fugue port
    // propagation): the ORIGINAL version of this test never forwarded h/i to b before
    // reaching `b.localInsert(3, ...)` — under the retired YATA engine, an out-of-range
    // `visibleIndex` silently tolerated the overshoot via its own boundary-clamping origin
    // lookups; FugueTree correctly throws instead (`nodeAtVisible` bounds-checks for real).
    // This test could never actually RUN against the real engine until this session fixed
    // the surrounding typecheck failure, so the bug was latent and undetected the whole
    // time. Fixed by actually syncing b first, which is also a more faithful fixture for
    // "concurrent structure" — b's later `applyRemote(delOp)` now targets a node b genuinely
    // has, rather than one it was never going to receive.
    b.applyRemote(hOp);
    b.applyRemote(iOp);
    const opsFromA = [a.localInsert(2, 0x21)]; // !
    for (const op of opsFromA) b.applyRemote(op);
    b.localInsert(3, 0x3f); // ? — appended after "hi!", now valid since b has actually synced h/i/!
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
      parent: fc.option(fc.record({ c: fc.nat({ max: 5_000_000 }), r: fc.nat({ max: 500 }) }), {
        nil: null,
      }),
      side: fc.constantFrom("L" as const, "R" as const),
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
    // Hand-build a malformed body: blockCount=1, flags byte with bit 5 set (reserved) — the
    // reserved-bit check fires immediately after reading the flags byte, before any subsequent
    // (now block-shaped, not per-node-shaped, Phase 20) bytes are read, so this hand-built
    // prefix is still valid for this specific assertion regardless of the wire format's shape.
    const bytes = new Uint8Array([1, 0b0010_0000, 1, 1, 0x61]);
    expect(() => decodeStructureSnapshotBody(bytes)).toThrow(ProtocolDecodeError);
  });

  // Phase 20 DoD: "Encode/decode round trip is lossless over 500 randomized engine states."
  // Unlike the property test above (arbitrary, mostly-unrelated node descriptors — mostly
  // exercises the one-node-per-block degenerate case), this drives REAL `Engine` instances
  // through randomized local inserts/deletes across multiple replicas with cross-replica
  // syncing, so blocks actually FORM the way real usage produces them, and checks both
  // structural round-trip AND that a document rebuilt from the decoded nodes materializes the
  // identical text.
  it("round-trips 500 randomized real Engine states losslessly, including materialized text", () => {
    function mulberry32(seed: number): () => number {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // Earlier revisions of this test wrapped each trial's body in a try/catch, tracking and
    // bounding a "skipped" count for trials that tripped Engine Spec §6.2 sub-case iii-d's
    // test-build canary (Phase 6) at a measured ~24% rate. That canary and the bug it was
    // catching (Case C's — and, found while validating that fix, ALSO Case B's — origin-
    // bounded integration logic) are both fixed as of 2026-09-03 (see CLAUDE.md's "Engine
    // Spec §6.2 sub-case iii-d correction" entry; tests/regression/R0008, R0009). The
    // workaround is removed now that there is nothing left to skip.
    const TRIALS = 500;
    for (let trial = 0; trial < TRIALS; trial++) {
      const rng = mulberry32(trial);
      const replicaCount = 1 + Math.floor(rng() * 3);
      const engines = Array.from({ length: replicaCount }, (_, i) => new Engine(i + 1));
      const opCount = Math.floor(rng() * 40);

      for (let step = 0; step < opCount; step++) {
        const engine = engines[Math.floor(rng() * engines.length)]!;
        const visibleLength = engine.stats().visibleLength;
        const action = rng();
        let op;
        if (action < 0.75 || visibleLength === 0) {
          const pos = Math.floor(rng() * (visibleLength + 1));
          op = engine.localInsert(pos, 97 + Math.floor(rng() * 26));
        } else {
          const pos = Math.floor(rng() * visibleLength);
          op = engine.localDelete(pos, 1)[0];
        }
        if (op) {
          for (const other of engines) {
            if (other !== engine) other.applyRemote(op);
          }
        }
      }

      const source = engines[0]!;
      const body = encodeStructureSnapshotBody(source.nodes);
      const decoded = decodeStructureSnapshotBody(body);
      expect(sameNodes(decoded, source.nodes)).toBe(true);

      // Rebuild a fresh engine purely from the decoded nodes (mirroring
      // @collab-editor/protocol's own seedEngineFromSnapshot) and confirm it materializes the
      // identical text — the ultimate, representation-independent correctness check.
      const rebuilt = new Engine(0);
      for (const n of decoded) {
        rebuilt.applyRemote({
          kind: "insert",
          id: n.id,
          value: n.value,
          parent: n.parent,
          side: n.side,
          bind: n.bind,
        });
      }
      for (const n of decoded) {
        if (n.deleted && n.deletedBy) {
          rebuilt.applyRemote({ kind: "delete", id: n.deletedBy, target: n.id });
        }
      }
      expect(rebuilt.text()).toBe(source.text());
    }
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
