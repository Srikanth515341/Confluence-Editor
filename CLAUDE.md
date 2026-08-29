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
packages/engine      @collab-editor/engine    — OBSEQ. Pure: no DOM, no network,
                                                 no storage, no clock. Only package
                                                 whose tsconfig excludes "DOM" from lib.
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

## Current phase in progress

None — Phase 0 complete, awaiting Phase 1.

## What is explicitly NOT yet built

Everything. No OBSEQ data structures (nodes, identifiers, INTEGRATE), no
wire protocol, no server (no Express app, no WebSocket gateway, no database
schema, no auth), no client (no React app, no editor binding, no DOM
rendering), no persistence, no permissions, no offline/reconciliation logic,
no presence, no version history, no fuzz/mutation harnesses, no Docker
setup, no deployed environment. Phase 0 is toolchain and process only.

## Key technical decisions with source citations

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

The convergence (fuzz) suite does not exist yet. Once built (Phase 1+), it
will run in isolation via:

```bash
pnpm --filter @collab-editor/testkit run fuzz
```

and will be wired into `.github/workflows/ci.yml` as its own gating step,
separate from the ordinary unit-test run, per Test Plan §2.3's CI-gate table.
