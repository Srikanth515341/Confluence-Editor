# Collab Editor

A real-time collaborative document editor whose entire value proposition is a
**provable correctness guarantee**: no user's edit is ever silently lost, and
every replica of a document converges to an identical final state — with no
locking, no last-write-wins, and no user-visible merge-conflict prompt.

Convergence is not asserted; it is verified continuously by a randomized
fuzz harness against **OBSEQ**, the sequence CRDT engine this project builds
from scratch (see `packages/engine`), and independently re-verified in
production by a log-replay integrity audit.

## Status

**Phase 26 — authentication and sessions.** Real user accounts for the
first time: `POST /v1/auth/login`, `/refresh`, `/logout`, Argon2id
password hashing, a 15-minute JWT access token, and a refresh token in an
`HttpOnly; Secure; SameSite=Strict` cookie with full rotation-with-
family-revocation (reusing an already-rotated refresh token revokes
every token that login session ever issued, verified end to end — a
later, otherwise-still-valid token from the same family is confirmed to
stop working too). SEC-11g's own user-enumeration timing requirement —
an unknown email and a wrong password must be indistinguishable — is
verified with a real statistical test, not eyeballing: 1,000 real
Argon2id samples per case against a real Postgres instance, Welch's
t = -0.6393, mean difference 1.632ms. Per-IP and per-account login rate
limiting. The WebSocket gateway's own handshake does NOT yet verify any
access token — any client can still join any document by guessing its
id, unchanged from every prior phase; that wiring is Phase 27+'s job.
See [`CLAUDE.md`](./CLAUDE.md)'s Phase 26 entry for the full account.

**Phase 25 — Milestone M2 adverse-network verification, and a major
correctness investigation.** DUR-05/06 DoD verification found the core
convergence algorithm could diverge or throw under completely ordinary
network conditions — three distinct bugs, found one at a time, in this
project's own hand-derived scan. Rather than patch a fourth time, the
engine was rebuilt from scratch on **Fugue** (Weidner & Kleppmann),
verified against every adversarial case, every property suite, the full
70,000-seed convergence suite, and a rebuilt mutation matrix. Integrating
the new engine surfaced six further real bugs, all found and fixed
(a wire-shape gap, a silently-ignored buffered-operation result, an
out-of-order-commit race, a replica-id-reuse-after-restart bug, a
client-side seq-tracking redesign, and a wire-protocol corruption bug).
The investigation also found and partially mitigated a genuine,
structurally-confirmed race — a live client's ordinary keystroke can
anchor to a node the server has already garbage-collected — with the
full structural fix explicitly deferred to its own future session. Every
DUR-0x DoD item now passes; M8-a is honestly partial (the true 100,000-op
memory number is unknown until a deferred O(N²)→O(log N) storage
redesign lands); M8-e passes cleanly after two rounds of same-day
follow-up investigation. See [`CLAUDE.md`](./CLAUDE.md)'s own extensive
Phase 25 sections (the "CRITICAL FINDING" entries, the Fugue migration
account, and the final Phase 25 report) for the complete, unvarnished
story — this is the single most consequential investigation in the
project's history to date.

