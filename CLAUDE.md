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
                                                 localInsert()/localDelete(). Phase 4
                                                 added invariants.ts (assertInvariants(),
                                                 all ten I0–I9 runtime assertions) and a
                                                 ClockEvent log on Engine (mint()/
                                                 observe() each push one event) that
                                                 exists solely so I0's assertion can
                                                 independently replay the clock. No
                                                 index (§8.5) yet — position lookup
                                                 during integrate() is a linear scan.
                                                 Pure: no DOM, no network, no storage,
                                                 no clock. Only package whose tsconfig
                                                 excludes "DOM" from lib.
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
                                                 real, not throwaway, oracle. Phase 4
                                                 wired assertInvariants() into
                                                 engineAdapter.ts (checked after every
                                                 mutating call, all 10^4 convergence
                                                 seeds) and added src/property/ — the
                                                 five PROP-1..5 fast-check suites, run
                                                 via `pnpm test:properties`, plus a
                                                 dependency on fast-check. Phase 5 added
                                                 src/adversarial/ — all 22 hand-
                                                 constructed ADV-01..22 cases (Test Plan
                                                 §2.4) with literal expected outputs, run
                                                 via `pnpm test:adversarial` (also swept
                                                 into the default `pnpm test`, since
                                                 unlike convergence/properties these are
                                                 fast and deterministic — no isolation
                                                 needed). Depends on engine.
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

- **Phase 4** — Invariant assertions and property-based tests (Engine
  Spec §5 I0–I9, §6; Test Plan §2.5/§2.6). `packages/engine/src/
invariants.ts`: `assertInvariants(engine, { quiescent? })`, checking all
  ten invariants every time it's called — see the ten dedicated bullets
  below for how each is actually checked (several needed a proxy or a
  history, not a literal restatement of the spec sentence). Engine.ts
  gained a `ClockEvent` log (`{kind:"mint"}` / `{kind:"observe",
remoteCounter}`, pushed inside `mint()`/`observe()` — test/diagnostic
  only, never read by ordering logic) purely so I0's check can
  independently replay the correct clock value and compare it against
  the real one. `packages/testkit/src/fuzz/engineAdapter.ts` now calls
  `assertInvariants(engine)` after every `localInsert`/`localDelete`/
  `applyRemote`, and `assertInvariants(engine, { quiescent: true })`
  inside `pendingCount()` — the one point `runTrial.ts` calls it, exactly
  once, right after all of a trial's deliveries complete. `pnpm
