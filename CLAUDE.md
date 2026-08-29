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

Monorepo (pnpm workspaces), five packages. `engine` and `testkit` now
contain real feature code (Phases 1–3); `protocol`, `server`, and `client`
are still placeholder scaffolding only:

```
packages/engine      @collab-editor/engine    — OBSEQ. Phase 1 built the data types
                                                 (Identifier, Node), MINT/OBSERVE,
                                                 isClusterContinuing, and the Engine
                                                 class shell. Phase 3 built the
                                                 Insert/Delete/Undelete operation
                                                 union, ready()/applyRemote()/drain()
                                                 (causal readiness + buffering to a
                                                 fixpoint), integrate() (the
                                                 origin-bounded placement algorithm,
                                                 Engine Spec §4.3, Cases A/B/C), and
                                                 localInsert()/localDelete(). No index
                                                 (§8.5) yet — position lookup during
                                                 integrate() is a linear scan. Pure: no
                                                 DOM, no network, no storage, no clock.
                                                 Only package whose tsconfig excludes
                                                 "DOM" from lib.
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
                                                 harness (src/fuzz/). Phase 3 wired
                                                 engineAdapter.ts to the real Engine
                                                 (no more NotImplementedError) — the
                                                 convergence suite now runs against a
                                                 real, not throwaway, oracle. Depends
                                                 on engine.
```

`protocol`, `server`, and `client` still each export one placeholder
constant with one trivial passing test, purely proving the toolchain
(build/lint/typecheck/test) works end-to-end across the whole workspace
ahead of their own real code.

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
- **Phase 3** — Operation semantics and origin-bounded integration: the
  intellectual core of the system. In `packages/engine/src/operation.ts`:
  the real `Insert`/`Delete`/`Undelete` operation union (Engine Spec
  §4.1) — no operation carries a numeric index; inserts anchor on
  `originLeft`/`originRight` identifiers, deletes/undeletes on a
  `target` identifier. In `packages/engine/src/engine.ts`: `ready(op)`
  (Definition 4.1 — an insert needs both origins present, a delete/
  undelete needs its target present); `applyRemote(op)` (idempotent via
  the `applied` id set, buffers into `pending` when not ready);
  `drain()` (sweeps `pending` to a fixpoint — one pass is not enough,
  since applying one op can ready another); `integrate(node)` (Engine
  Spec §4.3's origin-bounded placement algorithm — Cases A/B/C below);
  `applyDelete`/`applyUndelete` (§4.5's causally-latest `deletedBy` rule
  — every concurrent delete tombstones the node, but attribution goes to
  whichever delete is causally latest under `compareIds`, never
  whichever arrived last); `localInsert()`/`localDelete()` (mint +
  apply + return the broadcast operation(s), consecutive counters in
  return order). `rank(n) = [n.bind ? 0 : 1, n.id.r]` per Definition 4.2.
  `packages/engine/src/identifier.ts` gained `serializeId()`, the map-key
  function `byKey`/`applied` are keyed on. `packages/testkit/src/fuzz/
  engineAdapter.ts` now wires `localInsert`/`localDelete`/`applyRemote`
  straight through to the real `Engine` — `NotImplementedError` is gone
  from the codebase entirely (deleted from `engineAdapter.ts` and its
  re-export in `fuzz/index.ts`), because there is no longer anything for
  it to guard. 5 new hand-verification tests added to
  `packages/engine/src/engine.test.ts`, one per named worked trace: §10.1
  (`AabB`, concurrent same-window inserts), §10.3 (`HxO`, concurrent
  delete-heavy + insert), §10.7 (`cbazyxX`, backward-typing contiguity —
  the trace the Case A originRight-equality test exists for), §10.5
  (reverse-causal delivery with duplicates drains to zero pending), plus
  one longer round-trip sanity check. `pnpm test:convergence` now
  **passes**: 60,000 trials (10,000 seeds × 6 configs), 0 divergences, 0
  stuck-pending, 0 errors. No fuzz failure was encountered during this
  phase, so `tests/regression/` gained no new entries.

  The origin-bounded integration algorithm (Cases A/B/C, Engine Spec
  §4.3), implemented as a linear scan over `nodes` between the new
  node's origin indices:
  - **Case A** (`other`'s `originLeft` equals the new node's
    `originLeft`): a direct sibling in the same conflict window. If
    `other` outranks the new node (`rank(other) < rank(new)`), the new
    node's destination advances past it. Otherwise, if `other`'s
    `originRight` ALSO equals the new node's `originRight` — the
    originRight equality test — the two are anchored at the exact same
    (left, right) pair, so rank alone decides and scanning stops there.
    If the right origins differ, the outcome is still undetermined
    (`other` outranks us but was anchored more narrowly) and the scan
    continues without moving the destination.
  - **Case B** (`other`'s own `originLeft` is a node already scanned in
    this pass — nested inside our conflict window): tests membership in
    the `conflicting` set (the "group set test"). If `other`'s origin
    was already resolved out of that set (lost an earlier comparison),
    `other` inherits that resolution and the destination advances past
    it too — this is what keeps a whole nested run (e.g. a growing
    backward-typed chain) moving together as one group rather than
    letting a later single item re-litigate the group's position.
  - **Case C** (`other`'s `originLeft` lies outside the conflict window
    entirely — neither Case A nor Case B applies): the scan has walked
    past this conflict group's boundary; stop and insert here.

## Current phase in progress

None — Phase 3 complete, awaiting Phase 4.

## What is explicitly NOT yet built

Undo/redo's real resurrection semantics beyond Undelete's structural
inverse (Phase 36); the indexed position structure (Phase 19) — integrate()
currently locates origins via a linear `indexOf` scan, not an index; garbage
collection (Phase 21); block run-length encoding (later, alongside GC). No
wire protocol; no server (no Express app, no WebSocket gateway, no
database schema, no auth); no client (no React app, no editor binding, no
DOM rendering); no persistence; no permissions; no offline/reconciliation
logic; no presence; no version history; no property-based tests (Phase
4), no adversarial suite (Phase 5), no mutation testing (Phase 6), no 10⁶
nightly fuzz run (Phase 6); no Docker setup; no deployed environment.

## Key technical decisions with source citations

- **Case A's tie-break requires BOTH `originLeft` equality (to enter the
  branch) AND `originRight` equality (to actually stop scanning) — checking
  only `originLeft` is the exact historical bug.** A node reached mid-scan
  with the same `originLeft` as the new node but a DIFFERENT `originRight`
  is only a partial conflict — its own window is anchored more narrowly (or
  more widely) than ours, and letting rank decide immediately, without the
  originRight check, is what let the RFC's prototype produce `"zcybxa"`
  instead of `"cbazyx"` on backward-typed concurrent runs — convergent, but
  not intention-preserving: it destroyed each user's own typing order.
  Engine Spec §4.3, resolved as RFC NQ-2; worked trace at §10.7, reproduced
  as a unit test in `engine.test.ts`.
