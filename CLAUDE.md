# CLAUDE.md — project memory for this codebase

This file must always be current. It is written so that a brand-new Claude
Code chat, given only this file, can correctly describe the project's state
and continue building it.

## Project overview

A real-time collaborative document editor. The core technical
differentiator: a **mathematically provable convergence guarantee** — any
two replicas that have received the same set of operations converge to a
byte-identical document, regardless of network delay, duplication, or
reorder, with no locking and no user-visible merge-conflict prompt. This is
implemented as **OBSEQ** (Origin-Bounded SEQuence), a sequence CRDT with
stable Lamport identifiers, chosen over Operational Transformation after a
design spike showed the textbook OT transform function diverges 14.5%+ of
the time at 3+ replicas.

Full design authority lives in six approved documents (not in this repo —
they are pasted into context at the start of each Claude Code session):
PRD v1.0 · RFC v1.0 · Engine Specification v1.0 (OBSEQ) · API/Protocol/Data
Design Spec v1.0 · Test Plan v1.0 · Rollout & Runbook v1.0. This repo is
built strictly against those documents via the Implementation Plan's
41-phase roadmap (document #7).

## Tech stack

TypeScript end to end (strict mode) · Node.js + Express · React · PostgreSQL
· Vitest (unit/property/fuzz) · Playwright (multi-browser E2E) · Docker ·
GitHub Actions (CI).

## Current architecture state

Monorepo (pnpm workspaces), five packages, all currently placeholder
scaffolding only — no feature code exists yet:

```
packages/engine      @collab-editor/engine    — OBSEQ. Phase 1 built the data types
                                                 (Identifier, Node), MINT/OBSERVE,
                                                 isClusterContinuing, and the Engine
                                                 class shell (visible/text/stats; no
                                                 integrate() yet). Pure: no DOM, no
                                                 network, no storage, no clock. Only
                                                 package whose tsconfig excludes "DOM"
                                                 from lib.
packages/protocol    @collab-editor/protocol  — binary wire codec + message types,
                                                 shared by client and server.
packages/server      @collab-editor/server    — Express + WebSocket gateway,
                                                 Document Coordinator, persistence.
                                                 Depends on engine + protocol.
packages/client       @collab-editor/client   — React app + editor binding
                                                 (DomWriter, input pipeline, presence).
                                                 The only package with DOM lib types.
                                                 Depends on engine + protocol.
packages/testkit     @collab-editor/testkit   — fuzz harness, mutation-testing
                                                 harness, network-fault proxy, load
                                                 harness. Depends on engine.
```

Each package currently exports one placeholder constant and has one trivial
passing test, purely to prove the toolchain (build/lint/typecheck/test)
works end-to-end across the whole workspace before any real code is written.

## Completed phases

- **Phase 0** — Repository and process foundation. pnpm workspace scaffolded
  (5 packages per the layout above); TypeScript strict mode; ESLint flat
  config with a dedicated engine-purity rule scoped to `packages/engine/**`
  (no DOM globals, no `Date.now`/`performance.now`/`new Date`, no
  fs/http/ws/react imports); an independent CI-grep purity check
  (`scripts/check-engine-purity.mjs`) as a second, structurally different
  enforcement mechanism; Prettier; Vitest wired across all packages; GitHub
  Actions CI (lint → format:check → typecheck → check:purity → test);
  `.env.example`; MIT LICENSE. One commit on `main`.
- **Phase 1** — Engine core: nodes, identifiers, and the clock. In
  `packages/engine/src`: `identifier.ts` (`Identifier`, `compareIds` — Engine
  Spec Definition 3.2); `node.ts` (the seven-field `Node` type, Engine Spec
  §2.2); `operation.ts` (a minimal placeholder type, fully defined in Phase
  3); `grapheme.ts` (`isClusterContinuing`, API Spec §7.4.4); `engine.ts`
  (the `Engine` class shell: `replicaId`, private `clock`, `nodes`,
  `byKey`, `applied`, `pending`, plus `mint()`/`observe()`/`visible()`/
  `text()`/`stats()` — no `integrate()` yet). 23 unit tests covering
  `compareIds`'s total-order properties (irreflexive/antisymmetric/
  transitive, 1000 generated cases each via a seeded `mulberry32` PRNG),
  `mint()`/`observe()` independence (including the exact §3.4 regression
  shape), cross-replica identifier distinctness, and `isClusterContinuing`
  over the required Unicode fixture set. No operations, no `integrate()`,
  no undo, no GC, no index yet — see "What is NOT yet built" below.

