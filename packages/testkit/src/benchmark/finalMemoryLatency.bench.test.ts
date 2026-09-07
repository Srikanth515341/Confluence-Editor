import { Engine } from "@collab-editor/engine";
import { describe, expect, it } from "vitest";
import { buildGcEligibleMemoryDocument } from "./finalMemoryLatency.js";

/**
 * Phase 25 DoD — Test Plan M8-a, run via `pnpm test:benchmark` (same gating as Phases 19-21's
 * own scaling/compression/GC-safety-cap benchmarks — real database/network infra-free, but
 * still fuzz/benchmark-suite scale, not inner-loop material). Prints REAL measured numbers via
 * `console.log` (this project's own established convention since Phase 17: "give me the real
 * numbers, not just the ratio").
 */
describe("Final memory and apply-latency benchmark (Phase 25 DoD, Test Plan M8-a)", () => {
  it("M8-a: memory at 100,000 operations / ~10,000 visible, BEFORE and AFTER Phase 21's real GC", () => {
    // Warm up the JIT/allocator with a throwaway build of the same shape first — matches
    // compression.ts's own M8-b measurement discipline exactly.
    buildGcEligibleMemoryDocument(20_000, 2_000);

    const gc = (globalThis as { gc?: () => void }).gc;
    const measure = (): number => {
      gc?.();
      return process.memoryUsage().heapUsed;
    };

    const TOTAL_OPS = 100_000;
    const TARGET_VISIBLE = 10_000;

    const before = measure();
    const { engine, maxSeq } = buildGcEligibleMemoryDocument(TOTAL_OPS, TARGET_VISIBLE);
    const afterBuild = measure();
    const preGcDeltaMb = (afterBuild - before) / (1024 * 1024);

    const statsBeforeGc = engine.stats();
    expect(statsBeforeGc.visibleLength).toBe(TARGET_VISIBLE);
    expect(statsBeforeGc.tombstones).toBe(TOTAL_OPS - TARGET_VISIBLE);

    // A single collect() call: frontier covers every synthetic delete seq (all causally
    // stable), and both undo-horizon conditions are trivially satisfied (atMs=0, so any
    // `nowMs`/`maxAgeMs` pairing ages every tombstone out immediately; `maxOpsPerReplica: 0`
    // means even the op-count half is already crossed). No `budgetMs` cap — this fixture's own
    // "delete from the visible end, nothing anchors to it" shape is exactly Phase 21's own
    // established NON-pathological case (no cascading anchor chain), so one uncapped call is
    // expected to reach the true fixpoint in a single pass, not the 853-second pathology that
    // shape's OWN GC DoD test found and fixed.
    const result = engine.collect(maxSeq, { nowMs: 1, maxAgeMs: 0, maxOpsPerReplica: 0 });
    expect(result.incomplete).toBe(false);
    expect(result.collectedCount).toBe(TOTAL_OPS - TARGET_VISIBLE); // every tombstone, not merely some

    const afterGc = measure();
    const postGcDeltaMb = (afterGc - before) / (1024 * 1024);

    const statsAfterGc = engine.stats();
    expect(statsAfterGc.visibleLength).toBe(TARGET_VISIBLE); // GC never touches visible content
    expect(statsAfterGc.tombstones).toBe(0);
    expect(statsAfterGc.totalElements).toBe(TARGET_VISIBLE);

    // eslint-disable-next-line no-console -- DoD explicitly requires the real numbers recorded.
    console.log(
      `[memory] M8-a: 100,000 ops / 10,000 visible -> PRE-GC heapUsed delta ${preGcDeltaMb.toFixed(2)} MB ` +
        `(gc available: ${gc !== undefined}); collect() removed ${result.collectedCount} tombstone(s) in one pass; ` +
        `POST-GC heapUsed delta ${postGcDeltaMb.toFixed(2)} MB. RFC §2.5 target: 10 MB. Phase 20's own ` +
        `pre-GC M8-b measurement (block compression alone, no removal): 45.60 MB.`,
    );

    // Recorded, asserted against real regression only (not hard-gated on the 10 MB target
    // itself, matching Phase 20's own M8-b precedent) — see this test's own console.log and
    // docs/benchmarks.md for the actual pass/fail call against the 10 MB target.
    expect(postGcDeltaMb).toBeGreaterThanOrEqual(0);
    expect(postGcDeltaMb).toBeLessThan(preGcDeltaMb); // GC must measurably reduce footprint, not just claim to
  }, 60_000);

  it("M8-a: apply-latency (remote applyRemote, the real multi-replica cost model) on the same post-GC document", () => {
    const TOTAL_OPS = 100_000;
    const TARGET_VISIBLE = 10_000;
    const { engine } = buildGcEligibleMemoryDocument(TOTAL_OPS, TARGET_VISIBLE);
    engine.collect(BigInt(TOTAL_OPS - TARGET_VISIBLE), { nowMs: 1, maxAgeMs: 0, maxOpsPerReplica: 0 });

    // A SEPARATE engine (replica 2) applies REMOTE copies of `sampleCount` further local
    // inserts minted by the (now GC'd) document's own replica 1 — `applyRemote`, not
    // `localInsert`, is the realistic cost a PEER pays receiving someone else's edit, which is
    // what M8-a's own "apply-latency" wording actually asks about, distinct from Phase 19's own
    // `localInsert`-focused scaling benchmark.
    const peer = new Engine(3);
    for (const node of engine.nodes) {
      // Seed the peer with an identical structure via the SAME synthetic replay this project's
      // own snapshot-seeding logic uses elsewhere (insert, then a matching delete for anything
      // already tombstoned) — deliberately NOT importing @collab-editor/protocol's
      // replaySnapshotNodesInto here, since that would pull a cross-package dependency into
      // packages/testkit purely for this one benchmark; the two-pass shape is simple enough to
      // inline directly.
      peer.applyRemote({
        kind: "insert",
        id: node.id,
        value: node.value,
        parent: node.parent,
        side: node.side,
        bind: node.bind,
      });
    }
    for (const node of engine.nodes) {
      if (node.deleted && node.deletedBy) {
        peer.applyRemote({ kind: "delete", id: node.deletedBy, target: node.id });
      }
    }
    expect(peer.text()).toBe(engine.text());

    const SAMPLE_COUNT = 500;
    const samplesMs: number[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const op = engine.localInsert(engine.text().length, 97 + (i % 26));
      const start = performance.now();
      peer.applyRemote(op);
      samplesMs.push(performance.now() - start);
    }
    samplesMs.sort((a, b) => a - b);
    const p50 = samplesMs[Math.floor(samplesMs.length * 0.5)]!;
    const p95 = samplesMs[Math.floor(samplesMs.length * 0.95)]!;
    const p99 = samplesMs[Math.min(samplesMs.length - 1, Math.floor(samplesMs.length * 0.99))]!;

    // eslint-disable-next-line no-console -- DoD explicitly requires the real numbers recorded.
    console.log(
      `[latency] M8-a: applyRemote() on a 10,000-visible (post-GC) document, ${SAMPLE_COUNT} samples -> ` +
        `p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms (PRD M3 budget: 16ms).`,
    );
    expect(p99).toBeLessThan(16);
  });
});