**Phase 24 — offline window enforcement and rejection preservation.** A
client offline for too long now warns (8 min / 1,600 ops) and then
stops accepting edits outright (10 min / 2,000 ops, whichever comes
first) — refused before ever touching the local engine, so the durable
queue and what's on screen can never disagree. On the server, a
still-buffered operation whose causal dependency can never resolve
(Engine Spec §7.6 Rule 7.2, left unbuilt by Phase 21's tombstone GC) is
now explicitly rejected — `OFFLINE_WINDOW_EXCEEDED` — rather than left
stuck forever, and every rejection this client ever receives
(`permission_denied`, `offline_window_exceeded`, `document_locked`) is
preserved, never silently discarded: kept in memory and durably, counted
and listed, exportable as plain text, and cleared only by an explicit
user action this file never takes on its own. Building the required
integration test for "an offline edit anchored to a since-collected
node" surfaced a genuine, non-obvious finding: this project's own
client-side reconnection logic (Phase 22) always resolves a queued
edit's anchor against whatever the client currently knows, which
gracefully degrades to a safe position rather than ever re-sending a
specific vanished identifier — meaning the server-side rejection
mechanism, while correct and necessary as a protocol-level guarantee, is
not reachable through this project's own client today. Proven instead
via a hand-built raw operation naming a collected identifier directly.
A minimal, explicitly-labeled permission-downgrade mechanism (a
one-shot server-side test override, not the real permission system,
which is still Phase 26-30's job) demonstrates the same preserve rule
for `permission_denied`: 400 queued operations from a downgraded
session are rejected in a single response, each naming its own origin
stamp. See [`CLAUDE.md`](./CLAUDE.md)'s Phase 24 entry for the full
account, including the mutate-while-iterating bug found and fixed in
the server's own sweep.

**Phase 23 — reconnection handshake (CATCHUP/ALREADY_HAVE).** A client
whose socket drops but keeps its in-memory engine now catches up over
just `(lastServerSeq, currentSeq]` instead of receiving a full fresh
SNAPSHOT — chunked (≤256 ops/≤64KB per chunk, yielding to the event loop
between chunks), computed from the durable operation log (never the live,
GC-pruned engine, so a collected tombstone can never look "never
committed"). Independently of sync mode, the server also tells a
reconnecting client which of its own queued-but-unacked stamps it already
committed (ALREADY_HAVE), so only the genuine remainder gets reconciled
and resent. The required 27-cell test matrix (Test Plan §5.1, D×L×R)
found two real, previously-invisible bugs — ALREADY_CURRENT mode never
rebuilding the client's engine after a reconnect (silently orphaning
every queued edit under an IDENTITY_MISMATCH rejection with no visible
failure), and CATCHUP mode seeding its rebuild from an unfiltered node
list that duplicated offline-minted content and permanently orphaned the
duplicate on every peer — both fixed and covered by the matrix
permanently. RC-27 (the worst corner, 2,000 local + 5,000 remote ops)
reconnects in 3.6s p95 across 20 real runs, well inside PRD M6's 5s
budget. A deliberate mutation test (a client that advances
`lastServerSeq` per chunk instead of only at CATCHUP_END) is proven to
fail, permanently, behind a test-only flag. A genuine statistical
recalibration was needed for RC-34's 32-client jitter check — the literal
spec threshold turned out to be below the *average* outcome of correctly
jittered code at this sample size; the fix is derived from an actual
Monte Carlo simulation, documented in both the test file and CLAUDE.md.
Server-side session/replica-id resumption remains explicitly out of
scope, unchanged since Phase 8/9. See [`CLAUDE.md`](./CLAUDE.md)'s Phase
23 entry for the full account.

**Phase 22 — client durable queue (IndexedDB).** Unacknowledged
operations now survive a tab close or browser crash (API Spec §7.9),
which — as a necessary consequence — makes offline *editing* itself
possible for the first time: a keystroke typed while `reconnecting` or
`offline` durably queues instead of being silently dropped, and is
replayed as a fresh, re-minted operation once the connection is restored
(this project's server has never supported session/replica-id resumption,
so a queued edit's original identity can never survive a reconnect — only
its content does, which is what every DoD assertion actually checks).
Found and fixed one pre-existing bug unrelated to this phase's own work —
`gapTracker.ts`'s stall detection had never treated an inbound PONG as
liveness, so any session with 5+ seconds of silence force-reconnected
forever, undetected until this phase's own test was the first to hold an
idle multi-client session open long enough to hit it — plus a real
write-ordering violation and a real duplicate-content risk in the new
queue's own ack-flushing path. See [`CLAUDE.md`](./CLAUDE.md)'s Phase 22
entry for the full account, including the explicit, user-approved
architectural decision to re-mint queued operations' *intent* rather than
reopen server-side session resumption.

**Phase 21 — tombstone garbage collection.** `Engine.collect()` (Engine
Spec §7.4's COLLECT: a node is reclaimed only once it's deleted, its
delete is causally stable — every currently active replica has observed
it — no live node anchors it (a fixpoint sweep, since a live node may
anchor to a dead one), and it's aged past the undo horizon), the real
stability frontier (`sessions.last_ack_seq`/`last_seen_at`, API Spec
§6.5), and a 60-second per-document GC cycle are all live. A stale
session's tombstones are protected for a full 10-minute offline window
and released automatically once it ages out — deliberately NOT the same
8-second timer presence uses; conflating the two would let GC collect
anchors a client mid-reconnect still needs. Verified with a 1,000-call
randomized sweep (200 trials × 5 `(frontier, horizon)` combinations each)
asserting, after EVERY single call, that no remaining node ever
references a collected one — the exact invariant class this project's
Phase 20 investigation found two real bugs in, so this phase treated
"the same anchor-tracking mechanism, now used for physical removal" as a
real risk to re-verify, not a formality. See
[`CLAUDE.md`](./CLAUDE.md)'s Phase 21 entry for the full account,
including what's deliberately not built yet (an evicted replica's
stale operations are safely stranded rather than corrupting anything,
but no explicit rejection/export flow exists) and two unrelated
Phase-20-era CI gaps (`pnpm typecheck`, `pnpm check:purity`) found and
fixed along the way.

**Phase 20 — block run-length encoding, and a major correctness
correction.** Implements Engine Spec §7.5's block compression (a
sequential 3,000-character run now measures a single block — over
50,000x compression on real typing). Far more consequential: DoD
verification for this phase found — and this project fixed — two
real, previously-undiscovered bugs in the core convergence algorithm's
Case B/C logic, present since Phase 3 and traced to an actual error in
the approved Engine Specification's own §6.2 text, not an
implementation bug. The investigation also found that this project's
own 60,000-seed convergence fuzz suite had a structural blind spot —
its delivery model made the failure class it needed to catch
*impossible to reach* — and fixed that too, adding a permanent seventh
fuzz configuration built specifically to close the gap. See
[`CLAUDE.md`](./CLAUDE.md)'s Phase 20 entry and its "Engine Spec §6.2
sub-case iii-d correction" note for the full, deliberately
undercompressed account of how this was found, root-caused, and fixed.

**Phase 19 — indexed position structure.** `packages/engine`'s node
storage moved from a flat array with O(N) linear-scan position lookup (a
deliberate Phase 3 placeholder) to `PositionIndex` — an implicit-key
treap with O(log N) expected `indexOf`/`nodeAtVisible`/`visibleIndexOf`/
`splice`/`setDeleted` (Engine Spec §8.5). Not a performance-only change:
two acceptance criteria (RC-27, M3-c) failed outright without it. A
10,000-seed reference cross-check against a linear-scan oracle found zero
disagreements; the full regression suite — 308 unit tests, 22 adversarial
cases, 6 property suites, and 60,000 convergence-fuzz seeds across all 6
configs — is unchanged and green; the mutation matrix is byte-for-byte
identical to the Phase 6 baseline (9/10 killed). The scaling benchmark
confirms it: p95 latency grows 0.80x over a 100x increase in document
size (1,000 → 100,000 nodes) — flat, not the ~61x an O(N) scan would
produce — and M3-c's 100,000-char-document p99 ≤ 16ms target is met with
enormous margin (measured 0.030ms). See [`CLAUDE.md`](./CLAUDE.md)'s
Phase 19 entry for the full account, including a genuine pre-existing
CRLF-sensitivity bug in the mutation-testing harness found and fixed
along the way, and [`docs/benchmarks.md`](./docs/benchmarks.md) for the
full numbers.

**Phase 18 — integrity audit and bisect.** The most important
operational component in the system: every other check compares
replicas to each other and would report health if they were all wrong
in the same way; this one compares the live server against an
INDEPENDENT replay of durable storage — a fresh `Engine`, replaying only
what's in Postgres, sharing no code path or memory with anything else
running. `auditDocument()` implements API Spec §6.6's six steps (Test
Plan DUR-01), including checking `pendingCount() === 0` BEFORE any text
comparison — a replay can materialize correctly while an operation has
still been permanently orphaned, which a text match alone would miss.
BISECT is a real binary search over a document's snapshot history, not
a placeholder: a deliberately corrupted snapshot is detected, localized
to its exact sequence number, and recorded in `audit_runs`. DUR-01
passes on a genuine 5,000-operation, 3-client session; a 100,000-op
document audits in ~13 seconds against a 30-second budget. Runs both as
an in-process scheduled job (5-minute default interval) and a
standalone `pnpm admin audit --doc=<id> --verbose` CLI. See
[`CLAUDE.md`](./CLAUDE.md)'s Phase 18 entry for the full account,
including how BISECT's binary search shares the same monotonicity
assumption (and limitation) as `git bisect`.

