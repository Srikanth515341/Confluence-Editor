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
                                                 harness. Phase 2 built the
                                                 randomized-interleaving convergence
                                                 harness (src/fuzz/). Depends on engine.
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
- **Phase 2** — The convergence test harness and CI gate, built BEFORE
  `integrate()` exists (deliberate ordering — see Implementation Plan
  Phase 2 rationale: a harness written after the algorithm tends to test
  what the algorithm does; written before, it tests what the algorithm
  should do). In `packages/testkit/src/fuzz/`: `prng.ts` (`mulberry32`,
  `randInt`, `fisherYatesShuffle`); `adapter.ts` (the engine-agnostic
  `ReplicaAdapter<Op>`/`ReplicaFactory<Op>` contract the harness is
  written against, mirroring Engine Spec §11.2's eventual upward
  interface); `configs.ts` (the six required configs `C1_BASELINE` …
  `C6_SKEW`, Test Plan §2.2); `runTrial.ts` (`runTrial`/`runFuzzSuite` —
  generation, global Fisher-Yates shuffle across all rounds, duplicate
  injection, and the three assertions: text equality, `pendingCount()
=== 0` asserted SEPARATELY, and structure-length equality);
  `toyAdapter.ts` (a deliberately WRONG "always append at the end"
  replica, proving the harness can actually detect divergence);
  `engineAdapter.ts` (wraps the real Phase 1 `Engine`; every mutating
  method throws `NotImplementedError` until Phase 3, while `text()` /
  `structureLength()` / `pendingCount()` call genuinely-implemented
  Phase 1 code); `harness.selftest.test.ts` (proves the harness against
  the toy engine — runs under ordinary `pnpm test`); `convergence.test.ts`
  (the real suite, C1–C6 × 10,000 seeds — deliberately EXCLUDED from
  `pnpm test` and run in isolation via `pnpm test:convergence`, which is
  EXPECTED TO FAIL right now, for exactly one reason: `Engine.localInsert()
is not implemented yet`). `tests/regression/README.md` documents the
  three corpus rules (Test Plan §2.3). CI gained a second job,
  `convergence`, running `pnpm test:convergence` — see "Key technical
  decisions" for why it's a separate job and why it isn't (yet) a
  branch-protection required check.
  Also fixed in this phase: every package's `main`/`types` in
  `package.json` now point at `src/index.ts` directly instead of a
  never-built `dist/`, because Phase 2 was the first phase to actually
  import one workspace package from another (`testkit` → `engine`) and
  that import failed typecheck until this was fixed.

## Current phase in progress

None — Phase 2 complete, awaiting Phase 3.

## What is explicitly NOT yet built

OBSEQ's `integrate()` algorithm and the Insert/Delete/Undelete operation
records (Phase 3 — the convergence suite, `pnpm test:convergence`, is
wired up and currently failing for exactly this reason, on purpose); the
indexed position structure (Phase 19); garbage collection (Phase 21);
undo/redo (Phase 36); block run-length encoding (later, alongside GC). No
wire protocol; no server (no Express app, no WebSocket gateway, no
database schema, no auth); no client (no React app, no editor binding, no
DOM rendering); no persistence; no permissions; no offline/reconciliation
logic; no presence; no version history; no property-based tests (Phase
4), no adversarial suite (Phase 5), no mutation testing (Phase 6), no 10⁶
nightly fuzz run (Phase 6); no Docker setup; no deployed environment.

## Key technical decisions with source citations

- **The convergence harness was built before `integrate()` exists, and is
  deliberately kept OUT of the default `pnpm test` run.** `convergence.test.ts`
  has its own vitest config (`packages/testkit/vitest.convergence.config.ts`)
  and its own command (`pnpm test:convergence`), excluded from root
  `vitest.config.ts`'s default include. Reason: until Phase 3 implements
  `integrate()`, every trial in that suite is EXPECTED to fail (currently:
  6/6 configs, 0/10,000 seeds converged each, all erroring with
  `NotImplementedError`), and that must not turn the ordinary `pnpm test`
  loop red for every phase between Phase 2 and Phase 3. — Test Plan
  §2.2/§12.6, PRD M1(a)/C-7.
- **The harness is written against `ReplicaAdapter<Op>`, an engine-agnostic
  interface, never against the concrete `Engine` class directly.** `Op` is
  generic and opaque to the harness — it never inspects an operation's
  contents, only shuffles/duplicates/redelivers whatever
  `localInsert()`/`localDelete()` returned. This is what let the exact same
  harness run against both a deliberately-wrong toy engine (proving the
  harness detects divergence) and the real engine (proving Phase 3 must be
  written against a working oracle), without the harness knowing which. —
  mirrors Engine Spec §11.2's upward interface.
- **The real-engine adapter throws `NotImplementedError` from its mutating
  methods rather than being typed to call methods that don't exist.**
  Calling a genuinely-nonexistent method on `Engine` would fail `tsc
--noEmit` (a compile error), breaking `pnpm typecheck` project-wide for
  every phase until Phase 3 — not just the one gate that's SUPPOSED to be
  red. Instead, the adapter's methods conform to the interface's types
  cleanly and throw a clear, deliberate error at runtime, so only
  `pnpm test:convergence` fails, and it fails with an unambiguous message
  rather than an obscure crash.
- **`pendingCount() === 0` is asserted SEPARATELY from text equality, never
  folded into one check.** A replica that silently dropped an operation
  instead of buffering it can still produce matching text if the drop
  happened to be a duplicate. Test Plan §2.8 confirmed this empirically —
  mutant `M10_no_drain` is caught by this assertion and by nothing else.
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
  onward uses branch `phase-NN-<name>`, merges via PR.
- **Claude does not run ANY git command, at all, as of Phase 2.** No
  `init`/`add`/`commit`/`push`/`checkout`/`branch`/`status`/`log` — nothing.
  Srikanth creates every branch and handles all staging, committing, and
  pushing himself, manually, in his own terminal. Claude's job each phase
  is to write/edit files on disk and report exactly what changed, then
  stop. (Phase 0 and Phase 1 predate this escalation and did have Claude
  committing locally — this rule is stricter and supersedes that.)

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
pnpm test              # Vitest, all packages EXCEPT the convergence suite, single run
pnpm test:watch        # Vitest, watch mode
pnpm test:convergence  # the convergence suite ONLY — C1-C6, 10,000 seeds each
```

`pnpm test` currently passes: 27 tests across 9 files, including
`packages/testkit/src/fuzz/harness.selftest.test.ts`, which proves the
fuzz harness itself works (detects a deliberately broken toy engine as
divergent, and completes 10,000 toy-engine seeds in ~2s, well under the
30s bar).

`pnpm test:convergence` currently FAILS, on purpose, for all six required
configs (Test Plan §2.2): 0/10,000 seeds converge in each, every one
erroring with `Engine.localInsert() is not implemented yet — integrate()
and applyRemote() land in Phase 3`. This is correct and expected until
Phase 3 lands — do not try to make it pass by weakening the suite. It is
wired into CI as its own job (`.github/workflows/ci.yml`, job
`convergence`), separate from the main `ci` job, so GitHub reports it as
its own named check — but actually marking that check as a
branch-protection-required status is a manual, one-time GitHub Settings
action that hasn't been done yet (and shouldn't be, until Phase 3 makes
it meaningful to enforce).