- **Case B decides using set MEMBERSHIP of the scanned node's origin, not
  the scanned node itself.** `conflicting.has(otherOriginNode)` — never
  `conflicting.has(other)`. This is what lets a whole nested run (e.g. a
  three-character backward-typed chain) move together as one group when its
  anchor point loses a comparison, rather than re-litigating each nested
  member's position independently against the incoming node. Engine Spec
  §4.3 Case B.
- **`applyRemote()`'s idempotence check and `drain()`'s duplicate-discard
  both key off the OPERATION's own id (`op.id`), never off the identifier
  of the node/target it touches.** Two different delete operations can
  legally target the same node (concurrent deletes); collapsing on the
  target id would silently drop the second one instead of tombstoning
  twice and picking the causally-latest `deletedBy`. Engine Spec §4.5, §6.3.
- **`localDelete()` snapshots `visible()` once at the start of the call and
  indexes into that snapshot for every unit removed, rather than
  recomputing `visible()` after each tombstone.** `deleted` mutation
  removes a node from `vis(S)` immediately, which would shift every
  subsequent index if recomputed mid-loop — the caller's `(visibleIndex,
  count)` describes a contiguous range in the sequence AS IT STOOD when the
  call began, not a moving target. API Spec §1.4.
- **`integrate()` throws if an origin isn't present in `byKey`, rather than
  silently treating it as document-start/end.** This can only happen if a
  caller integrates an operation that `ready()` did not first confirm ready
  — a caller bug, not a reachable runtime state once `applyRemote()`/
  `drain()` are the only callers. The thrown error documents the
  precondition instead of masking a violation as a silently-wrong position.
- **`preSkewClock()` in `engineAdapter.ts` is implemented via `observe()`,
  never a direct clock-set.** `observe()` only ever advances the clock
  (Invariant I0), so a negative skew delta from config C6 is a deliberate
  no-op rather than a new clock-mutation path that would bypass mint()/
  observe()'s independence. The adapter contract already documents skew as
  additive/optional for exactly this reason.
- **The convergence harness was built before `integrate()` existed, and
  stays OUT of the default `pnpm test` run even now that it passes.**
  `convergence.test.ts` has its own vitest config (`packages/testkit/
