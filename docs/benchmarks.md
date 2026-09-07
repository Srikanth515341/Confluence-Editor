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

**Historical note (2026-09-05/06)**: the PositionIndex (Phase 19) and
block run-length encoding (Phase 20, `Block`/`canFollowInBlock`/
`decodeBlock`, `compression.ts`/`.bench.test.ts` above) were RETIRED
outright as part of the Fugue migration (see CLAUDE.md's "🛑 CRITICAL,
OPEN, UNRESOLVED FINDING" and Fugue-port entries) — a real, published,
peer-reviewed CRDT algorithm replaced the project's own hand-derived
YATA-family `integrate()` after three real convergence bugs (R0008-R0011)
were found in that family, the last of which reproduced with zero fault
injection under ordinary network latency variance alone. Both benchmark
sections above are kept per this project's own Rule 2 ("entries are never
removed" — Test Plan §2.3, applied here by extension: a benchmark
documents a real measurement that happened, not a currently-accurate
description of the live architecture) — they no longer describe how
`packages/engine` actually stores data, but the numbers themselves are
real and the lessons (block compression's tombstone-identity limitation,
O(log N) indexed lookups) remain historically accurate for the
architecture they measured. See the M8-a section below for the
Fugue-era replacement measurement.

# Final memory and apply-latency benchmark (Phase 25, M8-a, Fugue port)

Generated 2026-09-06, via a combination of the real
`packages/testkit/src/benchmark/finalMemoryLatency.bench.test.ts` (run
directly, not through `pnpm test:benchmark`'s aggregate command, so its
own real 300s-per-test timeout budget and progress could be watched) and
a temporary reduced-scale scratch rerun of the IDENTICAL fixture logic
(`buildGcEligibleMemoryDocument`, `packages/testkit/src/benchmark/
finalMemoryLatency.ts` — unchanged, real production benchmark source;
only the scratch TEST file's own scale constants differed, and that
scratch file has since been deleted, not merged).

## The full 100,000-op/10,000-visible scale is confirmed IMPRACTICAL to run to completion

