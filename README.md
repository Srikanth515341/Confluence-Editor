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

🚧 **Phase 3 — operation semantics and origin-bounded integration.** The
real `integrate()` algorithm (Engine Spec §4.3) now exists: Insert/Delete/
Undelete operations, causal readiness and buffering, and the origin-bounded
placement algorithm that resolves concurrent inserts without ever
consulting arrival order. `pnpm test:convergence` now **passes** — all six
required configurations converge across 10,000 seeds each, with zero
divergences and zero stranded operations.

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
ordinary `pnpm test` run (it has its own vitest config). As of Phase 3 it
**passes**: 60,000 total trials across C1–C6, zero divergences, zero
stranded (permanently-pending) operations.

## Feature status

| Area                                    | Status                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Repository / toolchain / CI             | ✅ Phase 0                                                                |
| Convergence test harness (fuzz)         | ✅ Phase 2 (now passing against the real engine, not just the toy engine) |
| OBSEQ convergence engine                | ✅ Phase 3 (integrate(), causal readiness/buffering, delete; no index yet) |
| Wire protocol                           | ⏳ not started                                                            |
| Server (coordinator, persistence, auth) | ⏳ not started                                                            |
| Client (editor binding, presence)       | ⏳ not started                                                            |
| Offline & reconciliation                | ⏳ not started                                                            |
| Permissions                             | ⏳ not started                                                            |
| Version history                         | ⏳ not started                                                            |

## License

MIT — see [`LICENSE`](./LICENSE).