## Current phase in progress

None — Phase 1 complete, awaiting Phase 2.

## What is explicitly NOT yet built

OBSEQ's `integrate()` algorithm and the Insert/Delete/Undelete operation
records (Phase 3); the indexed position structure (Phase 19); garbage
collection (Phase 21); undo/redo (Phase 36); block run-length encoding
(later, alongside GC). No wire protocol; no server (no Express app, no
WebSocket gateway, no database schema, no auth); no client (no React app,
no editor binding, no DOM rendering); no persistence; no permissions; no
offline/reconciliation logic; no presence; no version history; no
fuzz/mutation harnesses in `packages/testkit` yet; no Docker setup; no
deployed environment.

## Key technical decisions with source citations

- **Identifier density comes from origin anchoring, not identifier value.**
  `compareIds` is plain lexicographic order on `(counter, replica)` and the
  identifiers themselves are NOT dense — OBSEQ does not need Logoot/LSEQ-style
  variable-length dense identifiers, because a node's position is determined
  by its `originLeft`/`originRight` plus the (Phase 3) `INTEGRATE` rule, not
  by where its identifier value falls numerically. Insertion between any two
  adjacent nodes is always possible by anchoring to their identifiers,
  regardless of the numeric relationship between counters. This is what
  keeps identifiers fixed-size (two integers) forever, which is a
  precondition for the block run-length encoding planned alongside GC. —
  Engine Spec §3.3.
- **`mint()` and `observe()` are separate methods and must never be merged.**
  A prior implementation combined them into one tick-and-merge routine,
  which double-advanced the clock on every local operation. Every
  correctness test still passed — identifiers stayed unique and totally
  ordered — but consecutive-counter block encoding silently produced 1.0x
  compression instead of a measured 20,000x, because block runs require
  literally-consecutive counters. This is Invariant I0, and it is the
  reason `Engine.mint()` carries a long docstring rather than a short one. —
  Engine Spec §3.4, §7.5 Definition 7.5 condition 2.
- **Engine purity is enforced two independent ways**, not one: an ESLint
  rule (`eslint.config.js`, override for `packages/engine/**`) and a separate
  grep-based Node script (`scripts/check-engine-purity.mjs`) run in CI. Two
  independent checks that must both pass is harder to silently break than
  one. — PRD NG-3, RFC §4.4, Engine Spec §5 (I0, C9).
- **`packages/engine`'s tsconfig has no `"DOM"` in `lib`.** This makes
  `document`/`window` fail to type-check as undefined globals, not just as a
  lint violation — a second, independent layer at the type-checker level.
  `packages/client` is the only package with DOM lib types, since it owns
  the DomWriter chokepoint. — API Spec §7.1, §11.5.
- **No project-level TypeScript references between packages in Phase 0.**
  Cross-package imports (e.g. server → engine) resolve via pnpm workspace
  linking, not `tsc -b` composite builds. Revisit if this becomes a build
  bottleneck once real cross-package code exists.
- **`@typescript-eslint/no-explicit-any` is `"warn"`, not `"error"`.** The
  project rule requires bare `any` to carry an inline justification comment
  (§0.1 of the Implementation Plan); ESLint cannot verify a comment's
  presence, so this is enforced by code review, not tooling.
- **Git**: Phase 0 is committed directly to `main` (the one documented
  exception to "every phase gets its own branch"). Every phase from Phase 1
  onward uses branch `phase-NN-<name>` and merges via PR.
- **Claude never runs `git push`.** Pushing to the remote is the human
  developer's own step, always.

## How to run the project locally

```bash
pnpm install
cp .env.example .env   # not yet consumed by any code — no server exists yet
pnpm lint
pnpm format:check
pnpm typecheck
pnpm check:purity
pnpm test
```

There is no `pnpm dev` yet — no server or client app exists to run.

## How to run the test suite

```bash
pnpm test          # Vitest, all packages, single run
pnpm test:watch     # Vitest, watch mode
```

`packages/engine` now has real unit tests (`identifier.test.ts`,
`engine.test.ts`, `grapheme.test.ts`) but the randomized convergence fuzz
suite does not exist yet — it arrives in `packages/testkit` alongside
`integrate()` in Phase 3+. Once built, it will run in isolation via:

```bash
pnpm --filter @collab-editor/testkit run fuzz
```

and will be wired into `.github/workflows/ci.yml` as its own gating step,
separate from the ordinary unit-test run, per Test Plan §2.3's CI-gate table.