This is the single most important finding of this measurement, and it is
recorded here explicitly rather than silently worked around. Running the
real, unmodified `finalMemoryLatency.bench.test.ts` at its documented
100,000-operation / 10,000-visible scale (the exact scenario Phases
19-21's own benchmarks used) was started and let run for **71 real
minutes**, during which the underlying Node process consumed **~64
minutes of CPU time** (confirmed via `Get-Process` — genuinely,
continuously CPU-bound, not hung/stalled) — and the FIRST of the file's
two tests (build the document, then run `collect()`) had still not
finished merely BUILDING the document. This was stopped (process killed)
rather than left to run for what a back-of-envelope extrapolation from
the observed cost suggests would be many additional hours.

**Root cause, confirmed by reading the fixture source directly, not
guessed**: `buildGcEligibleMemoryDocument` (unchanged production code)
builds its base document via `engine.localInsert(i, ...)` called
100,000 times, each one appending at the current end of the document —
precisely the "sequential typing" shape CLAUDE.md's own Fugue-port entry
already disclosed as O(N²) total cost (the real reference
implementation's `updateSize()` walks every ancestor on each `attach()`
call, and sequential appends build a maximally unbalanced, deep
right-child chain). **What this measurement adds to that disclosure**:
the real-world severity at N=100,000 is considerably worse than the
small-N data point previously on record (0.031ms/op at N=500 → 0.069ms/
op at N=4,000) would suggest by naive linear extrapolation — a benchmark
this project has run to completion at every prior phase (Phases 19-21,
pre-Fugue) is, under the current Fugue engine and at this exact scale,
not practically completable within a normal working session. This is
squarely the ALREADY-DISCLOSED, ALREADY-DEFERRED Fugue O(N²)
sequential-insertion characteristic (see CLAUDE.md's Fugue-port entry
and Open Item 3, the balanced-storage/O(log N) redesign) — not a new
algorithmic defect. It is disclosed here as its own data point because
"O(N²), disclosed" and "confirmed impractical to complete a standard
100k-op benchmark in a normal session" are different severities worth
distinguishing honestly.

## Reduced-scale measurements (real numbers, at a scale that actually completes)

Two runs, at different scales, chosen to answer different questions:

**N=4,000 / 400 visible, `global.gc` NOT exposed** (the same command-line
invocation `pnpm test:benchmark` itself uses — no `--expose-gc` flag
anywhere in this project's benchmark tooling, historically or now):

| Metric | Value |
|---|---:|
| Build + `collect()` wall time | 813.7s |
| Full two-test file wall time | 1,366.4s (~22.8 min) |
| `collect()` correctness | tombstones 3,600 → 0 (exact, asserted) |
| PRE-GC heapUsed delta | 3.07 MB |
| POST-GC heapUsed delta | 22.73 MB (**unreliable — see caveat below**) |
| `applyRemote()` apply-latency, 500 samples | p50=0.007ms p95=0.026ms p99=0.056ms |

**Caveat, disclosed rather than left to mislead**: `global.gc` was
unavailable in this run (`gc available: false`, logged by the benchmark
itself), so `measure()`'s `gc?.()` call was a no-op — `process.
memoryUsage().heapUsed` was read with NO forced garbage collection
pass. V8 does not reclaim memory synchronously at an arbitrary read
point without an explicit GC — so a POST-GC reading LARGER than the
PRE-GC reading here does NOT mean `collect()` failed to reduce the
engine's real footprint; it reflects transient allocation (from
`collect()`'s own fixpoint bookkeeping) that a real garbage-collection
pass would have reclaimed, measured before that pass had a chance to
run. `collect()`'s STRUCTURAL correctness is independently confirmed via
the exact tombstone-count assertion above (3,600 → 0), which does not
depend on heap measurement at all.

**N=500 / 50 visible, `NODE_OPTIONS=--expose-gc`** (a genuine, forced
GC comparison, run specifically to resolve the caveat above rather than
leave it unresolved):

| Metric | Value |
|---|---:|
| Full two-test file wall time | 3.75s |
| `collect()` correctness | tombstones 450 → 0 (exact, asserted) |
| PRE-GC heapUsed delta | 0.33 MB |
| POST-GC heapUsed delta | **0.14 MB** — genuinely lower, GC forced |
| `applyRemote()` apply-latency, 500 samples | p50=0.007ms p95=0.015ms p99=0.042ms |

With a real, forced GC pass, POST-GC memory is correctly LOWER than
PRE-GC — confirming `collect()` does genuinely reduce the engine's real
heap footprint, not merely its own internal node count, resolving the
N=4,000 run's own caveat directly rather than leaving it as an open
question.

**Apply-latency is consistent across both scales** (p50 ≈ 0.007ms at
both N=500 and N=4,000; p95/p99 both comfortably under a millisecond,
orders of magnitude under PRD M3's 16ms keystroke-latency budget and
Engine Spec §8.3's target) — the O(N²) cost this measurement's headline
finding is about lives entirely in Fugue's tree CONSTRUCTION
(`attach()`'s ancestor walk), not in `applyRemote()`'s own steady-state
per-operation cost once a document already exists, which remains cheap
at every scale actually measured.

## What this means for the 10MB/5ms targets (RFC §2.5, Engine Spec §8.3)

**Neither target can be honestly evaluated AT the original 100,000-op
scale under the current Fugue engine**, because that scale is not
practically reachable in a benchmark run, per the finding above — this
is recorded as an open gap, not silently resolved by substituting a
smaller number and reporting it as if it were the same measurement.
What CAN be said honestly: (1) apply-latency at every scale actually
measured (N=500, N=4,000) is dramatically under the 5ms/16ms budgets,
and nothing about Fugue's O(N²) cost lives on that path — so the latency
target is not expected to be at risk once the balanced-storage redesign
(Open Item 3) lands; (2) the 10MB memory target's status at true
100,000-op scale remains UNKNOWN under Fugue, not "passing" and not
"failing" — Phase 20's own pre-Fugue 45.60MB measurement (see above) is
NOT a valid stand-in, since it was against an entirely different
storage architecture (blocks/PositionIndex, both since retired). This
gap closes automatically once Open Item 3's balanced-storage/O(log N)
redesign lands, since that redesign is what makes a real 100,000-op
build tractable to run again at all.

# M8-e soak run (Phase 25, 2026-09-07) — real numbers, after Open Item 10's fix

Re-run of `soak.db.test.ts` (see that file's own header comment for the
full, disclosed 30,000-op/24h-10^6-op scope reduction) after wiring
`offlineWindowScheduler.ts`'s sweep into its main loop (Open Item 10).
Full command: `cd packages/server && npx dotenv -e ../../.env --
vitest run --config vitest.db.config.ts -t "M8-e"`. Real, migrated
Postgres instance; 4 simulated clients; deliberately zero undo-horizon
grace window (`undoHorizonMaxAgeMs: 0`, `undoHorizonMaxOpsPerReplica: 0`
— "no artificial grace window, this soak's own point is to actually
collect," per the file's own comment); the REAL default offline-window
reject timeout (`pendingRejectTimeoutMs: 30_000`, not shortened for this
test). Total wall time: 796.14s (~13.3 minutes).

## Result: PARTIAL PASS / PARTIAL FAIL — see `tests/regression/R0013` for the full account

Exactly one assertion failed in the entire run (a heap-growth smell
test, below); every other assertion — including the specific goal of
Open Item 10 — passed.

## Confirmed: `coordinator.engine.pending.length` reaches 0

Before this fix, the previous full M8-e run left 1,400 operations
permanently stuck in `coordinator.engine.pending` (reported 2026-09-06,
the finding that led to Critical Finding #2 / R0012). After wiring the
sweep in, every pending-related assertion in this run passed —
per-client `engine.pending.length === 0`, `coordinator.engine.pending.
length === 0`, and the final `auditDocument` call returning `result:
"ok"`. Item 10's own goal is confirmed achieved.

## GC cycles — tombstone ratio stays bounded, structural growth is linear (non-exponential)

| Op count | Frontier | Collected this cycle | Total elements | Tombstones | Tombstone ratio |
|---|---|---|---|---|---|
| 5,000 | 5,000 | 451 | 2,992 | 1,106 | 0.3697 |
| 10,000 | 9,833 | 492 | 5,825 | 2,122 | 0.3643 |
| 15,000 | 14,589 | 548 | 8,565 | 3,042 | 0.3552 |
| 20,000 | 19,251 | 589 | 11,138 | 3,953 | 0.3549 |
| 25,000 | 23,846 | 667 | 13,599 | 4,753 | 0.3495 |
| 30,000 | 28,395 | 585 | 16,109 | 5,622 | 0.3490 |

Tombstone ratio is flat-to-slightly-decreasing across the whole run
(0.3697 → 0.3490) — GC is demonstrably keeping tombstones bounded, well
under the test's own generous 0.5 ceiling. `totalElements` grows
roughly 2,500–2,700 per 5,000-op interval throughout — linear, not
exponential, at every checkpoint including the last one. Both of the
test's own tombstone-ratio and audit-result assertions passed at every
checkpoint (6/6 GC cycles, 3/3 periodic audits, plus the final audit —
all `result: "ok"`).

## NEW finding: R0012's rejection rate under this test's aggressive GC tuning is ~5.35% of all operations, not "rare"

1,605 of 30,000 operations (5.35%) were permanently rejected via
`OFFLINE_WINDOW_EXCEEDED` across the run (192 separate reject-batch
events, summed directly from the run's own log). This is the first real
measurement of how OFTEN the Critical Finding #2 / R0012 race (a live
client's ordinary keystroke anchoring to a since-server-collected node)
actually occurs, and the answer — under a deliberately zero undo-horizon
grace window — is: constantly, not rarely. **Important scope caveat**:
this soak's simulated clients are bare `Engine` instances, not real
`SyncClient`s, so none of these 1,605 rejections were ever revert-
corrected by Option 2 (2026-09-06) — every one is a permanent, un-
reverted local divergence in THIS harness specifically, not necessarily
representative of what a fleet of real, Option-2-equipped clients would
experience. Full account, including why this raises Open Item 9's
practical urgency: `tests/regression/R0013-2026-09-07-m8e-soak-heap-growth-and-high-frequency-r0012-rejections.json`.

## NEW, UNRESOLVED finding: heap usage more than doubled between the last two checkpoints

| Op count | Heap (MB) |
|---|---|
| 5,000 | 27.0 |
| 10,000 | 48.2 |
| 15,000 | 57.2 |
| 20,000 | 65.1 |
| 25,000 | 97.8 |
| 30,000 | **241.2** |

The test's own coarse smell test (`last < 4 × median of the first
half`) failed: 241.2MB vs. a bound of 192.8MB. This has NO corresponding
structural jump — `totalElements` grew only ~18% in that same interval
(13,599 → 16,109), in line with every other interval — so "more nodes"
alone does not explain it. The largest single offline-window-reject
burst in the whole run (132 operations across 4 sessions in one sweep
tick) occurred near the end of the run, close in time to this heap
spike — a plausible but UNCONFIRMED correlation. **Not chased further
tonight**, per the standing "flag and stop" instruction: `global.gc()`
is deliberately not forced per checkpoint in this test (already
disclosed in the file's own header as a coarse, non-exhaustive signal),
so ordinary unforced V8 allocator/GC-timing noise has not been ruled out
as an explanation, nor has a genuine leak been ruled in. Suggested next
steps (forced-GC re-measurement, map-size instrumentation, a re-run at
the real non-zero undo-horizon default, and a longer-term rebuild of
this soak's simulated clients on real `SyncClient` instances) are
recorded in the R0013 fixture linked above.

## Open Item 11 RESOLVED (2026-09-07, same day): the heap growth was unforced-GC noise, not a leak

Re-measured with `global.gc()` forced immediately before every heap
sample (`NODE_OPTIONS=--expose-gc`, `--pool=forks
--poolOptions.forks.singleFork` — the same technique M8-a's own
benchmark already established, and the same requirement for
`NODE_OPTIONS` to actually reach the vitest worker running this test),
plus per-checkpoint sampling of every long-lived, potentially-unbounded
`DocumentCoordinator` Map (`pendingFirstSeenAtMs`, `pendingOpOrigin`,
`watermarks`):

| Op count | Heap (MB), **forced GC** | Heap (MB), unforced (original run) | `pendingFirstSeenAtMs`/`pendingOpOrigin` size |
|---|---|---|---|
| 5,000 | 29.5 | 27.0 | 0 |
| 10,000 | 36.9 | 48.2 | 71 |
| 15,000 | 47.1 | 57.2 | 114 |
| 20,000 | 57.4 | 65.1 | 131 |
| 25,000 | 67.9 | 97.8 | 140 |
| 30,000 | **76.3** | **241.2** | 183 |

With forced GC, heap growth is smooth and tracks structural growth
closely (heap grew ~2.6x over the run; `totalElements` grew ~5.4x over
the same interval — sublinear, not runaway). The dramatic final-
checkpoint spike from the original (unforced) measurement simply does
not reproduce. `pendingFirstSeenAtMs`/`pendingOpOrigin` (the two maps
that track still-buffered operations awaiting the 30s offline-window
timeout) grew to 183 entries by the end — bounded, proportional to the
sustained rejection rate under this test's own aggressive config, never
creeping unbounded (both are pruned every sweep, confirmed by this data
— if pruning were broken, these would only ever grow, never plateau
relative to the ongoing rejection rate). `watermarks` stayed at 0
throughout — expected, since this soak's simulated clients never send a
real PING (the only thing that populates it); unrelated to the finding.

**Conclusion: CONFIRMED NOISE, not a genuine leak.** The full test suite
was re-run in this same pass and **passed completely** — 1/1, zero
assertion failures across pending-length, tombstone-ratio, and
heap-growth checks. Open Item 11 is now resolved.

## Step 4: R0012's rejection rate under the REAL, non-zero undo-horizon default (2026-09-07)

One additional comparison run swapped this test's own deliberately-zero
undo-horizon grace window for the REAL production default (RFC's own
`undoHorizonMaxAgeMs: 5 minutes`, `undoHorizonMaxOpsPerReplica: 200`),
then reverted back to the zero-grace config immediately after (the
zero-grace config is this test's own permanent, deliberate design —
"this soak's own point is to actually collect").

**Result: no material difference.** 1,632 of 30,000 operations (5.44%)
were rejected under the realistic default, essentially identical to the
5.35% measured under the zero-grace config. **Why**: Rule 7.3's
eligibility condition is an OR of two thresholds (age ≥ 5 minutes, OR
the deleting replica has minted ≥200 further operations) — at this
test's own synthetic throughput (~67 ops/sec across 4 replicas), the
200-further-ops condition is satisfied in roughly 12 real seconds,
making the nominal "5 minute" grace window practically irrelevant at
this op rate. **This is an important, honest nuance for Open Item 9's
own priority**: a genuinely busy, multi-user real editing session can
plausibly mint 200 operations per active replica within seconds to a
couple of minutes, not the full 5 minutes the RFC's own number might
suggest in isolation — meaning the EFFECTIVE grace window for active
documents is very often governed by the op-count condition, not the
wall-clock one, and the R0012 race's real-world frequency under active
editing may be much closer to this soak's own ~5.4% figure than a
naive "5-minute grace window sounds generous" reading would suggest.
This does not change Item 9's own deferred status (still correctly out
of scope for a same-session patch) but does inform how urgently it
should be picked up.

One additional, minor, non-blocking observation from this comparison
run, not chased further: the final GC cycle (at op 30,000) hit its
150ms fixpoint safety cap (`incomplete: true`, `collectedCount: 0`,
Phase 21's own wall-clock cap, `cumulativeIncompleteCount: 1`) — by
design this collects zero nodes rather than an unproven partial set
(Phase 21's own established correctness discipline), and the test's own
tombstone-ratio bound still held comfortably (0.376 at that checkpoint,
vs. the test's own 0.5 ceiling). Not investigated further — a single
incomplete cycle under the more work-heavy realistic-horizon config is
not itself surprising and does not indicate a regression.

## Status: M8-e now fully passing; Open Item 11 resolved

Both re-runs (the forced-GC re-measurement and the realistic-undo-
horizon comparison) passed completely — 1/1 each, zero assertion
failures. M8-e's own DoD claims (no audit failure, tombstone ratio
bounded, heap does not grow unboundedly, `pending` converges to 0) are
all now confirmed true. See `tests/regression/R0013` for the full,
updated investigation record.
