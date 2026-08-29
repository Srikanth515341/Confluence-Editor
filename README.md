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

🚧 **Phase 5 — the adversarial suite.** All 22 hand-constructed cases
from Test Plan §2.4 (ADV-01…ADV-22) now pass, each with a literal
expected output derived by hand rather than computed: concurrent inserts
at k=2/3/8, tombstone-anchored inserts, split/overlapping deletes,
reverse-causal delivery, empty-document and boundary edge cases,
backward-typing runs, combining marks and zero-width joiners (each
checked in every replica-id ordering, per Test Plan §2.4.1), and
block-compressible identifier runs.

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
combining mark racing an ordinary character for the same anchor,
tangled nested concurrent inserts, and more. Fast and deterministic, so
unlike the two suites above it also runs as part of the default
`pnpm test`.

## Feature status

| Area                                    | Status                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Repository / toolchain / CI             | ✅ Phase 0                                                                 |
| Convergence test harness (fuzz)         | ✅ Phase 2 (now passing against the real engine, not just the toy engine)  |
| OBSEQ convergence engine                | ✅ Phase 3 (integrate(), causal readiness/buffering, delete; no index yet) |
| Invariant assertions + property tests   | ✅ Phase 4 (I0–I9 runtime-checked; PROP-1..5 fast-check suites)            |
| Adversarial suite                       | ✅ Phase 5 (ADV-01..22, all replica-id orderings where required)           |
| Wire protocol                           | ⏳ not started                                                             |
| Server (coordinator, persistence, auth) | ⏳ not started                                                             |
| Client (editor binding, presence)       | ⏳ not started                                                             |
| Offline & reconciliation                | ⏳ not started                                                             |
| Permissions                             | ⏳ not started                                                             |
| Version history                         | ⏳ not started                                                             |

## License

MIT — see [`LICENSE`](./LICENSE).
