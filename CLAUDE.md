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
                                                 shared by client and server. Phase 7 built
                                                 the whole thing, corrected against the real
                                                 API/Protocol/Data Spec v1.0 text after an
                                                 initial pass built without it (see the Phase
                                                 7 completed-phase entry for the full list of
                                                 what changed): LEB128 varint;
                                                 stamp/optional-stamp/string/uuid/scalar
                                                 primitives (src/primitives.ts); the exact
                                                 3-byte envelope (protocolVersion, channel
                                                 0x01/0x02/0x03, messageType — NO frame-level
                                                 flags byte) plus per-message seq/flags
                                                 (src/codec.ts, src/messages.ts); all seven
                                                 OPS message types with spec-exact numeric
                                                 values — OP_INSERT (0x01), OP_INSERT_RUN
                                                 (0x02), OP_DELETE (0x03), OP_DELETE_BATCH
                                                 (0x04), OP_UNDELETE (0x05), OP_ACK (0x10,
                                                 a batch of acks, S→C only), OP_REJECT (0x11,
                                                 a batch of rejects + shared detail string,
                                                 S→C only) — with OP_INSERT_RUN/
                                                 OP_DELETE_BATCH expansion into real engine
                                                 Operations (src/expand.ts); debugProject() →
                                                 JSON (src/codec.ts); and the 7-code
                                                 RejectReason enum with spec-exact
                                                 values/names (src/messages.ts). A single
                                                 insert at counters near 50,000 measures
                                                 exactly 18 bytes, matching API Spec §1.3.
                                                 Phase 9 added the CONTROL channel: src/
                                                 controlMessages.ts (ControlMessageType enum,
                                                 spec-exact 0x01-0x0E values; the 9 message
                                                 types this phase implements — HELLO, WELCOME,
                                                 SNAPSHOT, SYNC_COMPLETE, PING, PONG, LEAVE,
                                                 GOODBYE, ERROR — plus CATCHUP_*/ALREADY_HAVE/
                                                 PERMISSION_CHANGED reserved-but-unimplemented);
                                                 src/controlCodec.ts (encode/decodeControlFrame,
                                                 same envelope shape as OPS, C→S/S→C direction
                                                 enforcement); src/snapshotBody.ts (the
                                                 structure-form SNAPSHOT body codec — a Phase-9
                                                 placeholder serialization, EXPECTED to be
                                                 reworked once Phase 20's block run-length
                                                 encoding lands, not merely unverified). PRESENCE
                                                 message types are still not built (Phase 31).
                                                 Depends on engine (for Identifier/Operation/Node
                                                 types and, in tests only, Engine itself).
packages/server      @collab-editor/server    — Express + WebSocket gateway, Document
                                                 Coordinator. Phase 8 built the in-memory OPS
                                                 path (config.ts, logger.ts, sendQueues.ts's
                                                 three-priority-queue ConnectionSendQueues,
                                                 httpApp.ts, server.ts). Phase 9 built the real
                                                 sync handshake, replacing Phase 8's interim
                                                 documentId-query-param binding entirely:
                                                 handshake.ts (buildWelcomeMessage/
                                                 buildSnapshotMessage, and the live
                                                 assertSnapshotFormAllowed guard — API Spec
                                                 §3.6.3 forbids form:0 to an editor/owner, and
                                                 every session is hardcoded EDITOR this phase,
                                                 so SNAPSHOT is unconditionally form:1);
                                                 heartbeat.ts (the three DISTINCT §3.6.11
                                                 liveness constants — 3s ping / 8s presence-
                                                 stale / 10min session-inactive — with only the
                                                 first two wired; session-inactive eviction is
                                                 scaffolding only, per §11.4);
                                                 documentCoordinator.ts (CoordinatorSession now
                                                 carries role/userId/displayName/lastPingAt/
                                                 presenceStale/staleTimer; watermarks is now
                                                 live, updated from PING's lastAppliedSeq;
                                                 replica-id allocation persists for a
                                                 document's whole in-memory lifetime — a
                                                 coordinator is no longer deleted when its last
                                                 session leaves, specifically so replica ids are
                                                 never reused, API Spec §3.6.2); gateway.ts
                                                 (connections now start unbound and complete a
                                                 real HELLO→WELCOME→SNAPSHOT handshake before
                                                 any OPS/PING/SYNC_COMPLETE/LEAVE frame is
                                                 accepted; `Gateway.close()` now terminates every
                                                 open socket so shutdown can't hang). Persistence,
                                                 acks, auth, and presence are NOT built yet
                                                 (Phases 15-17, 26-29, 31) — state is in-memory
                                                 only and lost on restart, which is correct for
                                                 this phase. Depends on engine + protocol.
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
                                                 needed). Phase 6 added a test-build-only
                                                 canary assertion at the end of Case C in
                                                 integrate() (throws if a Case C node would
                                                 have outranked the candidate — see the
                                                 Phase 6 entry below) and src/mutation/ —
                                                 the ten-mutant matrix harness (string-
                                                 patches a temp copy of this very
                                                 directory, never the real files), run via
                                                 `pnpm test:mutation`. Depends on engine.
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