test:convergence` passed with all ten invariants active across all
  60,000 seeds (6 configs × 10,000). Manually verified the check is
  live, not decorative: temporarily changed `observe()` to
  `this.clock += 1` (ignoring the remote counter entirely), confirmed
  `assertInvariants` threw `InvariantViolation: I0 violated: ...`
  immediately, then reverted — see the I0 bullet below for exactly why a
  literal-history-replay design was necessary to make this catchable at
  all from outside `mint()`/`observe()`.
  `packages/testkit/src/property/` (new): `support.ts` (shared
  generation/linearization/subsequence helpers, deliberately
  reimplementing readiness independently of `engine.ts`'s own `ready()`
  rather than importing it, so the test can't silently share a bug with
  the code it's checking) and five fast-check suites, each ≥10,000
  generated cases: `commutativity.property.test.ts` (PROP-1, all four
  operation-type pairings, `insIns` biased ~86% toward identical
  positions), `idempotence.property.test.ts` (PROP-2, full-state
  comparison — text, structure length, AND every node's `deleted` flag),
  `orderIndependence.property.test.ts` (PROP-3, two independent
  causality-respecting linearizations of one operation set, built from
  two mutually-unaware replicas' local histories so the dependency graph
  has genuine concurrency to linearize differently),
  `partialKnowledge.property.test.ts` (PROP-4, a prefix of any valid
  linearization is causally closed by construction, checked as an
  order-preserving subsequence against the FULL replica's `nodes`
  including tombstones — not `visible()` — see the dedicated bullet
  below for why that distinction matters), `clockSkew.property.test.ts`
  (PROP-5, compares a randomly-clock-skewed merge against the same
  scenario unskewed rather than only checking the skewed run merges with
  itself, plus a second, independently-written source grep for
  Date.now/new Date/performance.now/getTime in `packages/engine/src`).
  `fast-check@^4.9.0` added as a devDependency of `@collab-editor/testkit`.
  New root/testkit command `pnpm test:properties`
  (`packages/testkit/vitest.properties.config.ts`), excluded from the
  default `pnpm test` the same way `convergence.test.ts` is, and wired
  into CI as its own job (`.github/workflows/ci.yml`, job `properties`).
  Also closed a real, pre-existing gap while implementing PROP-5's grep:
  `scripts/check-engine-purity.mjs`'s FORBIDDEN list and
  `eslint.config.js`'s engine-purity syntax ban were both missing
  `getTime` — Engine Spec §10.8 C9 names it explicitly alongside
  `Date.now`/`new Date`/`performance.now`, but neither existing
  mechanism had ever checked for it. Both now do.
- **Phase 5** — The adversarial suite (Test Plan §2.4, ADV-01…ADV-22; §2.4.1's
  all-orderings rule). `packages/testkit/src/adversarial/`: `support.ts`
  (`forEachReplicaOrdering(roleCount, fn)` — generic permutation over N
  distinct replica ids) and `adversarial.test.ts` — all 22 cases, each
  with its expected output written as a literal string, not computed.

  **This phase was built in two passes, and that matters for how much to
  trust it.** The first pass was written without the real Test Plan §2.4
  text — only a one-line-per-case description was available in that
  session — so 15 of the 22 cases were Claude's own constructions
  matching the category name, not the actual spec. The user then
  supplied the real §2.4 table (case description + expected literal +
  citation, verbatim) and asked for a case-by-case cross-check. That
  check found **12 of the 15 self-derived cases were substantively
  wrong** — wrong base document, wrong operation, or wrong expected
  literal — and rewrote each one to match the table exactly, re-deriving
  the correct literal by hand (tracing Case A/B/C and rank) before
  writing the assertion, the same discipline as the Phase 3 traces. The
  corrected file passed in full on the first run after rewriting — a
  fact worth noting but not over-trusting, since a plausible reading of
  a compact table can still miss a nuance the full source document would
  have caught; the case-by-case correspondence below is close but has
  not been independently re-verified against the table a second time.

  **Cases confirmed correct on the first pass (5): ADV-01, 07, 08, 14, 22.**
  **Cases with cosmetic-only fidelity fixes (4, no logic change):**
  ADV-02/03 (delivery order changed to a genuine per-replica rotation,
  matching "different rotation"/"8 distinct arrival rotations" — the
  expected literal `AabcB`/`AabcdefghB` was already right); ADV-13 (kept
  the same scenario, added a comment tying the skew value to the table's
  "±5 minutes" framing — Lamport counters carry no time unit, Engine
  Spec I0, so this is flavor, not a mechanism); ADV-17 (renamed the
  dummy ordinary character from `f` to `x` to literally match the
  table's `éx`, no behavior change).
  **Cases that were substantively WRONG and rewritten (12):**
  - ADV-04: was testing a self-invented "2 concurrent inserts + concurrent
    delete, both orderings" scenario. Real case is Engine Spec §10.3's own
    HELLO/delete-ELL/insert-x trace → `HxO` (no ordering-sensitivity —
    delete and insert never compete via rank — so the all-orderings loop
    was also dropped).
  - ADV-05: base was `ABCDE` (5 chars); real case needs `ABCDEF` (6
    chars) with `z` inserted between C and D inside a deleted C–D–E
    range → `ABzF`, not the `AxE` the wrong base produced.
  - ADV-06: base was `ABCDE`; real case needs `ABCDEFG` (7 chars) with
    overlapping deletes B–D and C–E → `AFG`, not `A`.
  - ADV-09: was backward-typing (`cbaX`) delivered in reverse with no
    duplicates. Real case is plain forward-typed `ABC` delivered in
    reverse causal order WITH interleaved duplicates (each op delivered
    twice before its one missing dependency arrives) → `ABC`, buffer
    drains to 0.
  - ADV-10: was 2 replicas → `ab`. Real case is 3 replicas concurrently
    first-inserting into an empty document → `XYZ`.
  - ADV-11: was sequential (non-concurrent) inserts on one engine. Real
    case is two replicas CONCURRENTLY inserting at position 0 and at EOF
    of a shared base `MID` → `<MID>`.
  - ADV-12: was a sequential delete-then-insert on one engine → `z`. Real
    case is a concurrent full-document delete racing an insert of `!` →
    `!` (the whole base is tombstoned, `!` is the sole survivor).
  - ADV-15: was 3-way BACKWARD typing with distinct letters
    (`cbazyx321X`). Real case is 3-way FORWARD typing (append), each
    replica repeating its OWN letter, from an empty document → `AAABBBCCC`
    — a materially different mechanism (Case C's break-on-foreign-origin,
    not Case B's nested-group handling) that happens to share ADV-14's
    "ascending id ends up leftmost" directionality by coincidence, not
    because it's the same code path.
  - ADV-16: was an unrelated "two replicas with incomparable knowledge"
    scenario (`ApBqCr`). Real case is exactly "B saw half of A's run":
    A types `ab`, sends it to B, then A continues with `cd` while B
    concurrently continues with `xy` from the same `ab` → `abxycd`,
    explicitly exercising Case A line 13's originRight-equality test
    (which evaluates false here — same left origin, open/null right
    origins on both sides — correctly falling through to "keep scanning"
    rather than breaking early).
  - ADV-18: had an extra, invented third "ordinary character" competitor
    that isn't in the real scenario. Real case is exactly two concurrent
    combining marks on one base, nothing else — rewritten to check
    convergence, both-marks-retained, and base-intact, still in both
    replica-id orderings per §2.4.1's general rule (order between the two
    marks depends on id even though the table doesn't print a specific
    literal for it).
  - ADV-20: was a self-invented "tangled nested concurrent inserts never
    invert position" structural-invariant check (result `AprsqZ`). Real
    case is entirely different: an insert whose originRight-referencing
    message arrives at a receiver BEFORE its originLeft-referencing
    message — verified via explicit delivery order, asserting the op sits
    in `pending` (buffered) until the last dependency arrives, then
    drains to convergence.
  - ADV-21: was "undelete restores a deleted node, and is a no-op on an
    already-visible node" — the opposite semantic. Real case is "undelete
    of a node LATER deleted again by another user is a no-op": delete →
    undelete → a causally-LATER second delete wins, net effect unchanged
    from before the undelete — verified on two replicas receiving the
    same three operations in different arrival orders, confirming the
    causal id (not delivery order) decides.

  **DoD verification performed and reverted**: temporarily changed
  `rank()` in `engine.ts` to `[1, n.id.r]` (dropping the binding
  component entirely). Re-ran `pnpm test:adversarial`: ADV-17 and ADV-19
  each failed on exactly one of their two `forEachReplicaOrdering`
  iterations — the one where the marked/ZWJ role landed on the
  HIGHER-numbered replica — while the other iteration passed by sheer
  coincidence (both roles now rank purely by id, and the lower-id role
  happened to be the mark that time). This is exactly Engine Spec §10.8's
  documented failure shape, which is the entire reason §2.4.1 mandates
  testing both orderings rather than one. Reverted immediately after
  confirming.
  New command `pnpm test:adversarial`
  (`packages/testkit/vitest.adversarial.config.ts`). Unlike
  convergence/properties, NOT excluded from the default `pnpm test` —
  22 deterministic cases run in under a second, so there's no runtime
  reason to isolate them, and the file is picked up by both commands.
  Wired into CI as an explicit named step inside the main `ci` job (not
  a separate job — no isolated runtime budget to justify one) right
  after the general `pnpm test` step.

## Current phase in progress

None — Phase 5 complete, awaiting Phase 6.

## What is explicitly NOT yet built

Undo/redo's real resurrection semantics beyond Undelete's structural
inverse (Phase 36); the indexed position structure (Phase 19) — integrate()
currently locates origins via a linear `indexOf` scan, not an index; garbage
collection (Phase 21); block run-length encoding (later, alongside GC). No
wire protocol; no server (no Express app, no WebSocket gateway, no
database schema, no auth); no client (no React app, no editor binding, no
DOM rendering); no persistence; no permissions; no offline/reconciliation
logic; no presence; no version history; no mutation testing (Phase 6), no
10⁶ nightly fuzz run (Phase 6); no Docker setup; no deployed environment.

## Key technical decisions with source citations

- **Phase 5's adversarial suite was corrected against the real Test Plan
  §2.4 table after an initial pass built without it.** The first pass
  (no §2.4 text available that session) guessed 15 of 22 scenarios from
  one-line category descriptions; a cross-check against the actual table
  (pasted by the user afterward) found 12 of those 15 substantively
  wrong — see the Phase 5 completed-phase entry above for the full
  per-case list of what changed and why. The lesson worth keeping: "all
  N cases passed on the first run" is NOT evidence a self-invented test
  matches an unseen spec — it only proves the code and the test agree,
  which is expected when the same reasoning produced both. Treat a
  green suite built without the source document as unverified until it's
  actually been checked against that document, no matter how confident
  the derivation felt at the time.

- **How each of the ten invariants is actually checked by `assertInvariants()`** — several are NOT a literal restatement of their Engine Spec §5 sentence, because that sentence describes something only checkable with history, or only checkable at prohibitive cost every call:
  - **I0** (clock advances exactly once per mint) is checked by REPLAYING a
    dedicated `ClockEvent` log with hard-coded correct max/increment
    semantics and comparing the replayed value to the actual clock — not
    by inspecting `nodes`/`pending` at all. Reconstructing "what did this
    replica mint" from final state is fundamentally unreliable: a delete
    op that lost the causally-latest race for its target leaves NO trace
    anywhere in state, so a snapshot-based reconstruction produces false
    "gaps" for perfectly correct behavior under `C3_DELETE_HEAVY`. The
    event log sidesteps this by recording facts (a mint happened; observe
    was called with X) rather than trying to infer them after the fact.
  - **I1** (identifier uniqueness) is a direct count check: number of
    nodes vs. number of distinct `(counter, replica)` pairs among them,
    using a nested `Map<number, Map<number, Node>>` keyed by the raw
    numbers rather than a `serializeId()` string — see the performance
    bullet below for why.
  - **I2** (identifier immutability) needs a per-node snapshot from a
    PRIOR call to compare against; a single end-of-trial call would make
    it vacuously true. Tracked in a `WeakMap<Node, NodeSnapshot>` at
    module scope (safe across engines/trials because Node object
    identity itself is globally unique — no two trials ever share a Node
    object, unlike identifiers, which restart at (1, replicaId) every
    trial).
  - **I3** (order stability) is checked as a running-maximum scan, not an
    O(n²) all-pairs recheck or an O(n) array-copy-and-rescan every call:
    walking the current array left to right, each previously-seen node's
    OLD index must not dip below the highest OLD index seen so far in the
    walk. A dip means two already-ordered nodes flipped. This is
    mathematically equivalent to "the old sequence is a subsequence of
    the new one" but computable in one pass with no allocation, which
    mattered once measurement showed the naive version added ~3x runtime
    to the convergence suite (see below).
  - **I4** (origin presence at integration time) and **I5** (tombstone
    retention) sound almost identical from outside `integrate()`, but are
    checked as two DIFFERENT things: I4 checks that every node's CURRENT
    origins resolve (a node pointing at a vanished origin), while I5
    checks that the STRUCTURE never SHRINKS between calls (a node that
    existed a moment ago is now gone). Right now, with no GC, I5 can only
    ever fire on a genuine regression (e.g., a future GC bug) — it exists
    for that future, not because it's expected to catch anything today.
  - **I6** (scan-window determinism) is checked via its lasting structural
    consequence, not by re-running `integrate()`: every node must sit
    strictly between the CURRENT positions of its own `originLeft` and
    `originRight`. This is necessary-but-not-fully-equivalent to "the
    algorithm is deterministic," but re-executing integration itself
    inside an assertion would be circular — the convergence suite's
    cross-replica text/structure equality is the stronger, independent
    proof of determinism; this is a cheap, always-on sanity check for the
    same property.
  - **I7** (deletion attribution monotonicity) needs the PRIOR
    `deletedBy` to compare against — same shape as I2, another
    `WeakMap<Node, Identifier>` populated across calls.
  - **I8** (grapheme cluster contiguity) is checked directly and
    literally: for every `bind: true` node, scan the array positions
    between its `originLeft` and itself for any `bind: false` node
    sharing that same `originLeft`. Costs nothing on the actual fuzz
    suite because none of its generated characters are combining marks
    (`0x61`–`0x7a` only) — this check has never actually executed its
    inner loop body against real fuzz data, only against hand-constructed
    scenarios, which is worth remembering if it's ever suspected of
    hiding a bug.
  - **I9** (pending buffer drains at quiescence) is the one invariant
    NOT checked on every call — a nonempty `pending` mid-trial is normal
    (Engine Spec §4.2), so `assertInvariants` only evaluates it when
    called with `{ quiescent: true }`. `engineAdapter.ts` passes that
    flag from exactly one call site: inside `pendingCount()`, which
    `runTrial.ts` calls exactly once, immediately after all of a trial's
    deliveries are done — piggybacking on an existing, already-correct
    "this is the quiescence point" signal rather than inventing a new one.
    — Engine Spec §5 (I0–I9), Test Plan §2.6.
- **`assertInvariants()` measurably costs ~3x the convergence suite's
  runtime, and that cost was cut in half twice before being accepted.**
  A first working version (string-keyed `Map<string,Node>` via
  `serializeId()`, an I3 check that copied and rescanned the whole node
  array every call, redundant origin lookups repeated across I4/I6/I8)
  measured ~162ms/seed on `C5_WIDE` (8 replicas) — 10,000 seeds of just
  that one config would have taken ~27 minutes. Resolving each origin
  ONCE per node and sharing the result across I4/I6/I8, switching to a
  nested numeric-keyed map to avoid `serializeId()` string allocation on
  the hot path (kept only for violation MESSAGES, which are cold), and
  folding I3's check into the same pass instead of a separate
  array-copy-and-rescan brought this to ~86ms/seed — the full 60,000-seed
  suite completed in the same run that also passed all 6 configs. The
  general lesson worth keeping: `serializeId()`-based lookups and
  WeakMap-based history are both fine in isolation, but this function
  runs after EVERY mutation across every fuzz seed, so a per-call cost
  that looks trivial in isolation is not trivial at this call volume —
  measure before accepting a design, not after a CI timeout.
  — Test Plan §2.6.
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
pnpm test              # Vitest, all packages EXCEPT the convergence + property suites, single run
pnpm test:watch        # Vitest, watch mode
pnpm test:convergence  # the convergence suite ONLY — C1-C6, 10,000 seeds each, invariants active
pnpm test:properties   # the property-based suite ONLY — PROP-1..5, 10,000 generated cases each
pnpm test:adversarial  # the adversarial suite ONLY — ADV-01..22, hand-constructed, also part of `pnpm test`
```

