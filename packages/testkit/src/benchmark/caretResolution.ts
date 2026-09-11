import { Engine, type Identifier } from "@collab-editor/engine";

/**
 * Phase 32 follow-up (raised in code review, not part of the phase's own original DoD) — answers
 * a direct question: does `Engine.resolveCaret` (and `resolvePresenceAnchor`, its CAPTURE-
 * direction sibling, `packages/client/src/sync/syncClient.ts`) compound with the already-
 * disclosed Fugue O(N) sequential-typing chain depth (CLAUDE.md's Open Item 3), given that
 * `EditorView.tsx` calls both once per remote-ops-applied batch to keep this session's own caret
 * anchored?
 *
 * Lives in packages/testkit (not packages/engine) for the SAME reason `scaling.ts`/
 * `attackWorkload.ts` do — timing measurement needs `performance.now()`, which engine-purity
 * rules forbid everywhere in `packages/engine/src`.
 *
 * Methodology: builds a document via N SEQUENTIAL end-appends (`scaling.ts`'s own "worst-case
 * single unbroken right-child chain" shape — sequential typing, matching the exact realistic
 * scenario the review question named: "a peer is typing," which is what produces the deepest
 * possible tree depth for a given N, per `FugueTree.decidePlacement`'s own "attach right after
 * the last thing I typed" rule). Measures THREE things at each size, all real per-call costs, not
 * an aggregate average:
 *   1. `resolveCaret` at the DEEPEST node (the most-recently-typed character — the realistic
 *      anchor position for a user whose cursor sits where they, or a peer they're watching, are
 *      actively typing).
 *   2. `engine.visible()` — what `resolvePresenceAnchor` (the CAPTURE direction `EditorView.tsx`
 *      also calls, once per anchor AND once per focus, so twice per remote batch) actually calls
 *      internally. This is a FULL in-order traversal (`FugueTree.toArray()`), unrelated to
 *      `resolveCaret`'s own O(depth) walk — a real, separate cost this phase's own client wiring
 *      introduced, worth measuring on its own footing rather than assuming it shares
 *      `resolveCaret`'s cost class.
 *   3. The FULL per-remote-batch overhead `EditorView.tsx`'s `onRemoteOpsApplied` handler actually
 *      pays for caret tracking alone (excluding the pre-existing `domWriter.mount()`/`engine.
 *      text()` remount cost, which is unchanged by this phase and already O(N) since Phase 14) —
 *      two `resolvePresenceAnchor` calls (capture, anchor + focus) plus two `resolveCaret` calls
 *      (restore, anchor + focus) — sampled ONCE PER SIMULATED REMOTE APPEND across a sustained
 *      run, the shape a continuously-typing peer actually produces.
 */

export interface CaretResolutionSample {
  readonly size: number;
  readonly buildMs: number;
  readonly resolveCaretDeepMs: number;
  readonly resolveCaretShallowMs: number;
  readonly engineVisibleMs: number;
}

export interface SustainedCaretTrackingSample {
  readonly startSize: number;
  readonly appendCount: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly totalOverheadMs: number;
}

function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)] ?? 0;
}

function buildSequential(n: number): { readonly engine: Engine; readonly buildMs: number } {
  const engine = new Engine(1);
  const start = performance.now();
  for (let i = 0; i < n; i++) {
    engine.localInsert(i, 97 + (i % 26));
  }
  return { engine, buildMs: performance.now() - start };
}

/**
 * Mirrors `captureCaret`'s own real, POST-FIX implementation (client package, Phase 32 — see that
 * file's own PERFORMANCE NOTE) — ONE `engine.visible()` call shared by both anchor and focus
 * lookups, not two independent calls. Kept as a local, dependency-free copy since `packages/testkit`
 * has no reason to depend on `@collab-editor/client`.
 */
function resolveBothViaSharedVisibleSnapshot(
  engine: Engine,
  anchorVisibleIndex: number,
  focusVisibleIndex: number,
): { readonly anchor: Identifier | null; readonly focus: Identifier | null } {
  const visible = engine.visible();
  const resolve = (v: number): Identifier | null => (v <= 0 ? null : (visible[v - 1]?.id ?? null));
  return { anchor: resolve(anchorVisibleIndex), focus: resolve(focusVisibleIndex) };
}

/** Single-call costs at a given document size, built via sequential typing (the deepest-chain shape). */
export function measureCaretResolution(size: number, repeats = 50): CaretResolutionSample {
  const { engine, buildMs } = buildSequential(size);
  const lastId = engine.nodes[engine.nodes.length - 1]!.id;
  const firstId = engine.nodes[0]!.id;

  const t1 = performance.now();
  for (let i = 0; i < repeats; i++) engine.resolveCaret(lastId);
  const resolveCaretDeepMs = (performance.now() - t1) / repeats;

  const t2 = performance.now();
  for (let i = 0; i < repeats; i++) engine.resolveCaret(firstId);
  const resolveCaretShallowMs = (performance.now() - t2) / repeats;

  const t3 = performance.now();
  for (let i = 0; i < repeats; i++) engine.visible();
  const engineVisibleMs = (performance.now() - t3) / repeats;

  return { size, buildMs, resolveCaretDeepMs, resolveCaretShallowMs, engineVisibleMs };
}

/**
 * Simulates a sustained editing session: starting from a `startSize`-character document, applies
 * `appendCount` further single-character REMOTE appends (a peer continuing to type at the tip —
 * the deepest, worst-case anchor depth for THIS session's own local caret, parked at the
 * document's own end throughout), and after EACH one, runs the EXACT capture+restore cycle
 * `EditorView.tsx`'s `onRemoteOpsApplied` handler runs on every real remote batch. Reports the
 * per-cycle latency distribution (not a single aggregate average), matching `scaling.ts`'s own
 * p50/p95/max methodology.
 */
export function measureSustainedCaretTracking(
  startSize: number,
  appendCount: number,
): SustainedCaretTrackingSample {
  const { engine } = buildSequential(startSize);
  const localAnchorVis = startSize; // this session's own caret, parked at the end throughout

  const samplesMs: number[] = [];
  for (let i = 0; i < appendCount; i++) {
    engine.localInsert(engine.stats().visibleLength, 97 + (i % 26)); // simulates one remote append arriving
    const start = performance.now();
    const { anchor, focus } = resolveBothViaSharedVisibleSnapshot(engine, localAnchorVis, localAnchorVis);
    engine.resolveCaret(anchor);
    engine.resolveCaret(focus);
    samplesMs.push(performance.now() - start);
  }
  samplesMs.sort((a, b) => a - b);

  return {
    startSize,
    appendCount,
    p50Ms: percentile(samplesMs, 50),
    p95Ms: percentile(samplesMs, 95),
    maxMs: samplesMs[samplesMs.length - 1] ?? 0,
    totalOverheadMs: samplesMs.reduce((a, b) => a + b, 0),
  };
}
