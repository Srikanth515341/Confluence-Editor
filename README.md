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

🚧 **Phase 2 — the convergence test harness and CI gate.** The randomized
interleaving harness now exists and is proven against a deliberately wrong
toy engine — but the real `integrate()` algorithm doesn't exist yet
(Phase 3), so `pnpm test:convergence` currently and correctly **fails**.
This ordering is deliberate: the harness was built first, as a working
oracle, so the algorithm gets written against it rather than the other
way around.

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
ordinary `pnpm test` run (it has its own vitest config) because, right
now, it is **expected to fail**: `integrate()` — the algorithm that
actually makes replicas converge — doesn't exist yet (Phase 3). The
harness itself is proven correct against a deliberately-wrong toy engine
in `pnpm test`, so this isn't "the tests are broken" — it's "the harness
correctly reports that nothing has been built yet."

## Feature status

| Area                                    | Status                                                                |
| --------------------------------------- | --------------------------------------------------------------------- |
| Repository / toolchain / CI             | ✅ Phase 0                                                            |
| Convergence test harness (fuzz)         | ✅ Phase 2 (proven against a toy engine; real suite fails on purpose) |
| OBSEQ convergence engine                | 🔧 Phase 1 (data types + identifiers; no `integrate()` yet)           |
| Wire protocol                           | ⏳ not started                                                        |
| Server (coordinator, persistence, auth) | ⏳ not started                                                        |
| Client (editor binding, presence)       | ⏳ not started                                                        |
| Offline & reconciliation                | ⏳ not started                                                        |
| Permissions                             | ⏳ not started                                                        |
| Version history                         | ⏳ not started                                                        |

## License

MIT — see [`LICENSE`](./LICENSE).
