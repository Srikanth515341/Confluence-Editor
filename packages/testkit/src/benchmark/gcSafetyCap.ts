// Phase 21 — real wall-clock measurement for Engine.collect()'s safety cap (Engine Spec
// §7.4, found via M8-c's own DoD verification: an uncapped sweep over a 10,000-deep/
// 90,000-node pathological anchor chain measured 853 SECONDS — see CLAUDE.md's Phase 21
// entry). Lives here, not packages/engine — timing measurement needs `performance.now()`,
// which engine-purity rules forbid everywhere in packages/engine/src, including test files
// (the same split Phase 19's scaling benchmark already established for the identical reason).
// The engine-level correctness/logic tests (does the cap trigger, does it collect zero, does
// I4/I5 still hold) live in packages/engine/src/engine.test.ts using a fake, deterministic
// clock instead — this file is the ONLY place the real "214ms not 853,000ms" claim is proven.

import { Engine } from "@collab-editor/engine";

/** Builds the exact pathological shape the 853s figure came from: `count` sequential
 * append-chain characters (originLeft chains to the immediate predecessor — real sequential
 * typing produces exactly this shape), the first `deleteCount` of them tombstoned with real
 * GC context, leaving an UNRESOLVED anchor chain (the still-live character right after the
 * deleted prefix permanently references the last deleted one — Engine Spec I4/I5 correctly
 * refuses to ever collect any of them). */
function buildPathologicalChain(count: number, deleteCount: number): Engine {
  const engine = new Engine(1);
  let prevId: { c: number; r: number } | null = null;
  const ids: Array<{ c: number; r: number }> = [];
  for (let i = 0; i < count; i++) {
    const id = { c: i + 1, r: 1 };
    engine.applyRemote({
      kind: "insert",
      id,
      value: 97 + (i % 26),
      originLeft: prevId,
      originRight: null,
      bind: false,
    });
    ids.push(id);
    prevId = id;
  }
  for (let i = 0; i < deleteCount; i++) {
    const target = ids[i]!;
    engine.applyRemote(
      { kind: "delete", id: { c: count + i + 1, r: 2 }, target },
      { seq: BigInt(count + i + 1), atMs: 0 },
    );
  }
  return engine;
}

export interface GcSafetyCapMeasurement {
  readonly elapsedMs: number;
  readonly incomplete: boolean;
  readonly collectedCount: number;
  readonly tombstonesBefore: number;
  readonly tombstonesAfter: number;
}

/** Runs ONE capped `collect()` call over the pathological 10,000-deep/90,000-node chain,
 * measuring real wall-clock elapsed time with `performance.now()` — the actual proof that
 * the cap bounds the 853-second uncapped cost to a small fraction of a second. */
export function measureGcSafetyCap(budgetMs: number): GcSafetyCapMeasurement {
  const engine = buildPathologicalChain(90_000, 10_000);
  const tombstonesBefore = engine.stats().tombstones;

  const start = performance.now();
  const result = engine.collect(BigInt(100_000), {
    nowMs: 10_000_000,
    maxAgeMs: 0,
    maxOpsPerReplica: 0,
    budgetMs,
    clock: () => performance.now(),
  });
  const elapsedMs = performance.now() - start;

  return {
    elapsedMs,
    incomplete: result.incomplete,
    collectedCount: result.collectedCount,
    tombstonesBefore,
    tombstonesAfter: engine.stats().tombstones,
  };
}
