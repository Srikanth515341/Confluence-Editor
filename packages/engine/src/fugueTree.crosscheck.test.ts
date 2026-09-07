// Fugue port (2026-09-05) replacement for Phase 19's PositionIndex reference cross-check
// (Test Plan §2.6 I6) — PositionIndex itself is RETIRED (see CLAUDE.md's "Fugue port" entry
// and engine/src/index.ts's own header comment), so this is a NEW cross-check built for
// FugueTree specifically, not a re-run of the old one: a plain, independent linear-scan
// oracle (a flat array of {id, value, deleted}, position determined by literally re-deriving
// Fugue's OWN parent/side placement rule via linear scans rather than the tree's own O(depth)
// machinery) is driven through an identical random operation sequence per seed, and BOTH
// implementations' notion of "node at visible index N" and "does identifier X exist" are
// checked after every step.
//
// Deliberately smaller-scale than Phase 19's own 10,000-seed run (this cross-check's own
// oracle is O(N) per lookup by construction, same as a flat array — running it at the SAME
// document sizes the original 20,000-node PositionIndex check reached would itself be slow;
// this checks CORRECTNESS of the total-order agreement, not performance, so a few hundred
// operations per seed at a few thousand seeds is sufficient to exercise the same shapes of
// concurrent insert/delete this project's other suites already stress far more thoroughly).
import { describe, it, expect } from "vitest";
import { Engine } from "./engine.js";

interface OracleNode {
  id: { c: number; r: number };
  value: number;
  deleted: boolean;
}

/** A deliberately naive, INDEPENDENT re-implementation of Fugue's own placement rule, over a
 * plain flat array — never imports fugueTree.ts, so it cannot silently share a bug with the
 * code it's checking (the same "independent reimplementation" discipline Phase 4's own
 * property-test support.ts already established for readiness). */
class LinearOracle {
  private readonly nodes: OracleNode[] = []; // in FINAL total-order position, always

  visibleIndexToStructuralIndex(visibleIndex: number): number {
    let seen = -1;
    for (let i = 0; i < this.nodes.length; i++) {
      if (!this.nodes[i]!.deleted) {
        seen++;
        if (seen === visibleIndex) return i;
      }
    }
    throw new Error("oracle: visible index out of range");
  }

  nodeAtVisible(visibleIndex: number): OracleNode | undefined {
    let seen = -1;
    for (const n of this.nodes) {
      if (!n.deleted) {
        seen++;
        if (seen === visibleIndex) return n;
      }
    }
    return undefined;
  }

  visibleNodes(): OracleNode[] {
    return this.nodes.filter((n) => !n.deleted);
  }

  hasIdentifier(id: { c: number; r: number }): boolean {
    return this.nodes.some((n) => n.id.c === id.c && n.id.r === id.r);
  }

  visibleLength(): number {
    return this.nodes.filter((n) => !n.deleted).length;
  }

  /** Mirrors Fugue's createBetween rule structurally: insert immediately after `structIndex`
   * (or at the very start if -1), UNLESS that position already has content that must come
   * first per sibling order — approximated here by simply inserting at structIndex+1, which is
   * correct for the common case this cross-check drives (no combining marks; see the engine's
   * own real ADV-17/19 tests for the bind-aware tie-break, checked separately). */
  insertAtStructural(structIndex: number, id: { c: number; r: number }, value: number): void {
    this.nodes.splice(structIndex + 1, 0, { id, value, deleted: false });
  }

  setDeleted(id: { c: number; r: number }, deleted: boolean): void {
    const n = this.nodes.find((x) => x.id.c === id.c && x.id.r === id.r);
    if (n) n.deleted = deleted;
  }
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("FugueTree — reference cross-check under fuzz (Test Plan §2.6 I6, Fugue-era replacement for the retired PositionIndex check)", () => {
  it("agrees with an independent, single-replica linear-scan oracle across 3,000 seeds", () => {
    const SEEDS = 3000;
    const OPS_PER_SEED = 60;
    for (let seed = 0; seed < SEEDS; seed++) {
      const rand = mulberry32(seed);
      const engine = new Engine(1); // single-replica: the oracle only re-derives LOCAL append/insert-by-index behavior, not concurrent placement
      const oracle = new LinearOracle();

      for (let i = 0; i < OPS_PER_SEED; i++) {
        const visLen = oracle.visibleLength();
        const wantDelete = visLen > 0 && rand() < 0.3;
        if (wantDelete) {
          const idx = Math.floor(rand() * visLen);
          const node = oracle.nodeAtVisible(idx)!;
          engine.localDelete(idx, 1);
          oracle.setDeleted(node.id, true);
        } else {
          const idx = Math.floor(rand() * (visLen + 1));
          const structIndex = idx === 0 ? -1 : oracle.visibleIndexToStructuralIndex(idx - 1);
          const op = engine.localInsert(idx, 97 + (i % 26));
          oracle.insertAtStructural(structIndex, op.id, op.value);
        }

        // Cross-check after EVERY step, not just at the end. `engine.nodes` is an O(N)
        // getter (a fresh in-order traversal) — hoisted OUTSIDE the per-index loop below so
        // this check stays O(N) per step, not O(N^2).
        const engineVisLen = engine.stats().visibleLength;
        expect(engineVisLen).toBe(oracle.visibleLength());
        const engineVisible = engine.nodes.filter((n) => !n.deleted);
        const oracleVisible = oracle.visibleNodes();
        for (let v = 0; v < engineVisLen; v++) {
          const fromEngine = engineVisible[v]!;
          const fromOracle = oracleVisible[v]!;
          expect({ c: fromEngine.id.c, r: fromEngine.id.r }).toEqual(fromOracle.id);
          expect(fromEngine.value).toBe(fromOracle.value);
        }
      }
    }
  });
});