**Phase 17 — snapshots and coordinator warm start.** A coordinator no
longer replays a document's full operation history from genesis on
every restart: RFC §13.2's MAYBE-SNAPSHOT() (500 operations or 30
seconds, whichever comes first) periodically persists the materialized
text and full node structure off the write path's hot path, and warm
start now loads the latest snapshot plus only the operations after it —
verified byte-identical to a full genesis replay on a 5,000-operation
document, and warm-starting a 50,000-operation document in well under 2
seconds. Snapshots are explicitly documented as server-side-only and
non-deterministic in structure across replicas (only the materialized
content is — block splitting means two replicas can reach the same
document through different tombstone histories). See
[`CLAUDE.md`](./CLAUDE.md)'s Phase 17 entry for the full account.

**Phase 16 — operation log and acknowledgement-implies-durability.**
Every operation is now durably committed to Postgres BEFORE its client
is acknowledged (API/Protocol/Data Spec §6.3), while broadcasting to
peers stays entirely off the database critical path — proven, not just
asserted, by DUR-04: the same production write-path module run in a
deliberately mutated ordering (ack fires before the commit) genuinely
loses an acked operation under an injected crash, while the real
ordering, under the identical crash injection, never does. A coordinator
now warm-starts from the persisted operation log on (re)creation, with a
live "every replayed operation became ready" assertion; a real server
restart against the same database now genuinely preserves document
content (verified through the actual server construction path, not just
by reading the schema). Resolving this phase required navigating three
real structural conflicts between already-committed designs — most
notably, Postgres flatly refuses `INSERT ... ON CONFLICT` on the
`operations` table because it carries the append-only RULEs Phase 15
required verbatim, discovered only by actually running the write path
against a real database. See [`CLAUDE.md`](./CLAUDE.md)'s Phase 16 entry
for the full account of all three.