- **Phase 6** — Mutation testing and the full CI gate (Test Plan §2.8,
  §14.2, §12.6). `packages/testkit/src/mutation/`: `mutants.ts` (the ten
  mutant patches, supplied verbatim by the user from Test Plan §2.8 —
  not derived); `loadMutantEngine.ts` (string-patches ONE mutant into a
  freshly-copied, freshly-transpiled `packages/engine/src` in a scratch
  temp directory — never the real source on disk — using `typescript`'s
  `ts.transpileModule` per file, then dynamically `import()`s the result;
  throws if a mutant's `find` text doesn't match exactly once, so a
  mutant can never silently become a no-op); `mutantAdapter.ts` (wraps
  the loaded engine as a `ReplicaAdapter`, reusing `runTrial.ts` — the
  SAME harness the real convergence suite uses — with an
  `withInvariants` toggle, because several mutants, e.g. M5, are
  completely invisible to pure convergence checking but caught
  immediately once `assertInvariants` is wired in); `fuzzUntilKilled.ts`
  (seed-by-seed early exit at first non-converged outcome — a real
  Phase-2/4 harness quirk surfaced here: `pendingCounts` is read AFTER
  `runTrial`'s own try/catch, so an invariant violation thrown from
  `pendingCount()` — which never happens on the real engine, hence never
  a problem before — propagated uncaught and crashed the whole matrix
  run the first time; fixed by wrapping the `runTrial` call itself,
  scoped to the mutation harness only, not the shared production code);
  `targetedChecks.ts` / `targetedProperties.ts` (a hand-picked subset of
  Phase 4/5's suites, re-implemented against the dynamically-loaded
  engine type rather than the static `@collab-editor/engine` import
  those suites use, chosen specifically so every one of the ten mutants
  has at least one direct catcher); `runMatrix.ts` / `generateReport.ts`
  (orchestration and the `docs/mutation-matrix.md` writer); `mutKill01.ts`
  (MUT-KILL-01, Test Plan §14.2 — a small/fast/high-volume trial config
  biased toward many concurrent, variously-anchored inserts per round,
  aimed at maximizing how often `integrate()`'s scan actually reaches a
  genuine Case C node). New command `pnpm test:mutation`
  (`packages/testkit/vitest.mutation.config.ts`), excluded from the
  default `pnpm test` (like convergence/properties — even at reduced
  budgets, transpiling and fuzzing ten engine variants isn't inner-loop
  material). New nightly workflow (`.github/workflows/nightly.yml`,
  `schedule` + `workflow_dispatch`) running the full matrix with
  `MUT_KILL_01_BUDGET=1000000`.

  **Two of the four hand-picked targeted checks were wrong on the first
  attempt and had to be re-derived** — a smaller-scale repeat of the
  Phase 5 lesson: a check passing against the real engine is not enough
  evidence it actually discriminates the mutant it's aimed at. The
  original M2 check (Engine Spec §10.3's HELLO/ELL/x/HxO trace) turned
  out to be structurally immune to `M2_no_right_bound` — nothing in that
  scenario ever "wins" a comparison it shouldn't, so the unbounded scan
  window never changes the outcome. The original M9 check (delete →
  undelete → later delete) turned out to be immune to
  `M9_delete_first_wins` too — an undelete arriving right after a delete
  resets the "already deleted" snapshot either way, so both correct and
  buggy attribution reach the same answer in that specific sequence.
  Both were re-derived by hand-tracing the actual mutated algorithm step
  by step (not by trial and error against the running code) until a
  genuinely discriminating scenario was found: for M2, base content with
  a SMALLER replica id than the two concurrently-competing inserters, so
  the (incorrectly) unbounded scan lets the base nodes "win" and cascade
  `destIndex` to the very end of the document (verified: baseline
  produces `"ApqBCD"`, M2 produces `"ABCDpq"`); for M9, two deletes with
  NO undelete between them (so the first delete's attribution is never
  overwritten under the bug), followed by an undelete whose id sits
  between the two deletes' — correct attribution makes it a no-op,
  "first wins" attribution makes it wrongly succeed (verified: baseline
  produces `"AC"`, M9 produces `"ABC"`).

  **Matrix result reproduces Test Plan §2.8's shape exactly**: M1, M6,
  M7, M8, M10 killed by the pure-convergence fuzzer at seed 0 or 1; M2,
  M4, M9 survive both fuzzer passes and are killed only by their
  targeted adversarial check; M5 survives the pure-convergence fuzzer
  but is killed the moment invariant assertions are added (both via the
  invariant-enabled fuzzer pass AND the targeted I0 check) — matching
  "M2, M4, M5, M9 survive the fuzzer" if "the fuzzer" means pure
  convergence specifically, which is exactly the distinction
  `mutantAdapter.ts`'s two-column design exists to preserve.
  `M3_no_case_c` survives every suite in the matrix (fuzzer with and
  without invariants, targeted adversarial, targeted properties).

  **MUT-KILL-01 ran to the full 10^6-trial budget and did NOT kill
  M3_no_case_c** (`{killed:false, trials:1000000}`, ~975s wall time at
  ~0.92ms/trial). This is an accepted, documented outcome, not a Phase 6
  failure — the Test Plan and Implementation Plan built the Case C
  canary specifically as the fallback for exactly this result. Timed a
  50,000-trial sample first (~46s) to extrapolate the full-budget
  runtime before committing to it.

  **The Case C test-build canary** (added to `integrate()` per the
  Definition of Done's "if M3 survived" branch — M3 did): restates
  Engine Spec §6.2 sub-case iii-d's claim as a live assertion — if a
  Case C node would have outranked the candidate in a same-window
  comparison, that's a witness that NOT breaking there (M3's mutation)
  could have moved `destIndex`, which would disprove sub-case iii-d.
  Verified it never fires across `pnpm test` (54 tests), `pnpm
test:properties` (60,000 generated cases), `pnpm test:adversarial` (22
  cases), and the real 10^6-trial MUT-KILL-01 run above (which loaded
  the UN-mutated `compareRank`, since M3's own patch only removes the
  trailing `break` — the canary and its comparison logic stay intact
  under M3's specific mutation). It fired exactly once anywhere in this
  phase's work — not on M3, but incidentally on `M1_rank_by_counter`
  during the mutation matrix's own targeted-properties check: M1
  redefines module-level `rank()`/`compareRank()` to compare by Lamport
  counter instead of replica id, and since the canary reuses that SAME
  (now-mutated) `compareRank`, two same-replica nodes reaching Case C in
  counter order tripped its "other outranks node" condition. This is a
  real, if incidental, second detection path for M1 (already killed at
  seed 0 by the fuzzer regardless) — not a false positive on the
  UN-mutated engine, since the canary's own logic and the function it
  calls only diverge from correct behavior when M1's specific patch is
  loaded. It DID surface a real harness bug, though:
  `targetedProperties.ts`'s PROP-1/PROP-2 loops had no try/catch around
  each trial (unlike `fuzzUntilKilled.ts`, already hardened for exactly
  this in Phase 6's first crash) — the canary's exception propagated
  uncaught and crashed the whole matrix run instead of being recorded as
  a kill. Fixed by wrapping each trial body in try/catch, treating a
  thrown exception as a detected mutant (consistent with how the rest of
  the harness already treats an uncaught throw). M3's mutant patch in
  `mutants.ts` was updated to anchor on the Case C block's closing lines
  rather than the whole comment, specifically so it survives future
  edits to the (now much longer) canary explanation without needing
  another patch update.

- **Phase 7** — Binary wire codec (API/Protocol/Data Spec v1.0 §1.3–§1.4,
  §3.1, §3.2, §3.5; Test Plan §11.2). Built in two passes, and — like
  Phase 5 — that matters for how much to trust it.

  **Pass 1** was built without the literal spec text in context, only the
  section citations and requirements listed in the phase brief. **Pass 2**
  followed immediately after the user supplied the real §1.3/§1.4/§3.1/
  §3.2/§3.5 text verbatim and asked for a field-by-field comparison. That
  comparison found the self-derived layout WRONG in several load-bearing
  ways, corrected below — the same "green on the first run is not
  evidence it matches an unseen spec" lesson Phase 5 already taught this
  project, now repeated one layer down (wire bytes, not test scenarios):

  - **An invented frame-level reserved-flags byte, right after the 3-byte
    envelope, does not exist in the spec.** §3.2 is explicit: the
    envelope is exactly 3 bytes (protocolVersion, channel, messageType)
    and the payload starts immediately at offset 3 — "no frame-level
    length prefix... no correlation id" and (per this correction) no
    frame-level flags byte either. This was the direct cause of the
    single-insert size landing at 19 bytes instead of spec's 18 —
    removing the invented byte closes the gap exactly, now verified with
    `expect(bytes.length).toBe(18)`, not an approximate range.
  - **`channel` and `messageType` numeric values were wrong.** Pass 1
    used small sequential integers starting at 0. The real values are
    `channel`: OPS=`0x01`, PRESENCE=`0x02`, CONTROL=`0x03`; `messageType`
    (namespaced within OPS): OP_INSERT=`0x01`, OP_INSERT_RUN=`0x02`,
    OP_DELETE=`0x03`, OP_DELETE_BATCH=`0x04`, OP_UNDELETE=`0x05`,
    OP_ACK=`0x10`, OP_REJECT=`0x11` — note the jump to `0x10`/`0x11` for
    the two server-only types, not `0x06`/`0x07`.
  - **OP_DELETE/OP_UNDELETE's field layout and field ORDER were wrong.**
    Pass 1 wrote `id` (as a stamp) then `target`. The real layout is
    `target` (a stamp) FIRST, then the deleting operation's own identity
    as two separate varints, `at` (the counter) and `by` (the replica) —
    same two numbers as a stamp, same order (counter then replica), but a
    different field NAME and a different POSITION relative to `target`.
    `OpDeleteMessage`/`OpUndeleteMessage`'s TypeScript shape is unchanged
    (`{ id, target }`) — only `codec.ts`'s wire order changed, writing
    `target`, then `id.c`, then `id.r`.
  - **OP_INSERT_RUN was substantively wrong**, not just reordered: `bind`
    is ONE flag for the WHOLE run (§3.5.2: "bind applies to the WHOLE
    run"), not a per-character bitmap — Pass 1 invented a bitmap that
    doesn't exist on the wire. And the run's characters are NOT encoded
    as a list of individual varint scalars; §3.5.2 encodes them as
    `varint count` + `varint byteLength` + `bytes utf8` — the run's
    scalars re-encoded as a UTF-8 string. Fixed by reconstructing the
    string with `String.fromCodePoint(...values)` on encode and
    `Array.from(text, ch => ch.codePointAt(0))` on decode (which
    correctly handles astral code points via JS's per-code-point string
    iteration), plus a new check that the decoded scalar count matches
    the declared `count` (`RUN_LENGTH_MISMATCH` if not). Also: the spec
    requires `n >= 2` for a run (single characters go through OP_INSERT
    instead) — Pass 1 allowed `n >= 1`; now enforced both at encode
    (`RangeError`) and decode (`ProtocolDecodeError` reason
    `RUN_TOO_SHORT`). `OpInsertRunMessage.replicaId`/`startCounter` were
    renamed to a single `firstId: Identifier`, matching the spec's own
    field name. The originLeft-chains/originRight-shared expansion logic
    itself (§3.5.2's expansion table) was correct in Pass 1 and is
    unchanged — see the dedicated paragraph below.
  - **OP_DELETE_BATCH's minimum count was wrong** (allowed `n >= 1`, spec
    requires `n >= 2`, same reasoning as the run) — now enforced
    identically. Field layout/order (`seq`, `by`, `atFirst`, `count`,
    `target[]`) was already correct in Pass 1; fields were renamed from
    `replicaId`/`startCounter` to `by`/`atFirst` to match the spec text.
  - **OP_ACK and OP_REJECT were modeled as single-operation messages with
    their own `seq`; both are actually BATCH messages with no `seq` field
    at all.** §3.5.7: `varint count` followed by `count` pairs of
    `(ackSeq, ackStamp)`. §3.5.8: `varint count` followed by `count`
    pairs of `(stamp, reason)`, THEN a single shared `varint detailLength`
    + optional UTF-8 `detail` bytes for the whole frame. Both message
    types were restructured accordingly (`OpAckMessage.acks:
readonly AckEntry[]`, `OpRejectMessage.rejects: readonly RejectEntry[]`
    + `detail: string`, empty string meaning absent/`detailLength: 0`) —
    a shape change, not a byte-order fix, since the TypeScript types
    themselves were wrong, not just their wire encoding. Because these
    two types carry no `seq`, `decodeFrame()` no longer applies the
    client-seq check to them; instead it now rejects a client-origin
    OP_ACK/OP_REJECT outright (`MESSAGE_NOT_VALID_FROM_CLIENT`), since
    §3.5.7/§3.5.8 mark both "S→C" only — a real directionality
    constraint Pass 1 had no way to encode at all under the old
    single-op-with-seq shape.
  - **The 7 `RejectReason` codes were entirely invented names/values in
    Pass 1**, not derived from anything in the brief beyond "exactly 7
    codes, no conflict code." The real 7, values and names both taken
    verbatim from §3.5.8: `PERMISSION_DENIED=0x01`, `SESSION_EXPIRED=
0x02`, `IDENTITY_MISMATCH=0x03`, `MALFORMED=0x04`, `RATE_LIMITED=0x05`,
    `OFFLINE_WINDOW_EXCEEDED=0x06`, `DOCUMENT_LOCKED=0x07`. The "no
    conflict code, and there never will be" comment (PRD FR-CE-7) is
    unchanged in spirit — §3.5.8 states the identical rule verbatim.
  - **What Pass 1 got RIGHT and needed no change**: the varint (LEB128,
    division/modulo not bitwise ops), stamp (`varint c, varint r`,
    counter first), optional-stamp (presence-bit-gated, ⊥ never a
    sentinel), string (`varint byteLength` + UTF-8), uuid (16 raw bytes)
    and scalar (`varint codePoint`) primitives; the identity decision
    (origin stamp IS the operation identity, no separate UUID, API Spec
    §1.4); OP_INSERT's field layout and flags-byte bit assignment
    (bit0/bit1/bit2 = originLeft/originRight/bind present, bits 3-7
    reserved); and — most importantly — OP_INSERT_RUN's origin-expansion
    RULE itself (`originLeft` chains to the previous node, `originRight`
    is the SAME shared value for every node in the run, never chained) —
    confirmed correct by comparing directly against the spec's own
    expansion pseudocode, unchanged from Pass 1.

  **Everything else in the file layout is unchanged from Pass 1**:
  `bytes.ts` (`ByteWriter`/`ByteReader`, bounds-checked, throw not crash);
  `varint.ts`; `primitives.ts`; `messages.ts` (now holding the corrected
  enums/types above, plus new `AckEntry`/`RejectEntry` interfaces for the
  batch entries); `codec.ts` (`encodeFrame`/`decodeFrame` — 3-byte
  envelope with NO extra frame-level byte, `direction: "clientOrigin" |
"serverOrigin"`-checked `seq` per bidirectional message type, the
  OP_ACK/OP_REJECT client-origin rejection, plus `debugProject(bytes) →
unknown`); `expand.ts` (`expandInsertRun`/`expandDeleteBatch` plus the
  1:1 `opInsertToOperation`/`operationToOpInsert` family). `package.json`
  depends on `@collab-editor/engine` (types, and `Engine` itself in
  tests) and `fast-check` (mirroring `testkit`'s Phase 4 setup).

  **OP_INSERT_RUN expansion (§3.5.2)**, in `expandInsertRun`: for a run
  of `N` characters starting at `firstId`, node `j`'s id is
  `(firstId.c + j, firstId.r)`. `originLeft` CHAINS forward (node `j`'s
  `originLeft` is node `j-1`'s id, for `j > 0`; only node 0 uses the
  run's own `originLeft`), but `originRight` does NOT chain — every
  expanded node gets the SAME `originRight`, the run's own shared right
  boundary, exactly as the spec's own expansion table states ("SAME
  right origin for EVERY node in the run, not the predecessor"). `bind`
  applies uniformly to every expanded node (single flag, not per-char).
  Verified directly, not just by construction: a dedicated test builds a
  2,000-character run the normal way (2,000 sequential `localInsert()`
  calls on a real `Engine`, which is what actually produces the
  chained-`originLeft`/shared-`originRight` shape), round-trips it
  through `encodeFrame`/`decodeFrame`, expands it, feeds the result into
  one engine, separately encodes/decodes/applies the same 2,000
  characters as 2,000 individual OP_INSERT frames into a second engine,
  and asserts both produce identical text AND identical node-id
  sequences.

  **Malformed-frame rejection**, centralized in `decodeFrame()`: a
  reserved bit set in a message-specific flags byte (OP_INSERT/
  OP_INSERT_RUN's origin-presence-and-bind bits, bits 3-7 reserved), an
  unsupported protocol version, an unsupported channel, a client-origin
  bidirectional-type frame with `seq !== 0`, a client-origin OP_ACK/
  OP_REJECT (server-only), a run/batch declaring fewer than 2 members, a
  run whose declared `count` doesn't match its decoded UTF-8 text length,
  an unrecognized message type, an unrecognized `RejectReason` code, a
  frame that runs out of bytes mid-field, and trailing bytes after a
  valid payload — all throw `ProtocolDecodeError` (a stable `reason`
  string plus a message), never a raw RangeError/TypeError from an
  out-of-bounds read. Verified with dedicated tests constructing each
  malformed case by hand via `ByteWriter`.

  **`debugProject(bytes)` is deliberately tolerant of malformed input**:
  it tries `decodeFrame` as a client-origin frame, retries as
  server-origin (since OP_ACK/OP_REJECT are only ever legally
  server-origin), and if both fail returns a `{ malformed: true, reason,
message }` object rather than throwing.

  **Measured frame size**: a single OP_INSERT at counters near 50,000
  (id + originLeft + originRight all in the ~50,000 range, replica ids
  1–8, an ASCII value) encodes to exactly **18 bytes** — envelope 3 + seq
  1 + flags 1 + id stamp 4 + originLeft stamp 4 + originRight stamp 4 +
  value 1 — matching API/Protocol/Data Spec §1.3's "One insert = 18 B"
  exactly, now that the invented frame-level byte from Pass 1 is gone.

  **DoD verification, re-run after the correction**: 10,000-case
  round-trip property test across all 7 message types (now split by
  direction — bidirectional types decoded `clientOrigin`, OP_ACK/
  OP_REJECT decoded `serverOrigin`, since a real client-origin decode of
  the latter two is now a rejection, not a round-trip case); the
  2,000-char OP_INSERT_RUN-vs-2,000-individual-frames equivalence check;
  varint round-trips for 0, 127, 128, 16383, 16384, and 2^31; the exact
  18-byte measurement (`toBe(18)`, not a tolerance range); and the full
  malformed-frame suite above. `pnpm test` passes 105 tests across 13
  files (up from 96 before this correction — the new envelope/
  directionality/count-minimum checks added test cases, not just fixed
  existing ones).

- **Phase 8** — WebSocket gateway and Document Coordinator, in-memory (RFC
  §5, §4.4; API Spec §1.2, §3.3, §6.1; PRD FR-CE-7). Built against the
  real spec text pasted in up front — no self-derive-then-correct pass
  needed this time, unlike Phases 5 and 7. New `packages/server/src/`:
  `config.ts` (`loadConfig()` — reads `PORT` from `.env.example`, the
  first code in the repo to actually consume that file); `logger.ts`
  (one JSON line per event to stdout); `sendQueues.ts`
  (`ConnectionSendQueues` — see the dedicated paragraph below);
  `documentCoordinator.ts` (`DocumentCoordinator`, `SERVER_REPLICA_ID =
0`); `ingest.ts` (`toOperations()`, expanding any inbound `OpsMessage`
  into the engine `Operation[]` it represents, reusing Phase 7's
  `expand.ts` functions); `httpApp.ts` (Express, `GET /healthz`);
  `gateway.ts` (`createGateway()` — the `WebSocketServer`, connection
  lifecycle, and the ingest/broadcast pipeline); `server.ts`
  (`createCollabServer()` — one shared `http.Server` carrying both
  Express and the WS upgrade). `package.json` gained `express`/`ws`
  runtime dependencies and `@types/express`/`@types/node`/`@types/ws`
  dev dependencies.

  **`DocumentCoordinator` fields match API Spec §6.1 exactly**: `engine =
new Engine(SERVER_REPLICA_ID)` with `SERVER_REPLICA_ID = 0` (reserved,
  never allocated to a session — enforced by construction, since session
  replica ids are allocated starting at 1 by a per-coordinator counter,
  `allocateReplicaId()`, itself an explicitly-temporary Phase 8 stand-in
  for real session/identity assignment, Phases 26-29); `currentSeq:
bigint`, assigned once per ingested OPS FRAME rather than once per
  underlying engine operation — an OP_INSERT_RUN/OP_DELETE_BATCH frame
  carries exactly one `seq` field on the wire (Phase 7's corrected
  layout), so a single frame can only be stamped once; Phase 16's real
  ack design may need to revisit this granularity once OP_ACK's
  per-operation `(ackSeq, ackStamp)` pairs are actually implemented.
  `watermarks`/`opsSinceSnap`/`lastSnapAt` exist as fields, typed exactly
  as the spec names them, and are genuinely unused — no code reads or
  writes them meaningfully this phase, per the phase brief's explicit
  instruction that they're Phase 16-17 scaffolding only.

  **The three-queue design (API Spec §3.3)**: `ConnectionSendQueues`
  holds three literally separate arrays (`opsQueue`/`controlQueue`/
  `presenceQueue`), not one array with a priority field — the spec's own
  worked justification ("a presence burst already enqueued would sit
  ahead of a later operation" in a single prioritized FIFO) is exactly
  what three independent arrays avoid. Draining re-checks priority order
  (`nextFrame()`: ops, then control, then presence) after EVERY single
  frame sent, not just once per drain pass, so a higher-priority frame
  enqueued while a lower-priority backlog is draining always preempts it
  — proved directly in `sendQueues.test.ts`'s "a higher-priority frame
  enqueued mid-drain preempts a lower-priority backlog" test. One
  genuine implementation subtlety, documented at both the code and the
  test level: `pump()` dequeues and starts sending the very FIRST frame
  the instant a queue transitions from idle to non-idle, synchronously,
  before any `await` — this is unavoidable (a network write already
  started can't be un-sent) and correct, but it means a test that
  enqueues a whole burst in one synchronous loop will see whatever
  landed in the previously-idle queue first "jump the line" as the
  in-flight frame. Every ordering test in `sendQueues.test.ts` primes the
  queue with a permanently-blocked send first, so the burst it then
  enqueues is genuinely all still queued (not draining) before the
  priority assertions run — this is a correct way to TEST the guarantee
  against an eagerly-draining implementation, not a workaround for a bug.
  PRESENCE's backpressure policy ("Shed newest-but-one", §3.3) is
  interpreted as: while backpressured, enqueuing a new presence frame
  first pops whatever is currently the newest frame in the presence
  queue, then pushes the new one — so the frame about to become
  "newest-but-one" relative to the new arrival is the one shed. OPS and
  CONTROL never shed under backpressure ("Queue and block" / "Queue") —
  those two arrays are left unbounded, relying on the caller to apply
  real backpressure upstream if they grow unreasonably (not built this
  phase — no scope bullet asked for it, and there's no persistence yet
  to make an unbounded OPS backlog meaningfully dangerous beyond memory).

  **The ingress pipeline** (`gateway.ts`'s `ingestOperation`, matching
  the phase brief's own "decode → engine.applyRemote → assign seq →
  broadcast to peers" verbatim): `decodeFrame(bytes, { direction:
"clientOrigin" })` (already rejects OP_ACK/OP_REJECT as
  `MESSAGE_NOT_VALID_FROM_CLIENT`, Phase 7); `toOperations(msg)` expands
  the message to one or more engine `Operation`s, each applied via
  `coordinator.engine.applyRemote()`; `coordinator.currentSeq += 1n`;
  the SAME message shape is re-encoded with `seq: Number(currentSeq)` and
  broadcast to every OTHER session in the room via `queues.enqueue("ops",
...)` — relaying the original run/batch representation rather than
  expanding it into individual OP_INSERT frames on the wire, preserving
  Phase 7's compact encoding for peers too. The sender is never echoed
  its own operation back (verified by `gateway.test.ts`). No OP_ACK is
  sent to the sender — acks require durable storage that doesn't exist
  until Phase 16, exactly as the phase brief's Scope-IN bullet states.

  **Room membership / `documentId` binding (API Spec §1.2)**: "bound to
  exactly one document at handshake time and never rebinds" is
  satisfied literally — `documentId` is read ONCE from the WebSocket
  upgrade URL's query string at connect time and never consulted again
  for that socket — but the MECHANISM (a query parameter) is an
  explicitly-temporary Phase 8 stand-in, called out in both the code
  comment and here: the real handshake (Phase 9) will replace it with
  whatever CONTROL-channel message that phase actually specifies. This
  was a deliberate choice to satisfy "one socket, one document, bound at
  connect" without inventing any CONTROL-channel byte layout — the phase
  brief's explicit stop-and-ask condition was about message FRAMING
  (byte layouts/field names), which a URL query parameter never touches.
  A `DocumentCoordinator` is created lazily on first connection to a
  `documentId` and removed once its last session disconnects (Phase
  8-only resource hygiene, not a spec requirement — with no persistence
  yet, an empty in-memory room serves no purpose).

  **Binary-frames-only enforcement**: `ws`'s `message` event's
  `isBinary` flag is checked on every message; a text frame closes the
  socket with code 1003 immediately, before any decode is attempted.
  Malformed BINARY frames (a `ProtocolDecodeError` from `decodeFrame`)
  close with code 1008 rather than crashing the connection or being
  silently ignored — logged first via `logger.warn` with the specific
  `reason` code, then closed.

  **DoD verification**: `pnpm test` passes 117 tests across 15 files
  (up from 105) — `sendQueues.test.ts` (6 tests, priority draining +
  backpressure shedding + separate-queue-objects proof, no network) and
  `gateway.test.ts` (6 tests, all against a REAL `createCollabServer()`
  bound to an ephemeral port and REAL `ws` client connections, no
  browser): the health endpoint, a raw client exchanging a binary
  OP_INSERT frame and the server engine reflecting it (`coordinator.
engine.text() === "a"`), a text frame closing with 1003, a missing-
  `documentId` connection closing with 1008, two real WebSocket clients
  each driving their own local `Engine` — one inserts, the relayed frame
  reaches the other re-stamped with a nonzero server-assigned `seq`, and
  both engines' `text()` converge — and a concurrent-insert variant
  (both clients insert at position 0 in the same tick) converging to the
  same 2-character text on both sides via the real OBSEQ algorithm, not
  a mock.

- **Phase 9** — Sync handshake, fresh connection (API/Protocol/Data Spec
  §3.6.1–§3.6.3, §3.6.8, §3.6.11, §3.7.1; Test Plan §11.2). Built against
  the real spec text pasted in up front — like Phase 8, no self-derive-
  then-correct pass needed. New `packages/protocol/src/`:
  `controlMessages.ts` (`ControlMessageType` — HELLO=0x01 through
  GOODBYE=0x0E, spec-exact; the 9-member `ControlMessage` union this
  phase implements — `HelloMessage`, `WelcomeMessage`, `SnapshotMessage`,
  `SyncCompleteMessage`, `PingMessage`, `PongMessage`, `LeaveMessage`,
  `GoodbyeMessage`, `ErrorMessage`; `GoodbyeReason` with spec-exact 0-3
  values; `SessionRole`/`SyncMode`/`SnapshotForm` enums); `controlCodec.ts`
  (`encodeControlFrame`/`decodeControlFrame` — same 3-byte-envelope shape
  as OPS, `channel = CONTROL (0x03)`, C→S/S→C direction enforcement
  mirroring Phase 7's OP_ACK/OP_REJECT pattern); `snapshotBody.ts` (see
  its own paragraph below). `messages.ts` gained `peekChannel()` — reads
  offset 1 directly, letting `gateway.ts` pick OPS vs. CONTROL decoding
  without committing to either first, now that one socket carries both.
  New `packages/server/src/`: `handshake.ts`, `heartbeat.ts`; `gateway.ts`
  rewritten around a real handshake instead of Phase 8's `documentId`
  query param; `documentCoordinator.ts`'s `CoordinatorSession` extended
  with session state.

  **The SNAPSHOT structure-form body (`snapshotBody.ts`) is a genuinely
  different kind of placeholder than Phase 5/7's unverified-guess
  caveats, and is documented as such rather than flagged identically.**
  The API Spec explicitly leaves this byte layout undefined for this
  phase — not "not yet pasted," but structurally deferred, because the
  real serialization depends on block run-length encoding (Engine Spec
  §7.5), which isn't built until Phase 20. So this phase's design (one
  record per node — `flags` byte with bit0/1/2/3/4 =
  hasOriginLeft/hasOriginRight/bind/deleted/hasDeletedBy, then `stamp id`,
  optional origin stamps, `scalar value`, optional `stamp deletedBy`,
  reusing Phase 7's stamp/optional-stamp/scalar primitives directly) is
  EXPECTED to be replaced/reworked in Phase 20, not merely "possibly
  wrong until cross-checked." The resolution path is "rebuild it in
  Phase 20," not "paste the real spec text and diff." Confirmed to
  actually round-trip and correctly seed a fresh client's view: an engine
  with inserts, a concurrent delete, and tombstones present round-trips
  through `encodeStructureSnapshotBody`/`decodeStructureSnapshotBody`
  with every field intact (`snapshotBody.test.ts`), and separately, two
  and three real WebSocket clients joining a document with existing
  content each decode a SNAPSHOT whose visible text matches exactly
  (`gateway.test.ts`).

  **Two real bugs surfaced integrating Phase 8's code with Phase 9's
  requirements — both fixed, not worked around**:
  1. Phase 8's "delete the coordinator when its last session leaves"
     hygiene (invented in Phase 8, not spec-mandated) directly violated
     API Spec §3.6.2's "replica ids NEVER reused, NEVER reclaimed":
     deleting the coordinator resets its replica-id counter, so a
     document that empties out and is rejoined would silently hand out
     an already-used id. Caught by this phase's own DoD test (50
     sequential connect/disconnect cycles all landed on replica id 1
     instead of 1..50). Fixed by simply not deleting the coordinator on
     empty — with no persistence yet, keeping it alive in memory for the
     process's lifetime is the only way to honor "never reused," and is
     no different in kind from Phase 8's own "state is in-memory only"
     stance.
  2. `Gateway.close()` only called `wss.close()`, which stops accepting
     new connections but does nothing to already-open sockets — a test
     leaving any WebSocket connection open past the end of a test hung
     `httpServer.close()` (and the test's `afterEach` hook) for the full
     10-second hook timeout. Fixed by having `close()` iterate `wss.clients`
     and `terminate()` every open socket first. This is a real production
     robustness fix, not just a test convenience — the old code would have
     hung an actual graceful shutdown attempt the same way with any client
     still connected.

  **WELCOME's participant list membership** (does it include the session
  currently being welcomed, or just "everyone else"?) isn't specified
  either way by the spec text — an application-level scoping choice, not
  a byte-layout invention, so decided here rather than asked about (the
  same category of call Phase 8 made for its `documentId` interim
  binding and replica-id allocation scheme): `listParticipants()` returns
  the full roster INCLUDING the new session, treating WELCOME as a
  complete point-in-time snapshot rather than special-casing "everyone
  but me."

  **`ErrorMessage`'s wire format is fully implemented and round-trip
  tested, but nothing constructs one this phase.** The spec text
  available doesn't enumerate `code`'s semantic values (unlike
  `RejectReason`, which Phase 7 got verbatim), and no DoD scenario
  requires sending one — protocol violations during handshake instead
  reuse Phase 8's existing pattern of closing with a specific WebSocket
  close code (1008 for a decode failure or "first frame wasn't HELLO",
  1003 for a text frame). Documented in `controlMessages.ts` so a later
  phase that needs real error codes defines them against real spec text
  rather than inventing them here under schedule pressure.
  `GoodbyeMessage`/`LeaveMessage` are similarly fully implemented and
  round-trip tested; `LEAVE` is handled (logged) when received, but
  session-eviction paths that would legitimately SEND a `GOODBYE` are
  Phase 21 scaffolding, per the phase brief, so nothing constructs one
  yet either.

  **Heartbeat (§3.6.11)**: `heartbeat.ts` keeps `PING_INTERVAL_MS` (3s),
  `PRESENCE_STALE_MS` (8s), and `SESSION_INACTIVE_MS` (10min) as three
  separate constants per the phase brief's explicit "do not merge them"
  instruction, even though the first two are numerically close and easy
  to conflate. Only the first two are live: `onPingReceived()` updates
  `lastPingAt`, clears `presenceStale` (logging a fresh transition if it
  was set), and re-arms an 8-second timer (`armPresenceStaleTimer`) that
  marks the session stale and logs a warning if it fires — no presence
  system exists to actually remove anything yet (Phase 31), so "removed"
  per the spec text becomes "logged/marked" per the phase brief's own
  scoping. `SESSION_INACTIVE_MS` is defined and cited (API Spec §11.4 in
  a comment) but read by no code — intentionally scaffolding only.
  Tested with Vitest's fake timers (`vi.useFakeTimers()`/
  `advanceTimersByTime()`), not real waits: a 9-second advance with no
  intervening ping marks a session stale exactly at the 8,000ms boundary
  (not before), a ping received at 7s resets the window, and a simulated
  5 minutes of on-schedule 3-second pings never marks the session stale
  — proving the DoD's "keeps a connection alive for 5 minutes idle"
  claim without a literally-5-minute-long test. Also verified over a
  REAL WebSocket connection in `gateway.test.ts`: a real PING gets a real
  PONG on the CONTROL channel (not OPS), echoing `clientTimeMs` and
  reporting `serverSeq`, and `coordinator.watermarks` — Phase 8
  scaffolding, unused until now — is live as of this phase, updated from
  each PING's `lastAppliedSeq`.

  **A subtle test-harness race, not a product bug, that's worth
  remembering**: the first version of `gateway.test.ts`'s handshake
  helper called `ws.once("message", ...)` separately for WELCOME and then
  again for SNAPSHOT. Because the server enqueues both back-to-back, the
  SNAPSHOT frame could arrive and fire with NO listener attached in the
  gap between awaiting WELCOME and registering the next `once` — a
  classic missed-event race, not a server defect. Every affected test
  hung until diagnosed. Fixed with an `IncomingFrames` buffering reader
  registered once, immediately after the socket opens, that queues
  frames arriving with no active waiter and hands them out FIFO — the
  same shape of fix a real client SDK would need for the same reason.

  **DoD verification**: `pnpm test` passes 147 tests across 19 files (up
  from 117) — `controlCodec.test.ts` (11 tests, including a 5,000-case
  round-trip property test for each direction), `snapshotBody.test.ts`
  (5 tests, including a 2,000-case round-trip property test and a real
  `Engine`'s node list), `handshake.test.ts` (5 tests — the DoD's
  "SNAPSHOT form:0 to an editor is rejected in code" requirement, plus
  `assertSnapshotFormAllowed`'s VIEWER/STRUCTURE-always-allowed cases),
  `heartbeat.test.ts` (6 tests, fake-timer-based, described above), and
  `gateway.test.ts` (9 tests, rewritten around the real handshake): a
  fresh client completing HELLO→WELCOME→SNAPSHOT→SYNC_COMPLETE against a
  real server; two AND three real clients joining a document with
  existing content each receiving it correctly via SNAPSHOT; 50
  sequential connect/disconnect cycles all landing on 50 distinct
  replica ids in order; a non-HELLO first frame closing with 1008; a
  text frame closing with 1003 even mid-handshake; cross-client
  convergence still working end-to-end through the new handshake; and
  the two real-connection heartbeat checks described above.

## Current phase in progress

None — Phase 9 complete, awaiting Phase 10.

## What is explicitly NOT yet built

Undo/redo's real resurrection semantics beyond Undelete's structural
inverse (Phase 36); the indexed position structure (Phase 19) — integrate()
currently locates origins via a linear `indexOf` scan, not an index; garbage
collection (Phase 21); block run-length encoding (later, alongside GC) — and
because of that, SNAPSHOT's structure-form body serialization
(`packages/protocol/src/snapshotBody.ts`) is a deliberate Phase 9 placeholder
EXPECTED to be reworked in Phase 20, not a finished format. The OPS and
CONTROL channels both now flow end to end (Phases 7-9); PRESENCE message
types and any presence broadcast do not exist yet (Phase 31) — a stale
session is only logged/marked, never actually removed from anything.
Reconnection (CATCHUP/ALREADY_HAVE, API Spec §3.6.4-§3.6.7) is not built —
only fresh connections work; a client that disconnects and reconnects
completes a brand-new fresh handshake (with a brand-new replica id) rather
than resuming. Session-inactivity eviction (10 minutes with no PING) is
scaffolded (constant defined, cited to §11.4) but not wired to anything —
Phase 21's concern. No persistence (no database schema, no snapshotting,
no acks — `DocumentCoordinator`'s `opsSinceSnap`/`lastSnapAt` fields exist
but are unused no-ops, Phases 15-17; `watermarks` is live as of Phase 9 but
only in memory, nothing durable); no auth (Phases 26-29) — any WebSocket
client can join any document by guessing its id and is unconditionally
granted the EDITOR role, which is correct for this phase and not yet a
security concern since nothing is exposed publicly; no client (no React
app, no editor binding, no DOM rendering); no permissions; no offline/
reconciliation logic; no version history; no Docker setup; no deployed
environment. Server state is in-memory only and lost on restart — correct
through Phase 9, not yet for anything after Phase 15. GitHub branch-
protection required-status-check wiring for
`convergence`/`properties`/`nightly-mutation-matrix` remains a manual,
one-time repo-settings action, as does the nightly workflow's first
manual `workflow_dispatch` trigger (Claude cannot push branches or
trigger GitHub Actions runs).

## Key technical decisions with source citations

- **A mutation-testing check passing is not evidence it can catch its
  target mutant — only a hand-trace of the MUTATED algorithm against
  that exact input is.** Phase 6's first M2 and M9 targeted checks both
  passed against the correct engine and were written specifically "for"
  those mutants, yet both turned out to be structurally immune to the
  bug they were meant to catch (see the Phase 6 completed-phase entry
  for the full trace of each). The failure mode was identical both
  times: picking an input because it touches the right code region, not
  because tracing the MUTATED code line by line against that exact input
  proves it produces a different final state than the correct code. This
  is the same shape of mistake Phase 5 made with self-invented adversarial
  cases (below), one level more subtle — here the check even NAMED the
  right mutant and still didn't discriminate it. The fix both times: hand
  simulate the mutated algorithm specifically (not re-verify the correct
  one) to find the precise structural precondition the bug needs to
  become externally visible, derive the expected literal from that
  simulation BEFORE running anything, then confirm the run matches the
  prediction rather than accepting whatever it happened to produce.
- **The mutation harness had two "propagates uncaught and crashes the
  whole matrix" bugs, both surfaced by mutants actually misbehaving in
  ways the harness's happy-path code never anticipated.** `fuzzUntilKilled.ts`
  originally called `runTrial()` unwrapped; `runTrial.ts`'s own
  try/catch covers generation/delivery but its `pendingCounts` read
  happens AFTER that block (never a problem for the real engine, hence
  never noticed before), so an `assertInvariants` violation thrown from
  `pendingCount()` crashed the run instead of counting as a kill.
  `targetedProperties.ts` had the same shape of gap: no try/catch around
  each PROP-1/PROP-2 trial, so the Case C canary firing (incidentally,
  under `M1_rank_by_counter` — see the Phase 6 entry) crashed the whole
  matrix instead of being recorded. Both fixed the same way: wrap the
  call, treat any thrown exception as a detection. The lesson: a harness
  built and tested only against a CORRECT engine will have exactly this
  class of latent gap, because "the code we're testing might throw from
  a place we assumed was safe" is precisely what mutation testing is
  for — the bugs it found in its own scaffolding are as real a signal as
  the mutants it killed.
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
cp .env.example .env   # PORT is now read by packages/server/src/config.ts (Phase 8)
pnpm lint
pnpm format:check
pnpm typecheck
pnpm check:purity
pnpm test
```

There is still no `pnpm dev`/`start` script wired up to actually run the
server standalone. `packages/server` builds (`tsc`) and typechecks cleanly,
but running the compiled output directly (`node dist/index.js`) currently
fails at import time — verified, not assumed: `@collab-editor/engine` and
`@collab-editor/protocol`'s `package.json` still point `main`/`types` at
`./src/index.ts` (a pre-existing decision from Phase 0, "no project-level
TypeScript references between packages"), which plain Node cannot import as
a module once server's OWN code has been compiled to `dist/`. This has no
effect on `pnpm test` (Vitest transpiles on the fly, so `gateway.test.ts`
starts a real server via `createCollabServer()` + `listen()` and it works
fine there) — it only affects a hypothetical standalone `node
dist/index.js` invocation outside the test runner, which nothing in this
project has needed until Phase 8. Fixing it (project references, a
bundler, or switching every package's `main` to point at compiled output)
is not itself part of any phase's stated scope yet and wasn't attempted
here to avoid scope creep — flagging it now so it isn't mistaken for an
untested claim later.

## How to run the test suite

```bash
pnpm test              # Vitest, all packages EXCEPT the convergence + property suites, single run
pnpm test:watch        # Vitest, watch mode
pnpm test:convergence  # the convergence suite ONLY — C1-C6, 10,000 seeds each, invariants active
pnpm test:properties   # the property-based suite ONLY — PROP-1..5, 10,000 generated cases each
pnpm test:adversarial  # the adversarial suite ONLY — ADV-01..22, hand-constructed, also part of `pnpm test`
pnpm test:mutation     # the mutation matrix — ten mutants x four suites, MUT-KILL-01 at a small sanity budget
```

`pnpm test` currently passes: 147 tests across 19 files, including
`packages/engine/src/engine.test.ts` (10 tests — Phase 1's identifier/clock
tests plus Phase 3's five origin-bounded-integration tests: the §10.1,
§10.3, §10.5, and §10.7 worked-trace hand-verifications plus one longer
insert/delete round-trip), `packages/testkit/src/adversarial/
adversarial.test.ts` (22 tests — see the Phase 5 entry above),
`packages/testkit/src/fuzz/harness.selftest.test.ts`, which proves the
fuzz harness itself works (detects a deliberately broken toy engine as
divergent, and completes 10,000 toy-engine seeds in ~2s, well under the
30s bar), Phase 7's `packages/protocol/src/*.test.ts` (52 tests, after
the Pass-2 spec correction: 17 varint round-trip/boundary/malformed-input
cases, 7 primitive round-trip cases, and 27 codec tests — a 10,000-case
round-trip property test across all 7 OPS message types split by
direction, 4 envelope/enum-value checks including the exact-18-byte
OP_INSERT measurement, the 2,000-character OP_INSERT_RUN-vs-2,000-
individual-frames equivalence check, 10 malformed-frame rejection cases
including OP_ACK/OP_REJECT client-origin rejection and run/batch
minimum-count enforcement, and debugProject coverage for every message
type), and Phase 8's `packages/server/src/*.test.ts` (12 tests:
`sendQueues.test.ts`'s 6 tests proving the three physical queues are
separate objects, strict priority draining re-evaluated after every
frame, mid-drain preemption, and PRESENCE's backpressure-shed policy,
all with no network involved; `gateway.test.ts`'s 6 tests against a REAL
`createCollabServer()` on an ephemeral port with REAL `ws` client
connections — the health endpoint, binary frame exchange, a text frame
closing with 1003, a missing-`documentId` connection closing with 1008,
and two real WebSocket clients each driving their own local `Engine`
converging, both sequentially and under genuine concurrency), and Phase
9's additions: `packages/protocol/src/controlCodec.test.ts` (11 tests,
including a 5,000-case round-trip property test per direction) and
`snapshotBody.test.ts` (5 tests, including a 2,000-case round-trip
property test), plus `packages/server/src/handshake.test.ts` (5 tests),
`heartbeat.test.ts` (6 tests, fake-timer-based), and a rewritten
`gateway.test.ts` (9 tests, now built around the real HELLO/WELCOME/
SNAPSHOT handshake rather than Phase 8's `documentId` query param — see
the Phase 9 completed-phase entry above for what each test covers,
including the 50-cycle distinct-replica-id check and the two real-bug
fixes that check surfaced).

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

`pnpm test:mutation` currently PASSES: 9 of the 10 Test Plan §2.8
mutants killed by at least one of four suites (pure-convergence fuzzer,
invariant-checked fuzzer, targeted adversarial checks, targeted property
checks); `M3_no_case_c` survives every suite here, which is expected —
it's exactly why MUT-KILL-01 exists. Writes `docs/mutation-matrix.md` on
every run. Excluded from the default `pnpm test` (transpiling and
fuzzing ten engine variants isn't inner-loop material, even at the
reduced sanity budget this command uses); the authoritative full
10^6-trial MUT-KILL-01 run is separate (`MUT_KILL_01_BUDGET=1000000`,
what the nightly workflow sets) — see the Phase 6 completed-phase entry
above for its result.
