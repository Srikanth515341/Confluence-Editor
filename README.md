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

🚧 **Phase 11 — render model and position mapping.**
`packages/client/src/binding/` implements the bidirectional mapping
between the engine's visible (Unicode scalar) indices and real DOM
positions — the exact unit mismatch that breaks on the first emoji if
you reach for `String.length`. `DomWriter` is the sole module allowed
to touch the editor subtree, maintaining a render index of runs (each
backed by one DOM Text node, capped at 512 scalars) with incremental
maintenance on insert/delete and a dev-build assertion that fires if
the index and the DOM ever disagree. Verified against 7 Unicode
fixtures (ASCII, diacritics, an astral emoji, a ZWJ family sequence,
regional-indicator flags, Devanagari matras, Hangul) — round-tripping
every visible position, confirming the caret never lands inside a
surrogate pair, and confirming a real Phase-3 `Engine` agrees on what
"visible index" means. This phase also stood up **Playwright**, the
first real-browser test infrastructure in this project: the same
mapping is exercised against real Chromium AND real WebKit (not
jsdom, which can't reproduce real Selection/Range quirks), including
the well-known case where the two browsers disagree about what an
empty, focused contenteditable's DOM looks like. Input handling, the
sentinel, and cursor transformation under remote edits are still not
built (Phases 12, 13, 32) — nothing connects a keystroke to `DomWriter`
yet.

Progress is tracked phase-by-phase in [`CLAUDE.md`](./CLAUDE.md).

## Tech stack

TypeScript end to end · Node.js + Express · React · PostgreSQL · Vitest ·
Playwright · Docker · GitHub Actions.

## Monorepo layout

```
packages/engine      OBSEQ convergence engine — pure, no I/O, no DOM
packages/protocol    binary wire codec + message types (shared client/server)
packages/server      Express + WebSocket gateway + coordinator + persistence
packages/client      React app + editor binding (DomWriter, cursors, presence)
packages/testkit     fuzz / mutation / network-fault / load harnesses
```

## Setup

```bash
pnpm install
cp .env.example .env   # fill in real values before running the server
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

| Area                                    | Status                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Repository / toolchain / CI             | ✅ Phase 0                                                                 |
| Convergence test harness (fuzz)         | ✅ Phase 2 (now passing against the real engine, not just the toy engine)  |
| OBSEQ convergence engine                | ✅ Phase 3 (integrate(), causal readiness/buffering, delete; no index yet) |
| Invariant assertions + property tests   | ✅ Phase 4 (I0–I9 runtime-checked; PROP-1..5 fast-check suites)            |
| Adversarial suite                       | ✅ Phase 5 (ADV-01..22, all replica-id orderings where required)           |
| Mutation testing + nightly CI gate      | ✅ Phase 6 (9/10 mutants killed; MUT-KILL-01 directed search for the 10th) |
| Binary wire codec (OPS channel)         | ✅ Phase 7 (varints, primitives, envelope, all 7 OPS message types)       |
| WebSocket gateway + Document Coordinator| ✅ Phase 8 (in-memory)                                                     |
| Sync handshake + heartbeat (fresh conn.)| ✅ Phase 9 (HELLO/WELCOME/SNAPSHOT/SYNC_COMPLETE/PING-PONG; CATCHUP not built)|
| Client sync layer (SyncClient)          | ✅ Phase 10 (backoff, unacked queue, gap handling; no UI/DOM binding yet) |
| DOM render model + position mapping     | ✅ Phase 11 (DomWriter, render index, Playwright on real browsers)       |
| Persistence, acks, auth, presence       | ⏳ not started (Phases 15-17, 26-29, 31)                                  |
| Client (editor binding, presence)       | ⏳ not started                                                             |
| Offline & reconciliation                | ⏳ not started                                                             |
| Permissions                             | ⏳ not started                                                             |
| Version history                         | ⏳ not started                                                             |

## License

MIT — see [`LICENSE`](./LICENSE).