`pnpm test` currently passes: 54 tests across 10 files, including
`packages/engine/src/engine.test.ts` (10 tests — Phase 1's identifier/clock
tests plus Phase 3's five origin-bounded-integration tests: the §10.1,
§10.3, §10.5, and §10.7 worked-trace hand-verifications plus one longer
insert/delete round-trip), `packages/testkit/src/adversarial/
adversarial.test.ts` (22 tests — see the Phase 5 entry above), and
`packages/testkit/src/fuzz/harness.selftest.test.ts`, which proves the
fuzz harness itself works (detects a deliberately broken toy engine as
divergent, and completes 10,000 toy-engine seeds in ~2s, well under the
30s bar).

`pnpm test:convergence` currently PASSES for all six required configs
(Test Plan §2.2): 10,000/10,000 seeds converge in each (60,000 total),
zero divergences, zero stuck-pending, zero errors, with all ten Engine
Spec §5 invariants (I0–I9) actively checked via `assertInvariants()`
after every mutating call across every one of those 60,000 seeds (Test
Plan §2.6) — not merely a passing convergence check running alongside an
inert invariant module. It is wired into CI as its own job
(`.github/workflows/ci.yml`, job `convergence`), separate from the main
`ci` job, so GitHub reports it as its own named check — but actually
marking that check as a branch-protection-required status is still a
manual, one-time GitHub Settings action that hasn't been done yet.

`pnpm test:properties` currently PASSES: 5 properties (PROP-1…5, Test
Plan §2.5) at 10,000 fast-check-generated cases each, plus a sixth,
independent source-grep test confirming `packages/engine/src` contains
no `Date.now`/`new Date`/`performance.now`/`getTime` (Engine Spec §10.8
C9). Wired into CI as its own job (`properties`), for the same reasons as
`convergence` — its own runtime budget, its own named check.

`pnpm test:adversarial` currently PASSES: all 22 ADV-01…22 cases (Test
Plan §2.4), each asserting a literal expected output. Runs in well under
a second, so — unlike convergence/properties — it is NOT excluded from
the default `pnpm test`; it has its own command purely for an isolated,
unambiguous signal, and is wired into CI as an explicit named step inside
the main `ci` job (not a separate job).
