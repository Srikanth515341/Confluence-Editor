# PositionIndex scaling benchmark (Phase 19)

Generated: 2026-09-01, via `pnpm test:benchmark`
(`packages/testkit/src/benchmark/scaling.bench.test.ts`, gated out of the
default `pnpm test` — same reasoning as convergence/properties/mutation).

## Methodology

For each target size N, a document of N characters is built via N
sequential end-appends (`Engine.localInsert` at the end each time — the
"someone typed this document" shape, and the shape Engine Spec §8.3/M3-c's
own "100,000-char document" scenario describes). Then 500 FURTHER
`localInsert()` calls are performed at uniformly random VISIBLE positions
across the now-large document, each timed individually via
`performance.now()`. p50/p95/p99 are computed from those 500 individual
per-call samples, not from a single aggregate average — deliberately
random-position, not more appends, since an append-only workload never
exercises `indexOfOrigin`'s worst case (a lookup near the front of a huge
structure) the way a random-position insert does, and that is exactly what
distinguishes O(log N) from the pre-Phase-19 O(N) linear scan.

Deterministic (seeded PRNG, seed = N for each size), reproducible via
`pnpm test:benchmark`. Source: `packages/testkit/src/benchmark/scaling.ts`.

## Results

| N (nodes) | build time | p50 | p95 | p99 | max |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 7.7ms | 0.006ms | 0.021ms | 0.093ms | 1.893ms |
| 32,000 | 83.0ms | 0.006ms | 0.014ms | 0.022ms | 0.038ms |
| 100,000 | 257.6ms | 0.007ms | 0.017ms | 0.030ms | 0.098ms |

**p95 growth, 1,000 → 100,000 nodes (a 100x size increase): 0.80x** — i.e.
p95 latency at 100,000 nodes is not merely sub-linear, it is flat-to-slightly-
lower than at 1,000 nodes, well inside the noise band of a single-digit-
microsecond measurement. This is the expected signature of O(log N)
lookups: log2(100,000)/log2(1,000) ≈ 1.67x is the theoretical growth
factor; anything under roughly 10x is utterly incompatible with the
pre-Phase-19 O(N) linear scan, which this phase's own brief cites as
having measured **61x** growth over comparable scale (Engine Spec §8.3).

**M3-c (Engine Spec §8.3 / RFC §10.4): 100,000-char document, local
insert p99 ≤ 16ms — PASSES with enormous margin.** Measured p99 at
100,000 nodes is **0.030ms**, roughly 533x under the 16ms budget.

**RC-27 (RFC §10.4): previously missed M6 by 3.6x (12.3s vs. a 1.1s
target) under an O(N) implementation.** These per-operation numbers (tens
of microseconds, even at 100,000 nodes) make an aggregate multi-second
budget for any realistic workload trivially achievable — the bottleneck
RC-27 was measuring is gone; nothing approaching multi-second latency
remains on this path.

Build time itself (not a DoD target, reported for context) grows
consistently with the expected O(N log N) total cost of N sequential
O(log N) inserts: 7.7ms → 83.0ms (10.8x for 32x more work) → 257.6ms
(3.1x more for 3.125x more nodes) — no super-linear blowup at any
measured scale.

## What this does NOT measure

This benchmark exercises `PositionIndex` in isolation via `localInsert`'s
random-position path — it does not simulate concurrent multi-replica
integration load (that is what `pnpm test:convergence`'s 60,000-seed fuzz
suite is for; see its own results in this phase's CLAUDE.md entry) and it
does not measure `integrate()`'s Case A/B/C scan-window cost, which Engine
Spec §8.2 already measured as effectively constant (p50=0, p95=4, p99=9
nodes) and which this phase deliberately left un-indexed per its own
"index what actually costs" instruction.

# Block encoding compression benchmark (Phase 20)

Generated via `pnpm test:benchmark`
(`packages/testkit/src/benchmark/compression.bench.test.ts`, same gating
as the scaling benchmark above). Source: `packages/testkit/src/benchmark/
compression.ts`.

## Results — Engine Spec §7.5's three named workloads

| Workload | Ops | Visible | Blocks | Compression ratio |
|---|---:|---:|---:|---:|
| Pure sequential typing | 50,000 | 50,000 | 1 | **50,000x** (target: >1000x — PASSES) |
| Realistic prose (2% reposition, 8% backspace) | 50,000 | 40,974 | 8,977 | **5.01x** (target: >4x — PASSES) |
| Random-position editing | 10,000 | ~10,000 | 9,999 | **1.000x** (recorded, not asserted — matches the ≈1x the spec itself predicts) |

Pure sequential typing collapses to a SINGLE block regardless of length —
every character is a genuine Definition 7.5 continuation of the one
before it. Realistic prose still compresses meaningfully (5x) because
92% of characters are still sequential appends; the 8% backspace rate
fragments blocks at each correction point but doesn't prevent the
SURROUNDING runs from compressing. Random-position editing — every
insert landing at an unrelated point — compresses at essentially 1:1, the
theoretical floor, exactly as Engine Spec §7.5 itself predicts for this
workload ("recorded, not asserted").

## M8-b: replica memory re-measurement

RFC §2.5 measured 12.9 MB (pre-blocks) for a 100,000-operation / ~10,000-
visible document, against a 10 MB target.

**Measured, post-blocks: 45.60 MB heapUsed delta** (100,000 ops / 10,000
visible / **90,159 blocks**) — WORSE than the pre-blocks figure, not
better, for this specific scenario. Root cause, verified directly (see
`compression.ts`'s own header comment for the full account): the
document is built via realistic sequential-typing bursts (which DO
compress well, matching the workloads above) and then brought down to
10,000 visible characters via CONTIGUOUS range deletes — but
`Engine.localDelete(pos, count)` issues `count` SEPARATE
`DeleteOperation`s (Engine Spec §4.1 — a delete is single-target only),
each freshly minted with its OWN identity. Definition 7.5's condition 4
requires a block's members to share `deletedBy` — but every character in
ONE "select a paragraph, press Delete" user action gets a DIFFERENT
`deletedBy`, so those ~90,000 tombstones can essentially never merge into
blocks even though they were deleted together and sit contiguously
(measured: ~90,000 tombstones landed in ~80,000+ separate one-node
blocks). This is a genuine, spec-consistent limitation of block
compression for TOMBSTONES specifically, not a bug — visible text
compresses dramatically (see the table above), but a heavily-tombstoned
document's memory is dominated by tombstones compression barely touches.
Per Phase 20's own DoD: this is recorded as Test Plan C1 UNRESOLVED, not
silently accepted — Phase 21's GC (real physical removal of
causally-stable tombstones) is the next, and likely only real, lever for
this specific scenario; compression cannot fix what is fundamentally an
operation-identity problem, only removal can.

An earlier attempt at this fixture used random-position single-character
edits throughout and measured a degenerate 100,000 ops -> 100,000 blocks
(no compression happened AT ALL, not even for the surviving visible
text) — not a bug, just proof that fixture wasn't exercising anything
representative; the current fixture (sequential bursts, then contiguous
range deletes) is the fair, representative one, and the number above is
real.
