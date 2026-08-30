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

🚧 **Phase 10 — client sync layer.** `packages/client/src/sync/` is a
real, headless (no React, no DOM) browser-side connection manager:
`SyncClient` owns the socket lifecycle, the HELLO/WELCOME/SNAPSHOT/
SYNC_COMPLETE handshake, a 3-second heartbeat, an unacked-operation
queue keyed by origin stamp, and reconnection with full-jitter
exponential backoff (base 500 ms, factor 2, cap 30 s — the counter
resets only once a connection survives a full 60 seconds, so a
crash-looping server is never hammered at 500 ms forever). A sequence
gap (an OPS frame arriving ahead of what's expected) is applied
immediately regardless, tracked, and — if it persists 5 seconds —
resolved by closing the socket and letting the ordinary reconnect path
fetch a fresh SNAPSHOT, rather than building a second repair mechanism.
Two headless `SyncClient`s were run against a real server end to end:
1,000 alternating operations converge in under a second, and killing
the server mid-session, then restarting it, drives both clients through
`reconnecting` back to `synced` with a fresh replica id each, converging
again on new content. `packages/server`'s real HELLO → WELCOME →
SNAPSHOT → SYNC_COMPLETE handshake (Phase 9) and full Express + WebSocket
gateway (Phase 8) back all of this. Persistence, acks, auth, presence,
and server-side reconnection catch-up (CATCHUP) are still not built
(Phases 15-17, 23, 26-29, 31) — every reconnect gets a full fresh
snapshot, never a delta, and a real coordinator restart loses all
document content, not just the connection.

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
| Persistence, acks, auth, presence       | ⏳ not started (Phases 15-17, 26-29, 31)                                  |
| Client (editor binding, presence)       | ⏳ not started                                                             |
| Offline & reconciliation                | ⏳ not started                                                             |
| Permissions                             | ⏳ not started                                                             |
| Version history                         | ⏳ not started                                                             |

## License

MIT — see [`LICENSE`](./LICENSE).