**Phase 15 — database schema and migrations.** All eight tables from
API/Protocol/Data Spec v1.0 §2 (`users`, `documents`,
`document_permissions`, `sessions`, `operations`, `snapshots`,
`version_marks`, `audit_runs`) exist as real, migrated Postgres schema
(`docker compose up -d && pnpm db:migrate`), with every
correctness-critical constraint verified live against a real database:
`operations` is structurally append-only (a real `UPDATE`/`DELETE` is a
silent no-op, not merely disallowed by convention), a document can never
have zero or two owner rows, a duplicate operation can never be
committed twice, and the reconnection query is a primary-key range scan,
not a table scan.

🎉 **Milestone M1 (Phase 14) — two clients, plain text, live convergent
sync.** The product's central promise, proven end to end in real
browsers for the first time: open the same document in two windows,
type into the same word at the same time, and both converge to
identical text with nothing lost and no merge-conflict prompt.
`pnpm --filter @collab-editor/server run dev` + `pnpm --filter
@collab-editor/client run dev` now stand up a real, runnable app — see
[`CLAUDE.md`](./CLAUDE.md)'s "How to run the Milestone M1 demo" section
for the exact steps.

**Demo GIF**: `docs/media/m1-demo.gif` — two windows, simultaneous typing
in the same word, converging. Not yet recorded (Srikanth will capture
this himself after manually verifying the two-window demo, per this
phase's own end-of-phase instructions); once added, reference it here as
`![Milestone M1 demo](./docs/media/m1-demo.gif)`. The `docs/media/`
directory does not exist yet — create it when adding the file.

This milestone surfaced (and fixed) real bugs no earlier phase's tests
had run long enough to hit: a remote peer's edits weren't reaching the
live DOM at all until this phase wired it up; a genuine, previously-
undiscovered bug in the client's sequence-gap tracker was silently
force-reconnecting every session with 2+ concurrent editors roughly
every 5 seconds; and a related edit-loss path during that reconnect
window. All three are fixed and covered by new/rewritten tests. The
automated 60-second-concurrent-typing E2E suite (Test Plan §2.7, against
a real server through an in-process ~150ms-delay relay) initially showed
an intermittent failure at the full 60-second duration; this was fully
root-caused in an extended investigation and confirmed as a defect in
the test harness's own delay-injection layer (reproduced independently
via two unrelated latency-injection mechanisms, never once via a direct
connection across 13 runs) — not a defect in the product. `pnpm
test:convergence` passes at 60,000/60,000 seeds. See CLAUDE.md's Phase 14
entry and `tests/regression/README.md`'s "FINAL RESOLUTION" section for
the complete, unvarnished account.