vitest.convergence.config.ts`) and its own command (`pnpm
test:convergence`), excluded from root `vitest.config.ts`'s default
  include. Historical reason: between Phase 2 and Phase 3, every trial was
  EXPECTED to fail (`NotImplementedError`), and that had to not turn the
  ordinary `pnpm test` loop red. As of Phase 3 the suite passes — 6/6
  configs, 10,000/10,000 seeds converged each — but it stays separate
  going forward too, simply because 60,000 fuzz trials belong in their own
  gate, not the fast inner-loop suite. — Test Plan §2.2/§12.6, PRD M1(a)/C-7.
- **The harness is written against `ReplicaAdapter<Op>`, an engine-agnostic
  interface, never against the concrete `Engine` class directly.** `Op` is
  generic and opaque to the harness — it never inspects an operation's
  contents, only shuffles/duplicates/redelivers whatever
  `localInsert()`/`localDelete()` returned. This is what let the exact same
  harness run against both a deliberately-wrong toy engine (proving the
  harness detects divergence) and the real engine (proving Phase 3 must be
  written against a working oracle), without the harness knowing which. —
  mirrors Engine Spec §11.2's upward interface.
- **The real-engine adapter threw `NotImplementedError` from its mutating
  methods pre-Phase-3, rather than being typed to call methods that didn't
  exist yet — Phase 3 deleted `NotImplementedError` entirely once it had
  nothing left to guard.** Calling a genuinely-nonexistent method on
  `Engine` would have failed `tsc --noEmit`, breaking `pnpm typecheck`
  project-wide for every phase between Phase 2 and 3 — not just the one
  gate that was supposed to be red. As of Phase 3, `engineAdapter.ts`'s
  `localInsert`/`localDelete`/`applyRemote` call straight through to the
  real `Engine.localInsert()`/`localDelete()`/`applyRemote()` — no
  wrapper, no error class, nothing left to remove in a later phase.
- **`pendingCount() === 0` is asserted SEPARATELY from text equality, never
  folded into one check.** A replica that silently dropped an operation
  instead of buffering it can still produce matching text if the drop
  happened to be a duplicate. Test Plan §2.8 confirmed this empirically —
  mutant `M10_no_drain` is caught by this assertion and by nothing else.
- **Identifier density comes from origin anchoring, not identifier value.**
  `compareIds` is plain lexicographic order on `(counter, replica)` and the
  identifiers themselves are NOT dense — OBSEQ does not need Logoot/LSEQ-style
  variable-length dense identifiers, because a node's position is determined
  by its `originLeft`/`originRight` plus the `integrate()` rule (Phase 3), not
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

`pnpm test` currently passes: 32 tests across 9 files, including
`packages/engine/src/engine.test.ts` (10 tests — Phase 1's identifier/clock
tests plus Phase 3's five origin-bounded-integration tests: the §10.1,
§10.3, §10.5, and §10.7 worked-trace hand-verifications plus one longer
insert/delete round-trip) and
`packages/testkit/src/fuzz/harness.selftest.test.ts`, which proves the
fuzz harness itself works (detects a deliberately broken toy engine as
divergent, and completes 10,000 toy-engine seeds in ~2s, well under the
30s bar).

`pnpm test:convergence` currently PASSES for all six required configs
(Test Plan §2.2): 10,000/10,000 seeds converge in each (60,000 total),
zero divergences, zero stuck-pending, zero errors. Total wall time on the
reference machine was ~510s (C5-wide, at 8 replicas, is the slowest single
config at ~280s — this is a fuzz-suite runtime, not a hot-path
correctness concern). It is wired into CI as its own job
(`.github/workflows/ci.yml`, job `convergence`), separate from the main
`ci` job, so GitHub reports it as its own named check — but actually
marking that check as a branch-protection-required status is still a
manual, one-time GitHub Settings action that hasn't been done yet.
