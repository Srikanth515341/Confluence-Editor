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
cp .env.example .env   # fill in real values before running the server
docker compose up -d   # starts local Postgres (Phase 15)
pnpm db:migrate         # creates all eight tables (packages/server/migrations/)
pnpm db:seed            # optional — one dev user + one dev document
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
| OBSEQ convergence engine                   | ✅ Phase 3 (integrate(), causal readiness/buffering, delete; no index yet)                                 |
| Invariant assertions + property tests      | ✅ Phase 4 (I0–I9 runtime-checked; PROP-1..5 fast-check suites)                                            |
| Adversarial suite                          | ✅ Phase 5 (ADV-01..22, all replica-id orderings where required)                                           |
| Mutation testing + nightly CI gate         | ✅ Phase 6 (9/10 mutants killed; MUT-KILL-01 directed search for the 10th)                                 |
| Binary wire codec (OPS channel)            | ✅ Phase 7 (varints, primitives, envelope, all 7 OPS message types)                                        |
| WebSocket gateway + Document Coordinator   | ✅ Phase 8 (in-memory)                                                                                     |
| Sync handshake + heartbeat (fresh conn.)   | ✅ Phase 9 (HELLO/WELCOME/SNAPSHOT/SYNC_COMPLETE/PING-PONG; CATCHUP not built)                             |
| Client sync layer (SyncClient)             | ✅ Phase 10 (backoff, unacked queue, gap handling; no UI/DOM binding yet)                                  |
| DOM render model + position mapping        | ✅ Phase 11 (DomWriter, render index, Playwright on real browsers)                                         |
| Input pipeline (beforeinput → ops)         | ✅ Phase 12 (full inputType table, grapheme/word/line deletion, first React component)                     |
| MutationSentinel (DOM reconciliation)      | ✅ Phase 13 (MutationObserver-based revert of any non-DomWriter mutation, reconciliation/desync metrics)   |
| **Milestone M1 — live multi-browser sync** | ✅ **Phase 14** (real app, real server, remote edits render live, real bugs found & fixed — see CLAUDE.md) |
| Database schema + migrations               | ✅ Phase 15 (all 8 API Spec §2 tables, constraint-tested against real Postgres)                            |
| Operation log + durable acknowledgement    | ✅ **Phase 16** (broadcast before commit, ack after — DUR-04-tested; warm start from the persisted log)    |
| Snapshotting, auth, presence               | ⏳ not started (Phase 17, 26-29, 31)                                                                       |
| Cursor transform under remote edits        | ⏳ not started (Phase 32)                                                                                  |
| Offline editing (queue-and-replay)         | ⏳ not started (Phase 22)                                                                                  |
| Permissions                                | ⏳ not started                                                                                             |
| Version history                            | ⏳ not started                                                                                             |

## License

MIT — see [`LICENSE`](./LICENSE).