Progress is tracked phase-by-phase in [`CLAUDE.md`](./CLAUDE.md).

## Tech stack

TypeScript end to end · Node.js + Express · React · PostgreSQL · Vitest ·
Playwright · Docker · GitHub Actions.

## Monorepo layout

```
packages/engine      OBSEQ convergence engine — pure, no I/O, no DOM
packages/protocol    binary wire codec + message types (shared client/server)
packages/server      Express + WebSocket gateway + coordinator + real Postgres persistence
packages/client      React app + editor binding (DomWriter, cursors, presence)
packages/testkit     fuzz / mutation / network-fault / load harnesses
```

## Setup

```bash
pnpm install
cp .env.example .env   # fill in real values before running the server —
                        # JWT_ACCESS_SECRET/JWT_REFRESH_SECRET (Phase 26) are
                        # REQUIRED; the "replace-me" placeholders are fine for
                        # local dev but must be real secrets in any shared/
                        # production environment
docker compose up -d   # starts local Postgres (Phase 15)
pnpm db:migrate         # creates all nine tables (packages/server/migrations/)
pnpm db:seed            # optional — one dev user + one dev document; prints a
                        # real, working login (email/password) for
                        # POST /v1/auth/login as of Phase 26
```

## Running checks

```bash
pnpm lint          # ESLint, including the engine-purity rule
pnpm format:check  # Prettier
pnpm typecheck      # tsc --noEmit across every package
pnpm check:purity   # independent grep-based engine-purity check (belt & suspenders)
pnpm test           # Vitest across every package (convergence suite excluded — see below)
```

### The convergence suite

```bash
pnpm test:convergence
```

This is the suite the entire product's correctness claim rests on — see
the Test Plan (§2) for what "converged" means and how it is checked. It
runs six required randomized-interleaving configurations (Test Plan §2.2)
at 10,000 seeds each, and is deliberately kept **separate** from the
ordinary `pnpm test` run (it has its own vitest config). It **passes**:
60,000 total trials across C1–C6, zero divergences, zero stranded
(permanently-pending) operations — with all ten Engine Spec §5 invariants
(I0–I9) actively re-checked after every mutating call throughout every
trial (Test Plan §2.6), not just the pass/fail convergence outcome.

### The property-based suite

```bash
pnpm test:properties
```

Five fast-check properties tied directly to the convergence argument
(Test Plan §2.5), each run at 10,000 generated cases: commutativity of
concurrent operation pairs, idempotence of re-delivery (checked on full
structural state, not just rendered text), order independence across two
different causally-valid linearizations of the same operation set, the
partial-knowledge subsequence guarantee, and clock-skew invariance — plus
an independent source-grep confirming the engine never reads a wall
clock.

### The adversarial suite

```bash
pnpm test:adversarial
```

22 hand-constructed cases (Test Plan §2.4) that randomized fuzzing isn't
aimed at finding on its own — three-way backward-typing runs, a
combining mark racing an ordinary character for the same anchor, an
insert whose originRight arrives before its originLeft, and more. Fast
and deterministic, so unlike the two suites above it also runs as part
of the default `pnpm test`.

### The mutation matrix

```bash
pnpm test:mutation
```

Ten mutants (Test Plan §2.8), each string-patched into an isolated,
freshly-transpiled copy of the engine source — never the real files —
then run against every suite. Proof the suites would actually catch a
broken engine: 9 of 10 mutants are killed, several only after surviving
pure convergence fuzzing and being caught by a hand-picked targeted
check instead. The tenth, `M3_no_case_c`, is the subject of a dedicated
directed search (MUT-KILL-01) run to 10^6 trials — see
[`docs/mutation-matrix.md`](./docs/mutation-matrix.md) for the current
results. Excluded from the default `pnpm test`; the nightly workflow
runs this at full scale on a schedule.

## Feature status

