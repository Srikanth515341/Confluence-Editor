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
