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

🚧 **Phase 1 — engine core: nodes, identifiers, and the clock.** The
OBSEQ engine's data types (`Identifier`, `Node`) and identifier generation
(`mint()`/`observe()`, Engine Spec §3) now exist and are unit-tested. The
actual `integrate()` algorithm — the part that makes two replicas converge —
is not built yet; that's Phase 3.

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
pnpm test           # Vitest across every package
```

### The convergence suite

Not yet built (arrives with the engine in Phase 1+). Once it exists, running
it in isolation will be:

```bash
pnpm --filter @collab-editor/testkit run fuzz
```

This is the suite the entire product's correctness claim rests on — see the
Test Plan (§2) for what "converged" means and how it is checked.

## Feature status

| Area                                    | Status                                                      |
| --------------------------------------- | ----------------------------------------------------------- |
| Repository / toolchain / CI             | ✅ Phase 0                                                  |
| OBSEQ convergence engine                | 🔧 Phase 1 (data types + identifiers; no `integrate()` yet) |
| Wire protocol                           | ⏳ not started                                              |
| Server (coordinator, persistence, auth) | ⏳ not started                                              |
| Client (editor binding, presence)       | ⏳ not started                                              |
| Offline & reconciliation                | ⏳ not started                                              |
| Permissions                             | ⏳ not started                                              |
| Version history                         | ⏳ not started                                              |

## License

MIT — see [`LICENSE`](./LICENSE).