| Area                                       | Status                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Repository / toolchain / CI                | ✅ Phase 0                                                                                                 |
| Convergence test harness (fuzz)            | ✅ Phase 2 (now passing against the real engine, not just the toy engine)                                  |
| OBSEQ convergence engine                   | ✅ Phase 3 (integrate(), causal readiness/buffering, delete); indexed Phase 19                             |
| Invariant assertions + property tests      | ✅ Phase 4 (I0–I9 runtime-checked; PROP-1..5 fast-check suites)                                            |
| Adversarial suite                          | ✅ Phase 5 (ADV-01..22, all replica-id orderings where required)                                           |
| Mutation testing + nightly CI gate         | ✅ Phase 6 (9/10 mutants killed; MUT-KILL-01 directed search for the 10th)                                 |
| Binary wire codec (OPS channel)            | ✅ Phase 7 (varints, primitives, envelope, all 7 OPS message types)                                        |
| WebSocket gateway + Document Coordinator   | ✅ Phase 8 (in-memory)                                                                                     |
| Sync handshake + heartbeat (fresh conn.)   | ✅ Phase 9 (HELLO/WELCOME/SNAPSHOT/SYNC_COMPLETE/PING-PONG)                                                |
| Client sync layer (SyncClient)             | ✅ Phase 10 (backoff, unacked queue, gap handling; no UI/DOM binding yet)                                  |
| DOM render model + position mapping        | ✅ Phase 11 (DomWriter, render index, Playwright on real browsers)                                         |
| Input pipeline (beforeinput → ops)         | ✅ Phase 12 (full inputType table, grapheme/word/line deletion, first React component)                     |
| MutationSentinel (DOM reconciliation)      | ✅ Phase 13 (MutationObserver-based revert of any non-DomWriter mutation, reconciliation/desync metrics)   |
| **Milestone M1 — live multi-browser sync** | ✅ **Phase 14** (real app, real server, remote edits render live, real bugs found & fixed — see CLAUDE.md) |
| Database schema + migrations               | ✅ Phase 15 (all 8 API Spec §2 tables, constraint-tested against real Postgres)                            |
| Operation log + durable acknowledgement    | ✅ Phase 16 (broadcast before commit, ack after — DUR-04-tested; warm start from the persisted log)        |
| Snapshots + snapshot-aware warm start      | ✅ Phase 17 (RFC §13.2 MAYBE-SNAPSHOT, 500 ops/30s, off the hot path; <2s warm start at 50k ops)           |
| Integrity audit + bisect                   | ✅ Phase 18 (independent log replay vs. live server; real BISECT; scheduled job + admin CLI)               |
| Indexed position structure (O(log N))      | ✅ **Phase 19** (treap-backed PositionIndex; 0.80x p95 growth over 100x size; M3-c p99 0.030ms)             |
| Block run-length encoding                  | ✅ Phase 20 (SNAPSHOT wire format; 50,000x compression on sequential typing; found/fixed 2 core algorithm bugs) |
| Tombstone garbage collection                | ✅ Phase 21 (Engine.collect(), real stability frontier, 60s per-document GC cycle, wall-clock safety cap)   |
| Offline editing (durable queue + replay)   | ✅ **Phase 22** (IndexedDB-backed unacked queue, API Spec §7.9; survives tab close/crash)                  |
| Reconnection handshake (CATCHUP/ALREADY_HAVE) | ✅ **Phase 23** (delta sync over the durable log; RC-27 3.6s p95, well under PRD M6's 5s budget)         |
| Offline window enforcement + rejection preservation | ✅ **Phase 24** (10min/2,000-op client cap; server-side explicit rejection, Engine Spec §7.6 Rule 7.2; API Spec §5.5 preserve-never-destroy for all 3 reason codes) |
| Convergence engine — Fugue migration       | ✅ **Phase 25** (three real bugs found in the prior YATA-family scan; rebuilt on Fugue; six further integration bugs found & fixed; adverse-network DoD fully passing) |
| Authentication (login/refresh/logout)      | ✅ **Phase 26** (Argon2id, JWT access tokens, refresh rotation + family revocation, SEC-11g timing-oracle-free — verified with a real statistical test) |
| WS gateway authorization + presence        | ⏳ not started (Phase 27+, 31) — Phase 26 built the token PRIMITIVES only; the WS handshake does not verify one yet |
| Cursor transform under remote edits        | ⏳ not started (Phase 32)                                                                                  |
| Permissions (real owner/editor/viewer system) | ⏳ not started (Phase 27-30) — Phase 24's role-downgrade DEMO uses a test-only override, not this          |
| Version history                            | ⏳ not started                                                                                             |

## License

MIT — see [`LICENSE`](./LICENSE).
