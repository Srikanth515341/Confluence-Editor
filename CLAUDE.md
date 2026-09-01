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
                                                 independently replay the clock. Phase 19
                                                 added positionIndex.ts (PositionIndex, an
                                                 implicit-key treap with O(log N) expected
                                                 indexOf/nodeAtVisible/visibleIndexOf/
                                                 splice/setDeleted, Engine Spec §8.5) —
                                                 engine.ts's node storage now lives there
                                                 instead of a flat array; `nodes` is a
                                                 getter (in-order traversal) for backward
                                                 compatibility with every existing caller.
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
                                                 Phase 17 added src/snapshotSeed.ts
                                                 (`replaySnapshotNodesInto`/`seedEngineFromSnapshot`
                                                 — the decoded-snapshot-to-Engine replay logic,
                                                 MOVED here from packages/client/src/sync/
                                                 snapshotSeed.ts once the server's own coordinator
                                                 warm start needed the identical algorithm; unlike
                                                 wireHelpers.ts's deliberate client-side
                                                 duplication of server logic — required because a
                                                 client must never depend on @collab-editor/server
                                                 — both client and server already depend on this
                                                 package, so a genuine move was the right call, not
                                                 a second duplication). Depends on engine (already
                                                 a real, non-test dependency since Phase 7, but
                                                 only ever for Identifier/Operation/Node TYPES —
                                                 Phase 17's snapshotSeed.ts is the first place in
                                                 this package's own source that imports and calls
                                                 the actual `Engine` class at runtime, not just its
                                                 types).
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
                                                 this phase. Phase 14 (Milestone M1) added:
                                                 `documentCoordinator.ts`'s `operationLog`
                                                 (every operation this coordinator has ever
                                                 ingested, in order — in-memory only, NOT
                                                 persistence, exists purely so a fresh `Engine`
                                                 can independently replay it); `httpApp.ts`'s
                                                 `GET /v1/documents/:id/replay` diagnostic
                                                 endpoint (replays that log into a brand-new
                                                 `Engine`, Test Plan §2.7 E2E-CONV-01
                                                 assertion 3 — "the one that matters," per the
                                                 phase brief, since it's independent ground
                                                 truth rather than comparing clients to each
                                                 other or to the coordinator's own already-
                                                 running engine); `server.ts` now threads a
                                                 boxed `gatewayBox` reference through so
                                                 `httpApp.ts` can read `gateway.coordinators`
                                                 despite the app being built before the
                                                 gateway exists. Also fixed: `index.ts`'s
                                                 "run directly" entry-point check compared
                                                 `import.meta.url` against a hand-built
                                                 `` `file://${process.argv[1]}` `` string — a
                                                 real, previously-latent bug that silently
                                                 NEVER matched on Windows (`process.argv[1]` is
                                                 a plain OS path with backslashes and no
                                                 leading slash there), meaning the server
                                                 script's `server.listen()` call never actually
                                                 ran when invoked directly. Never triggered by
                                                 any prior phase's tests (all of which construct
                                                 `createCollabServer()` directly), only found by
                                                 this phase's own need to actually run
                                                 `pnpm --filter @collab-editor/server run dev`
                                                 (new script, using `tsx`, new devDependency)
                                                 for the milestone's manual demo. Fixed via
                                                 `pathToFileURL(process.argv[1])`, the portable
                                                 comparison. Phase 15 added the database schema
                                                 (API Spec §2, all eight tables) via
                                                 node-pg-migrate migrations (`migrations/`), a
                                                 `pg.Pool` wrapper (`src/db/pool.ts`), a seed
                                                 script (`scripts/seed.ts`), and a DoD test suite
                                                 run against a real Postgres instance
                                                 (`src/db/schema.db.test.ts`, `pnpm test:db`) —
                                                 not yet wired into `documentCoordinator.ts`/
                                                 `gateway.ts` at that point. Phase 16 wired it in
                                                 for real: `src/writePath.ts`
                                                 (`processIncomingOperation` — API Spec §6.3's
                                                 nine-step write path, broadcast before the
                                                 transaction, ack from inside its success
                                                 continuation, the `MUTATE_ACK_BEFORE_COMMIT`
                                                 DUR-04 mutation switch); `src/ackBatcher.ts`
                                                 (`AckBatcher`, 64 entries or 20ms); `src/db/
operationStore.ts` (`OperationStore` interface,
                                                 `PostgresOperationStore` for production,
                                                 `InMemoryOperationStore` — the new default for
                                                 every pre-Phase-16 test, keeping `pnpm test`
                                                 infra-free — plus the SAVEPOINT-based duplicate
                                                 suppression `commitOperations` needed once
                                                 `ON CONFLICT` turned out to be illegal on a
                                                 ruled table, and the users/documents/sessions
                                                 auto-provisioning warm start and every commit
                                                 depend on). `documentCoordinator.ts` gained a
                                                 `ready: Promise<void>` (warm start, replaying
                                                 the persisted log with a live `pendingCount()
=== 0` assertion) and `currentSeq` became
                                                 per-OPERATION, not per-frame (see that phase's
                                                 own entry for why the schema forced this).
                                                 `gateway.ts`'s handshake is now `async`,
                                                 awaiting a coordinator's warm start before
                                                 admitting any client. New DB-gated tests:
                                                 `src/db/durability.db.test.ts` (DUR-04, ack
                                                 batching, ON-CONFLICT-equivalent dedup, the
                                                 broadcast-latency-unaffected-by-a-slow-database
                                                 check) and `src/db/serverRestart.db.test.ts`
                                                 (a real `createCollabServer()` restart, proving
                                                 the DoD's headline claim end to end). Phase 17
                                                 added `src/snapshotter.ts` (`maybeScheduleSnapshot`
                                                 — RFC §13.2's MAYBE-SNAPSHOT, 500 ops/30s, called
                                                 as writePath.ts's own last step and never
                                                 awaited; the real work defers via `setImmediate`
                                                 so it never sits between a keystroke and its
                                                 broadcast) and redirected coordinator warm start
                                                 from an unconditional full-genesis replay to
                                                 loading the latest snapshot (`snapshots_latest_idx`)
                                                 plus only the operation-log suffix after it —
                                                 `operationStore.ts`'s `WarmStartResult` gained
                                                 `snapshotNodes`/`snapshotSeq`/`suffixOps`, and a
                                                 new `loadFullOperationLog`/`writeSnapshot` pair
                                                 rounds out the `OperationStore` interface.
                                                 `DocumentCoordinator.operationLog` was REMOVED
                                                 (no longer needed once warm start stopped loading
                                                 genesis unconditionally; `httpApp.ts`'s two
                                                 diagnostic replay endpoints now call
                                                 `loadFullOperationLog` directly, on demand,
                                                 instead of reading an in-memory array — genuinely
                                                 MORE independent of the coordinator's own live
                                                 state, not less). Phase 18 added `src/audit.ts`
                                                 (`auditDocument` — API Spec §6.6's six steps, a
                                                 real BISECT via binary search over a document's
                                                 own snapshot history), `src/auditScheduler.ts`
                                                 (`startAuditScheduler` — the in-process,
                                                 continuously-running production control, 5-minute
                                                 default interval, full 5-step audits since it has
                                                 live coordinator access), and
                                                 `scripts/admin.ts` (the standalone `./admin audit
                                                 --doc=<id> --verbose` CLI — a separate process,
                                                 DB-only, steps 1-4). `operationStore.ts` gained
                                                 six new methods (`loadFullOperationLogWithSeq`,
                                                 `getLatestSnapshot`/`listSnapshots`,
                                                 `writeAuditRun`/`listAuditRuns`/
                                                 `getLastSuccessfulAuditRunAt`); `httpApp.ts` gained
                                                 `GET /v1/documents/:id/audit-runs` (read-only —
                                                 queryable runs + the "last successful run" metric).
                                                 Depends on engine + protocol.
packages/client       @collab-editor/client   — React app + editor binding
                                                 (DomWriter, input pipeline, presence).
                                                 The only package with DOM lib types. Phase
                                                 10 built src/sync/, the browser-side
                                                 connection manager — no editor binding or
                                                 DOM writer exists yet: syncClient.ts
                                                 (SyncClient — socket lifecycle via an
                                                 injectable WebSocketLike interface so tests
                                                 can drive it with vi.useFakeTimers() instead
                                                 of real network I/O; the real global
                                                 WebSocket, available in both browsers and
                                                 modern Node, is the default); backoff.ts
                                                 (Backoff — full-jitter exponential, API Spec
                                                 §3.10); connectionState.ts (ObservableValue,
                                                 a minimal pub/sub, no external state
                                                 library); gapTracker.ts (SequenceGapTracker,
                                                 API Spec §3.7.5); unackedQueue.ts
                                                 (UnackedQueue, API Spec §7.9, keyed by origin
                                                 stamp); snapshotSeed.ts
                                                 (seedEngineFromSnapshot — rebuilds a fresh
                                                 Engine from a SNAPSHOT by replaying it as
                                                 synthetic remote operations through the
                                                 engine's own applyRemote()/drain(), never a
                                                 separate direct-mutation path); wireHelpers.ts
                                                 (client-side duplicates of the server's
                                                 ingest.ts conversion helpers — client must
                                                 never depend on @collab-editor/server at
                                                 runtime); headlessHarness.ts (no-React
                                                 connectPair/runConvergenceWorkload/
                                                 waitForConvergence/waitForState, used by this
                                                 phase's own tests and reusable by later
                                                 phases). Depends on engine + protocol;
                                                 @collab-editor/server is a devDependency
                                                 (test-only, for spinning up a real server in
                                                 integration tests — never imported by
                                                 production sync/ code). Phase 11 built
                                                 src/binding/ (the DOM render model and
                                                 position mapping) plus Playwright
                                                 infrastructure (packages/client/e2e/) — no
                                                 input handling, sentinel, or React component
                                                 exists yet: unicodeOffsets.ts (scalarToUtf16/
                                                 utf16ToScalar — the scalar-vs-UTF-16 unit
                                                 mismatch API Spec §7.2.2/§11.10 exists to
                                                 name, plus isInsideSurrogatePair, computed
                                                 independently for a real cross-check);
                                                 renderIndex.ts (RenderRun, RUN_MAX_SCALARS=
                                                 512, findRunForVis — binary search);
                                                 positionMapping.ts (visToDom, domToVis,
                                                 normalizeElementPosition for API Spec
                                                 §7.2.3's element-node selection quirks);
                                                 domWriter.ts (DomWriter — the only module
                                                 permitted to mutate the editor subtree;
                                                 mount/insertText/deleteRange with incremental
                                                 renderIndex maintenance and run-splitting at
                                                 the 512-scalar cap; assertConsistent(), the
                                                 dev-build assertion). e2e/ (Playwright, first
                                                 use in this project): playwright.config.ts
                                                 (real chromium + webkit projects);
                                                 build-bundle.mjs (esbuild — bundles src/
                                                 binding into one dependency-free browser
                                                 script, window.Binding); domPositionMapping.
                                                 spec.ts (DOM-01) and
                                                 elementSelectionNormalization.spec.ts
                                                 (DOM-03), both against real browsers, not
                                                 jsdom. Phase 12 built src/input/ (the
                                                 beforeinput dispatch pipeline) and src/editor/
                                                 (the first React component) — no sentinel
                                                 (Phase 13) or cursor transformation under
                                                 remote edits (Phase 32) exists yet:
                                                 graphemeSegmentation.ts (clusterBefore/
                                                 clusterAfter/wordBefore/wordAfter/
                                                 lineStartBefore, all Intl.Segmenter-based —
                                                 API Spec §7.4.2's explicit "use
                                                 Intl.Segmenter('word'), not a regex"
                                                 obligation, generalized to grapheme
                                                 boundaries too, operating on UTF-16 offsets
                                                 into the whole materialized document text,
                                                 independent of renderIndex/DomWriter);
                                                 inputPipeline.ts (handleBeforeInput/
                                                 attachInputPipeline — the full API Spec
                                                 §7.4.2 inputType dispatch table,
                                                 unconditional preventDefault first, always;
                                                 placeCaretAt(), which repositions the LIVE
                                                 browser Selection after every mutation —
                                                 see the Phase 12 completed-phase entry below
                                                 for the real bug this fixes). React (added
                                                 as a real dependency this phase, previously
                                                 absent from the whole repo) is used by
                                                 src/editor/EditorView.tsx, a contenteditable
                                                 root component that mounts DomWriter from a
                                                 caller-supplied, caller-connected SyncClient
                                                 and wires attachInputPipeline — the
                                                 component owns no connection-lifecycle
                                                 policy itself. `packages/client/package.json`
                                                 gained real `react`/`react-dom` dependencies
                                                 (`@types/react`/`@types/react-dom` dev). e2e/
                                                 gained a firefox project (playwright.config.ts
                                                 — Phase 12 Scope-IN: "Runs in Chromium,
                                                 Firefox and WebKit") and
                                                 inputPipeline.spec.ts, built against a SECOND
                                                 esbuild bundle (e2e/support/inputHarness.ts →
                                                 window.InputHarness, kept OUT of the
                                                 production package's own public index since
                                                 it exists purely to expose `Engine` to
                                                 browser-side e2e tests for the same
                                                 no-network SyncClient-with-a-directly-set-
                                                 `.engine` trick the Vitest unit tests use).
                                                 src/sync/ also gained two Phase 12 additions:
                                                 wireHelpers.ts's `operationsToRunMessages()`
                                                 (coalesces a sequence of locally-minted
                                                 InsertOperations into the fewest possible OPS
                                                 messages — a maximal same-bind run of ≥2
                                                 becomes one OP_INSERT_RUN, per API Spec
                                                 §3.5.2) and syncClient.ts's
                                                 `localInsertText()` (mints one
                                                 `Engine.localInsert()` per character, then
                                                 sends the result through
                                                 `operationsToRunMessages` — this is what
                                                 turns a 2,000-character paste into ONE wire
                                                 frame, verified in syncClient.test.ts by
                                                 literally counting frames on a fake socket,
                                                 not just checking the coalescing helper in
                                                 isolation). Phase 13 built src/sentinel/
                                                 (mutationSentinel.ts) — MutationObserver-based
                                                 DOM reconciliation, API Spec §7.7/§11.11: the
                                                 `MutationSentinel` class watches the editor
                                                 root (childList/subtree/characterData/
                                                 characterDataOldValue) and treats the engine
                                                 as authoritative — any DOM mutation NOT routed
                                                 through its `applyPatches(fn)` wrapper is
                                                 detected — the observer's own async callback
                                                 still holds the records `applyPatches` never
                                                 synchronously drained — and reverted by
                                                 re-rendering the WHOLE subtree
                                                 from `engine.text()`, never by interpreting
                                                 what the foreign mutation did. Every DomWriter
                                                 write in this codebase — inputPipeline.ts's
                                                 insertTextAt/deleteRangeAt, and EditorView.tsx's
                                                 initial mount and SNAPSHOT re-mounts — now runs
                                                 inside `sentinel.applyPatches()`; `sentinel` is
                                                 a REQUIRED (not optional) field of
                                                 `InputPipelineDeps` specifically so a caller
                                                 can't accidentally reintroduce an unwrapped
                                                 write. `SentinelMetrics` (`reconciliation`/
                                                 `desync_error`) are per-instance, not a
                                                 page-global singleton (deliberate — see the
                                                 Phase 13 completed-phase entry for why), queried
                                                 via `sentinel.metrics`. e2e/support/
                                                 inputHarness.ts and its bundle gained a
                                                 `MutationSentinel` export for
                                                 e2e/mutationSentinel.spec.ts (MUT-02/MUT-03,
                                                 real Chromium/Firefox/WebKit). Phase 14
                                                 (Milestone M1) built src/app/ — the first
                                                 actual demoable application: urlParams.ts
                                                 (getOrCreateDocumentId/getServerUrl — "open a
                                                 document by URL"), ConnectionIndicator.tsx,
                                                 App.tsx (composes SyncClient + EditorView,
                                                 exposes a `window.__collabDebug` test/
                                                 observability hook), main.tsx (the browser
                                                 entry point) — plus app/index.html and
                                                 scripts/serveApp.mjs (an esbuild `serve()`
                                                 dev server, used both by the manual M1 demo
                                                 and by the E2E-CONV suite for an ephemeral
                                                 per-test instance). SyncClient gained
                                                 `onRemoteOpsApplied()` (a REAL client-side
                                                 gap this milestone found necessary: without
                                                 it, nothing ever told a live EditorView a
                                                 peer's edit had landed — see the Phase 14
                                                 completed-phase entry) and `seedForTesting()`
                                                 (a named, documented test-only seeding method
                                                 replacing every prior phase's bare
                                                 `sync.engine = ...` test harness pattern, now
                                                 required since `localInsertText`/`localDelete`
                                                 also check `state.value === "synced"`, not
                                                 just `engine !== null` — a real orphaned-edit
                                                 bug this phase found and fixed, same entry).
                                                 `gapTracker.ts`'s `SequenceGapTracker` was
                                                 substantially corrected (see the Phase 14
                                                 entry for the full account) — the single most
                                                 significant finding of this phase. New
                                                 `e2e/support/`: `delayRelay.ts` (the toxiproxy
                                                 substitute — an in-process WebSocket relay
                                                 injecting ~150ms RTT, four real bugs found and
                                                 fixed in it, all documented in its own header
                                                 comment), `testServer.ts` (a REAL
                                                 `createCollabServer()` per spec file, not
                                                 globalSetup — see its own comment for why),
                                                 `testAppServer.ts` (wraps scripts/serveApp.mjs
                                                 for e2e use). New `e2e/convergence.spec.ts` —
                                                 Test Plan §2.7 E2E-CONV-01..04, manually
                                                 launching all three browser ENGINES together
                                                 in one test (not per-project), its own
                                                 `convergence` Playwright project. Phase 16
                                                 updated `src/sync/syncClient.ts`'s `handleOps`:
                                                 `seq` is now the STARTING seq of a frame's
                                                 range (a run/batch of N operations spans
                                                 `seq..seq+N-1`, server-side `currentSeq` no
                                                 longer being per-frame — see
                                                 documentCoordinator.ts's own comment), so both
                                                 `highestAppliedSeq` and `gapTracker.observe()`
                                                 now use the range's END
                                                 (`seq + ops.length - 1`), not `seq` itself.
                                                 `gapTracker.ts` needed no changes — its own
                                                 Phase 14 redesign already tolerates a jump of
                                                 more than 1. Phase 17 removed src/sync/
                                                 snapshotSeed.ts entirely — its logic moved to
                                                 `@collab-editor/protocol`'s own snapshotSeed.ts
                                                 (a second consumer, the server's warm start,
                                                 needed the identical algorithm); syncClient.ts
                                                 and sync/index.ts now import
                                                 `seedEngineFromSnapshot` from protocol directly,
                                                 with no behavior change.
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

- **Phase 10** — Client sync layer (API Spec §3.10 backoff, §7.9 unacked
  queue, §3.7.5 sequence gaps; PRD FR-OF-3). Built against the real spec
  text pasted in up front — no self-derive-then-correct pass needed, like
  Phases 8 and 9. New `packages/client/src/sync/` — see the package-table
  entry above for the file-by-file breakdown. No UI, no DOM binding, no
  React — exactly Scope-IN's boundary; `engine` is the one public surface
  a future editor-binding phase will read from.

  **A design question the phase brief didn't answer directly, resolved by
  necessity rather than by asking**: SNAPSHOT hands the client a
  structure-form node list (Phase 9's placeholder serialization), but
  `Engine` has no public "load state directly" constructor or mutator —
  the only way its internal `nodes`/`byKey`/tombstones are ever allowed to
  change is through `applyRemote()`'s normal ready()/integrate() pipeline.
  `snapshotSeed.ts`'s `seedEngineFromSnapshot` resolves this by replaying
  every snapshot node as the synthetic remote operation(s) that would have
  produced it — an Insert from the node's own fields, plus (for a
  tombstoned node) a Delete whose `id` is exactly the node's `deletedBy`
  (Engine Spec §4.5: `applyDelete` sets `node.deletedBy = op.id`, so
  `deletedBy` already IS the winning delete's own identity — replaying
  that one synthetic delete reproduces the tombstone with correct
  attribution without replaying every historical concurrent delete that
  raced for it). Nodes are fed in the snapshot's own structural order,
  which is NOT a correctness requirement — a node's `originLeft` is always
  structurally to its left (already replayed) but `originRight` is always
  structurally to its RIGHT (not yet replayed), so most inserts buffer on
  first attempt and resolve once their `originRight` is replayed later in
  the same pass, via the exact same `applyRemote()`/`drain()` fixpoint
  mechanism the convergence fuzzer already exercises 60,000 times over
  (Test Plan §2.2). This is the same "lean on the engine's own robustness
  rather than inventing a separate mutation path" reasoning behind several
  earlier phases' choices, applied to a new problem.

  **Connection-state naming, an application-level call, not a byte-layout
  one**: `connecting` is reserved for the very first `connect()` attempt,
  before this client has EVER reached `synced`; every later automatic
  retry (after any drop, for any reason including a sequence-gap-forced
  close) is `reconnecting`, whether it's mid-backoff-wait or mid-connect —
  from a caller's perspective there's nothing actionable to distinguish
  those two sub-steps. `offline` is reserved for an explicit
  `disconnect()` call — the one state with no automatic path back to
  `synced`. This mapping isn't dictated by the reference text (which only
  names the four states, not their triggers) but follows the same
  "reasonable, defensible, clearly documented" latitude Phase 8 used for
  its `documentId` interim binding and Phase 9 used for WELCOME's
  participant-list membership.

  **The "socket survives 60 seconds" timer starts at socket OPEN, not at
  SNAPSHOT/synced.** §3.10's own text says "a socket survives 60
  seconds," and its worked example ("a socket that dies immediately after
  WELCOME must not reset the backoff") is satisfied either way since that
  scenario is well under 60s regardless of which starting point is used —
  so the literal wording was followed rather than the alternative
  (arming it at full-handshake-completion instead), and this is flagged
  explicitly in `syncClient.ts`'s own comment as untested territory
  beyond that one example, since this project's real server always
  completes the handshake near-instantly.

  **OP_ACK/OP_REJECT handling was a real bug caught by the type checker,
  not just a design gap**: an early draft called a `handleOps(seq, ops)`
  helper uniformly for every OPS message, but `OpAckMessage`/
  `OpRejectMessage` (API Spec §3.5.7/§3.5.8) carry no `seq` field at all
  (Phase 7's corrected batch-message shape) — accessing `.seq` on that
  union would not even compile. Fixed by dispatching on `msg.kind` first:
  `opAck` acks the given ids out of the unacked queue, `opReject` gives up
  on the given ids (no retry/error-surface logic this phase), and only
  the remaining five bidirectional types reach the seq-tracking path. No
  live server sends either message yet (Phase 16), so this path is
  exercised by unit tests with synthetic frames, same as Phase 9's
  `ErrorMessage`/`GoodbyeMessage`.

  **DoD verification, mapped explicitly since not every scenario is best
  proven the same way**:
  - *"Two headless clients... converge over 1,000 operations"* — a real
    end-to-end test (`headlessHarness.test.ts`) against a real
    `createCollabServer()`, two real `SyncClient`s using the real global
    `WebSocket`, 1,000 alternating local inserts, engines compared by
    `.text()` equality. Passes in under a second on localhost.
  - *"Killing the server... both reconnect and converge on restart"* —
    also real end-to-end: the real server is closed, both clients'
    `state` is asserted to reach `"reconnecting"`, a NEW server is bound
    to the EXACT SAME port (this project has no persistence yet, so the
    restarted document is legitimately empty — the test asserts fresh
    post-reconnect convergence, not survival of pre-crash content), both
    clients are asserted to reach `"synced"` again, and a second
    convergence workload proves the reconnected session is fully live.
  - *"Backoff intervals are jittered — log 20 reconnects, confirm not
    identical"* — proven at the `Backoff` class level directly
    (`backoff.test.ts`), not via 20 real reconnects against a real
    server: this asserts the actual jitter mechanism (`random() *
    computed`, full jitter, not half) rather than a timing-dependent
    proxy for it, and runs in milliseconds instead of tens of seconds.
  - *"A socket that dies within 60s does not reset backoff — crash-loop 5
    times, interval grows"* and *"connection state transitions are
    observable and correct"* — proven with a real `SyncClient` driven by
    a fake, fully synchronous `WebSocketLike` plus `vi.useFakeTimers()`
    (`syncClient.test.ts`): real network I/O cannot be driven precisely
    enough in lockstep with fake timers to deterministically test a
    60-second boundary condition without either flaking or actually
    waiting a minute per test. `reconnectAttemptCount` (a real
    observability property, not test-only) is asserted to grow across 5
    quick crash cycles and to reset only after one connection survives
    the full 60s window — including the exact "dies immediately after
    WELCOME" case named in §3.10's own text.

  `pnpm test` passes 180 tests across 24 files (up from 147/19) —
  `packages/client/src/sync/*.test.ts` contributes 34: `backoff.test.ts`
  (5), `gapTracker.test.ts` (6), `unackedQueue.test.ts` (6),
  `syncClient.test.ts` (13, fake-socket/fake-timer-driven), and
  `headlessHarness.test.ts` (3, real server + real WebSocket, no mocks).

- **Phase 11** — Render model and position mapping (API Spec §7.1
  architecture, §7.2 position mapping, §11.10; Test Plan §7.1; PRD
  FR-CE-9). Built against the real Test Plan §7.1 text pasted in up
  front — no self-derive-then-correct pass needed, like Phases 8-10. New
  `packages/client/src/binding/` — see the package-table entry above for
  the file-by-file breakdown. This phase also stood up Playwright
  (`packages/client/e2e/`), the first use of real-browser testing
  anywhere in this project, per the phase brief's explicit instruction —
  jsdom cannot exercise real Selection/Range quirks, which is exactly
  what DOM-03 tests.

  **A real infinite-loop bug, caught immediately by actually running the
  test rather than reasoning about the code**: `DomWriter.deleteRange()`'s
  first version renumbered every run's `startVis` only ONCE, after its
  whole while-loop finished. For a deletion spanning two runs, this meant
  the second run's `startVis` stayed stale (its OLD, pre-deletion value)
  for the rest of the loop — so `findRunForVis(visOffset)` kept
  re-resolving the same fixed `visOffset` back to the FIRST run (now
  exhausted at that exact position, contributing 0 further scalars to
  delete) forever, never advancing to the second run at all. Manifested
  as `vitest` hanging with zero output and the worker process eventually
  dying (`Error: Worker exited unexpectedly`) — not a thrown exception,
  since nothing ever threw; the loop just never terminated. Fixed by
  renumbering after EVERY run touched, not once at the end — the O(runs)
  cost per touched run is irrelevant at this phase's scale, and
  correctness matters more than the saved passes. Caught by
  `domWriter.test.ts`'s own "deletes across a run boundary, spanning two
  runs" case, which is exactly why that case exists rather than only
  testing single-run deletes.

  **A second, more mundane bug fixed the same way**: the very first
  attempt to run ANY jsdom-environment test hung identically (`Worker
  exited unexpectedly`, no output) for an unrelated reason — `jsdom` was
  a devDependency of `packages/client` only, but this project runs one
  shared root-level `vitest run` via a single root `vitest.config.ts`,
  and Vitest resolves an `environment: "jsdom"` (or the
  `// @vitest-environment jsdom` file pragma) package relative to the
  process's own root, not the individual test file's package. Fixed by
  also adding `jsdom` to the ROOT `package.json`'s devDependencies —
  the first time any package in this workspace has needed a
  browser-DOM-emulation test environment at all.

  **Test strategy split three ways, each for a specific, named reason,
  not by default**:
  - `unicodeOffsets.test.ts`, `renderIndex.test.ts`,
    `domEngineConsistency.test.ts` — plain Node, no DOM at all needed
    (the last of these is DOM-01's "insert at v lands at exactly v"
    assertion, which the phase brief explicitly calls out as needing "a
    real Engine instance... not just testing the mapping functions in
    isolation" — it uses a real `Engine` from Phase 3, seeded with each
    fixture, and checks scalar-indexed consistency between
    `localInsert(v, ...)` and the DOM mapping functions' own notion of
    `v`, with zero DOM involved).
  - `domWriter.test.ts` — Vitest with `// @vitest-environment jsdom`:
    ordinary DOM tree manipulation (Text nodes, `childNodes`,
    `parentNode`) that jsdom implements reliably, used for
    mount/insert/delete mechanics and the dev-build assertion
    (including deliberately corrupting `renderIndex` and confirming it
    fires — this phase's own DoD item).
  - `e2e/*.spec.ts` — real Playwright, real Chromium AND real WebKit:
    reserved specifically for Selection/Range behavior a synthetic DOM
    can't be trusted to reproduce (DOM-01's round-trip-via-a-real-caret
    check, and all of DOM-03). `e2e/build-bundle.mjs` (esbuild) bundles
    `src/binding` into one dependency-free browser script exposed as
    `window.Binding` — this project has no dev server yet, so each spec
    injects it directly via `page.addScriptTag` rather than navigating
    to a running app.

  **`normalizeElementPosition`'s assumption, stated plainly rather than
  hidden**: it treats `node`'s children as exactly this editor's
  rendered runs in document order, true only because DomWriter never
  nests a run's Text node inside anything but the root and nothing else
  exists yet to violate that — an assumption a later phase (input
  handling, nested formatting, etc.) will need to revisit explicitly
  rather than silently inherit.

  **DoD verification**: `pnpm test` passes 230 tests across 28 files (up
  from 180/24) — `packages/client/src/binding/*.test.ts` contributes 50:
  `unicodeOffsets.test.ts` (10, including a 5,000-case round-trip
  property test and a dedicated "diverges from naive String.length past
  the astral character" regression case), `renderIndex.test.ts` (7),
  `domEngineConsistency.test.ts` (7, one per DOM-01 fixture, every
  interior position), and `domWriter.test.ts` (22, including all 4
  corruption-fires-the-assertion cases and one confirming
  `assertionsEnabled = false` genuinely suppresses it). Separately,
  `pnpm --filter @collab-editor/client run test:e2e` passes 22 tests across real
  Chromium AND real WebKit (44 browser-runs total): all 7 DOM-01
  fixtures' full round-trip-and-surrogate-pair-check, the real-Selection
  cross-check, and all 3 in-scope DOM-03 cases (empty editor via an
  actual `page.click`, after a `<br>`, and at a >512-scalar run
  boundary) — the empty-editor case runs on both engines specifically
  because Chromium and WebKit are known to disagree on what that DOM
  shape looks like, which is the entire reason API Spec §7.2.3 and this
  phase's DoD call it out by name.

- **Phase 12** — Input pipeline (API Spec §7.4 inputType dispatch table,
  §7.4.3 grapheme boundaries, §7.4.4 bind flag; Test Plan MUT-01, GRA-02;
  PRD FR-CE-13/FR-CE-14). Built against the real §7.4.2 inputType table and
  the real MUT-01/GRA-02 test-plan text pasted in up front — no self-derive-
  then-correct pass needed, like Phases 8-10. New `packages/client/src/
input/` (`graphemeSegmentation.ts`, `inputPipeline.ts`) and
  `packages/client/src/editor/` (`EditorView.tsx`, the project's first React
  component) — see the package-table entry above for the file-by-file
  breakdown. `react`/`react-dom` became real dependencies of
  `@collab-editor/client` for the first time this phase.

  **Every `beforeinput` is prevented unconditionally, before any dispatch
  logic runs** (Scope-IN's own wording, "without exception") — `DomWriter`
  (Phase 11) remains the sole mutator of the editor subtree; the browser's
  own native edit never happens, verified directly (20 distinct inputTypes,
  `event.defaultPrevented` checked for each, including two NOT in the
  dispatch table) in both `inputPipeline.test.ts` (jsdom) and
  `e2e/inputPipeline.spec.ts` (real Chromium/Firefox/WebKit).

  **A real, load-bearing bug was caught only by actually running the e2e
  suite in a real browser, not by unit tests alone**: the first version of
  `inputPipeline.ts` mutated `DomWriter`/`Engine` correctly on every
  `beforeinput` but never touched the browser's own `Selection` afterward.
  Because `preventDefault()` is called unconditionally, the browser never
  advances its caret the way it would after a native edit — every
  SUBSEQUENT keystroke kept reporting the exact same (stale) caret
  position. Typing "hello" via real `page.keyboard.type()` landed as
  "olleh": each character was re-inserted at position 0, since the caret
  never moved off the start. jsdom's own `inputPipeline.test.ts` suite
  (which manually places the Selection before EVERY dispatched event,
  never relying on the pipeline to have moved it from a prior call) could
  not have caught this — it only surfaced once a real browser was left to
  drive its OWN native key-repeat loop against the pipeline's actual
  after-effects. Fixed by `placeCaretAt()`, called at the end of every
  insert/delete: after an insert of `n` scalars at position `v`, the caret
  moves to `v + n`; after a delete, it moves to the deletion's start.

  **A second, more subtle bug was caught the same way, specific to one
  browser**: real Firefox, given a genuine family-ZWJ-emoji (7 scalars)
  followed by one real `Backspace` keystroke, removed only the trailing
  ZWJ+code-point pair (2 scalars) instead of the whole cluster — GRA-02's
  literal counterexample. The cause: `deleteContentCluster` originally
  preferred `event.getTargetRanges()` (Input Events Level 2) when
  available, falling back to `Intl.Segmenter`-based resolution only when
  it wasn't — and real Firefox DOES implement `getTargetRanges()`, but ITS
  own notion of "one grapheme cluster" for that event, in this headless/
  color-emoji-font-less test environment, disagreed with Unicode's actual
  grapheme-cluster-boundary rules. Scope-IN obligation 1 ("grapheme-cluster
  boundary resolution using Intl.Segmenter before every localInsert/
  localDelete") is not a suggestion Chromium happens to satisfy — it is
  the reason this project cannot trust a browser's own targetRange for
  cluster boundaries at all. Fixed by having `deleteContentCluster`
  (unlike every other dispatch-table handler) read ONLY the live
  `Selection` — never `getTargetRanges()` — for the collapsed-caret case,
  so `Intl.Segmenter` always has the final word on where a cluster begins
  and ends, regardless of what any given browser's own text-shaping stack
  would have reported. `deleteWordBackward`/`deleteWordForward`/
  `deleteSoftLineBackward`/`deleteHardLineBackward`/`deleteByDrag`/
  `deleteByCut` are NOT required by Scope-IN to bypass `getTargetRanges()`
  this same way (only the grapheme-cluster obligation is spec-explicit)
  and were left using `resolvedRange()` (targetRange, falling back to live
  selection).

  **Real-browser-only test-methodology decision, documented rather than
  silently made**: MUT-01's own text asks for "real browser interaction
  rather than synthetic events," but this project has no OS-level input
  automation and no dev server (nothing to navigate a real user flow
  against). Real key presses via Playwright's `page.keyboard` genuinely
  produce browser-generated `beforeinput` events for typing and
  Backspace/Ctrl+Backspace — used wherever possible. For
  autocorrect/spellcheck-replacement/paste/drag/cut, no headless-
  automatable OS/clipboard trigger exists, so each is exercised by
  directly dispatching a real `InputEvent` via `element.dispatchEvent`
  carrying the `inputType` a genuine trigger would have produced — a real
  event object handled by real browser event-dispatch machinery and this
  project's real listener, only its ORIGIN is synthetic. This is this
  phase's own documented, defensible call (same latitude as Phase 8's
  `documentId` interim binding or Phase 9's WELCOME participant-list
  scoping), not a byte-layout invention.

  **A genuine, documented WebKit-only limitation, not a pipeline defect**:
  real WebKit runs a `DataTransfer` constructed via `new DataTransfer()`
  (never produced by an actual native paste/drop) in "protected mode" —
  `getData()` returns `""` for a synthetically-dispatched `beforeinput`,
  even though `setData()` on the same object succeeds. Chromium and
  Firefox are both lenient enough to allow this for testing; WebKit is
  not. `e2e/inputPipeline.spec.ts`'s two `dataTransfer`-dependent tests
  (paste, drag/drop) are `test.skip()`-ed specifically on
  `browserName === "webkit"`, with the reasoning inline — a REAL user
  paste/drop in real WebKit populates `dataTransfer` correctly; only a
  synthetic dispatch cannot reach it there. The "2,000 chars → ONE wire
  frame" half of this DoD item is verified independently and browser-
  independently in `syncClient.test.ts` (a fake socket, counting actual
  sent frames), not in the browser suite at all.

  **OP_INSERT_RUN coalescing (`operationsToRunMessages`, `wireHelpers.ts`)
  groups by BIND, not by input source**: pasting text containing an
  embedded combining mark correctly splits into multiple messages at the
  bind-flag boundary (verified in `wireHelpers.test.ts`, `"e" + U+0301 +
"f"` → three separate `OP_INSERT` messages, none long enough to qualify
  as a run) — exactly mirroring Phase 7's own `expandInsertRun`
  requirement that `bind` apply uniformly to a WHOLE run, never per
  character.

  **`insertText`/`insertReplacementText`/`insertFromPaste`/
  `insertFromDrop`/`insertLineBreak`/`insertParagraph` all reduce to one
  shared code path** (`replaceRangeThenInsert`): resolve the range that
  would be replaced (empty for a plain caret), delete it if non-empty,
  insert the type's own text (from `event.data`, `event.dataTransfer`, or
  the literal `"\n"`) at the range's start. This is not an
  approximation — API Spec §7.4.2's own table describes autocorrect,
  paste, and drop identically ("delete range, then insert"), and this
  phase's own `insertReplacementText` test (`"teh" → "the"`) and paste
  tests exercise the exact same function.

  **`insertCompositionText`/`deleteCompositionText` never emit an
  operation, exactly per the table** — IME composition is entirely a
  Phase 13 (sentinel) concern; this phase only guarantees the browser's
  own composition UI never mutates the DOM itself (still prevented
  unconditionally), which will look broken mid-composition until Phase 13
  lands, as documented.

  **`historyUndo`/`historyRedo` are stubbed exactly as the table
  specifies**: `preventDefault()` only (already unconditional), a
  `TODO(Phase 36)` comment, no engine call — `Engine.undo()`/`redo()`
  don't exist yet (Phase 36, Engine Spec §9).

  **DoD verification**: `pnpm test` passes 278 tests across 32 files (up
  from 230/28) — `packages/client/src/input/*.test.ts` contributes 38
  (`graphemeSegmentation.test.ts`: 15, including the GRA-02 family-emoji
  fixture; `inputPipeline.test.ts`: 23, jsdom, covering every dispatch-
  table row reachable without real OS/clipboard triggers, plus the
  20-inputType `defaultPrevented` sweep), `packages/client/src/editor/
EditorView.test.tsx` contributes 4 (no React Testing Library dependency —
  `react-dom/client` + `act` directly, consistent with this project's
  "no external dependency unless necessary" convention), and
  `packages/client/src/sync/wireHelpers.test.ts` (new this phase) plus a
  new `syncClient.test.ts` case contribute 6 covering the run-coalescing
  helper and the literal one-frame-on-a-fake-socket assertion. Separately,
  `pnpm --filter @collab-editor/client run test:e2e` now passes 25 of 27
  browser-test-cases across real Chromium, Firefox, AND WebKit (playwright.
  config.ts gained a `firefox` project this phase, Scope-IN: "Runs in
  Chromium, Firefox and WebKit") — 2 skipped, both on WebKit only, for the
  documented `DataTransfer` protected-mode limitation above; every
  Phase-11 DOM-01/DOM-03 case also re-verified green under the new
  `firefox` project (33 tests × 3 browsers). A single Firefox "page setup"
  timeout was observed once under 4-worker parallel load and confirmed to
  be sandbox resource contention, not a real failure, by re-running that
  exact test in isolation (`--workers=1`), where it passed in 4.8s.

- **Phase 13** — MutationSentinel and DOM reconciliation (API Spec §7.7 the
  sentinel, §11.11 why `takeRecords()` must be synchronous; PRD FR-CE-14;
  RFC R5). Built against the real spec text and the exact required comment
  text pasted in up front — no self-derive-then-correct pass needed, like
  Phases 8-10 and 12. New `packages/client/src/sentinel/`
  (`mutationSentinel.ts`) — see the package-table entry above for the
  mechanism. `inputPipeline.ts`'s `InputPipelineDeps` gained a REQUIRED
  `sentinel` field; `insertTextAt`/`deleteRangeAt` now wrap their
  `DomWriter` calls in `sentinel.applyPatches()`. `EditorView.tsx` now
  constructs a `MutationSentinel`, calls `.start()` once per mount, and
  wraps both the initial mount and every SNAPSHOT re-mount in
  `applyPatches()`.

  **The required comment is verbatim in `mutationSentinel.ts`, directly
  above `applyPatches()`**:
  ```
  // takeRecords() must be called SYNCHRONOUSLY here, not guarded by a boolean flag.
  // MutationObserver callbacks are microtasks that run AFTER the synchronous write
  // block finishes and clears any flag, so a flag-based guard makes our own writes
  // look foreign and triggers a full re-render per keystroke — destroying PRD M3.
  // API Spec §7.7.1, §11.11.
  ```

  **The boolean-flag experiment was actually performed, not just described,
  and failed WORSE than the DoD's own framing implies.** The DoD says a
  flag-based implementation makes MUT-03 fail (extra reconciliations per
  keystroke). Actually swapping `applyPatches()`'s `try/finally { this.
observer.takeRecords() }` for `this.BROKEN_applying = true; try { fn(); }
finally { this.BROKEN_applying = false; }` (checked in the observer
  callback instead of `records.length`) produced something more severe: an
  INFINITE reconciliation loop starting from the very FIRST legitimate
  write. The reason is exactly what the required comment warns about, one
  level further: `reconcile()`'s OWN re-render is itself wrapped in
  `applyPatches()` — under the broken flag, that re-render's mutation
  records are never drained, so the observer's callback fires for THEM
  too, sees the (already-false) flag, calls `reconcile()` again, which
  re-renders again, which queues more undrained records, forever. Both
  `e2e/mutationSentinel.spec.ts` tests hung and hit Playwright's 30-second
  `page.evaluate` timeout under the broken version (confirmed on real
  Chromium) — not a clean assertion failure, but unambiguous, real
  evidence the flag-based approach is broken, and considerably more
  destructive than "one extra reconciliation per keystroke." Reverted
  immediately after confirming; `pnpm test` and the full 3-browser e2e
  suite were re-run afterward to confirm the reverted file is
  byte-for-byte the correct implementation again (all tests green).

  **`SentinelMetrics` (`reconciliation`/`desync_error`) are per-instance,
  not a page-global singleton** — a documented, defensible reading of
  Scope-IN's "binding.reconciliation"/"binding.desync_error" wording
  (naming the CONCEPT, not literally mandating a shared mutable module-
  level object): a global counter would leak state across tests, and
  across multiple editors on one page once that's ever a real scenario,
  the same class of problem this project's other metrics-shaped state
  (e.g. `ClockEvent` logs, Phase 4) has always avoided by attaching to a
  specific instance instead. `desync_error`'s semantics are ALSO a
  documented call, not spec-literal: it increments only if a
  reconciliation's OWN re-render — built directly from `engine.text()` —
  still fails to match that text afterward, a strictly worse, should-be-
  unreachable bug distinct from an ordinary "we detected and fixed a
  foreign mutation" event. Verified live (not decorative) via a fault-
  injection test: a `BrokenDomWriter` subclass whose `mount()` deliberately
  appends an extra character, proving `desync_error` actually increments
  when reconciliation's own output disagrees with the engine, and stays 0
  on every normal MUT-02/MUT-03 pass.

  **A real caret-restoration nuance, discovered by actually running the
  test, not assumed**: MUT-02's own harness test originally mutated the
  exact Text node the caret was anchored inside via `textNode.data =
"corrupted"`. This failed — not because reconciliation was wrong, but
  because the DOM's OWN "replace data" boundary-point-adjustment algorithm
  (which jsdom correctly implements) collapses any live Selection/Range
  anchored inside a Text node to offset 0 the INSTANT its `.data` is fully
  replaced — before this sentinel's necessarily-async MutationObserver
  callback ever gets a chance to capture the "original" caret position.
  This is not a bug in `captureCaret()`/`reconcile()`; it is an inherent
  limit of ANY reactive, MutationObserver-based detector, confirmed by
  reasoning about the DOM's own mutation-boundary-adjustment spec text,
  not guessed at. `mutationSentinel.test.ts`'s primary MUT-02 test was
  changed to use a ROGUE SIBLING NODE (an `appendChild` that never touches
  the caret's own anchor node) — a more representative "foreign mutation"
  shape anyway (a browser extension or stray script injecting new content,
  not necessarily overwriting the exact node the user's caret sits in) —
  and a SECOND test keeps the harsher "same-node replacement" scenario,
  documenting explicitly that the restored position there is wherever the
  DOM's own adjustment already left the selection (offset 0), not the
  literal pre-mutation index, precisely so this limitation is recorded
  rather than silently worked around.

  **DoD verification**: `pnpm test` passes 283 tests across 33 files (up
  from 278/32) — `packages/client/src/sentinel/mutationSentinel.test.ts`
  contributes 5: MUT-02 (rogue-sibling revert, exact reconciliation count,
  no operation emitted, caret restored), the same-node-replacement caret
  edge case, a legitimate-write-produces-no-reconciliation sanity check, a
  50-write/macrotask-boundary burst sanity check (basic MUT-03 shape,
  jsdom), and the `desync_error` fault-injection test. `packages/client/
src/input/inputPipeline.test.ts`'s existing 23 tests all still pass
  unchanged in behavior with a REAL, started `MutationSentinel` now wired
  through every harness — proving the sentinel never mistakes ordinary
  pipeline writes for foreign ones. Separately,
  `pnpm --filter @collab-editor/client run test:e2e` passes 64 of 66
  browser-test-runs (the same 2 pre-existing WebKit-only `DataTransfer`
  skips from Phase 12; nothing new skipped) across real Chromium, Firefox,
  AND WebKit, including the two new `e2e/mutationSentinel.spec.ts` cases:
  MUT-02 (a real `appendChild` on the live page, reverted, counted,
  verified via `engine.stats().totalElements` being unchanged — proof no
  operation was emitted) and MUT-03 (1,000 `insertText` `beforeinput`
  dispatches, each from inside its own `setTimeout(..., 0)` to force a
  genuine macrotask boundary between writes — the same task/microtask
  shape a real separate keystroke produces, which is what actually
  distinguishes the correct implementation from the broken flag-based one;
  a tight synchronous loop would not have caught it, see the file's own
  comment) — `binding.reconciliation === 0` confirmed on all three real
  browser engines, per MUT-03's own wording.

- **Phase 14 — MILESTONE M1: two clients, plain text, live convergent
  sync** (Milestone Plan M1 · PRD G-P1/G-P3/G-P4/G-P6 · Test Plan §2.7
  E2E-CONV-01..04). The goal: wire engine + protocol + server + binding
  into one working application and prove the product's central
  convergence promise end to end, in real browsers, for the first time.
  This phase found and fixed more genuine, previously-undiscovered bugs
  than any prior phase — not because the code was unusually bad, but
  because this was the FIRST TIME in the project's history anything ran a
  real multi-client exchange for longer than a few seconds, or through
  anything resembling real network latency. Every one of the findings
  below was found by actually running the thing, never by review.

  **New, demoable application** (`packages/client/src/app/`): `App.tsx`
  composes a `SyncClient` (Phase 10) and an `EditorView` (Phases 11-13)
  behind a `ConnectionIndicator`; `urlParams.ts` implements "open a
  document by URL" (`?doc=<uuid>`, minted and written back via
  `history.replaceState` if absent; `?server=` overrides the WS URL,
  used by the e2e suite). `scripts/serveApp.mjs` is an esbuild `serve()`
  dev server — no Vite, no new bundler dependency, reusing the same
  esbuild already used for e2e bundles — serving `app/index.html` and
  compiling `src/app/main.tsx` on demand; used both for the manual M1 demo
  (`pnpm --filter @collab-editor/client run dev`, fixed port 5173) and,
  at an ephemeral port, by the E2E-CONV suite. `App.tsx` also exposes
  `window.__collabDebug` (`getEngineText`/`getPendingCount`) — a
  deliberate, always-on test/observability hook, the same "no security
  posture yet, nothing exposed publicly" reasoning this project has
  applied since Phase 8, needed because E2E-CONV-01's assertions 2 and 4
  require reading engine state independent of the DOM.

  **Finding 1 — remote edits never appeared in the DOM at all.** Caught
  immediately by the first real two-window manual smoke test (before any
  formal E2E-CONV test even existed): typing in one browser window
  correctly converged at the ENGINE level (`sync.engine.text()` on the
  other window was correct) but the DOM never updated — nothing had ever
  wired "a remote operation arrived" to "re-render." This is NOT a subtle
  bug; it means Milestone M1's central promise would have been
  unverifiable in a real browser. Fixed by adding `SyncClient.
onRemoteOpsApplied(listener)` (fired at the end of `handleOps`, only for
  batches containing at least one operation) and wiring `EditorView` to
  it: on every remote batch, capture this session's own caret's VISIBLE
  INDEX, re-mount the whole subtree from `engine.text()` (through
  `sentinel.applyPatches()`, same as every other write), then restore
  that SAME numeric index. This is explicitly NOT cursor transformation
  (Phase 32's job — adjusting the index to stay in the same RELATIVE
  spot when a remote edit lands before it) — it is the minimum viable
  fix that makes concurrent editing demonstrable at all.

  **Finding 2 — a real, significant, previously-undiscovered bug in
  Phase 10's `SequenceGapTracker`, found only because a real session ran
  long enough to hit it.** The server never echoes a client's own
  operation back to it (Phase 8's own design, `otherSessions
(fromSessionId)`) — meaning EVERY client's own operations are permanent,
  structural "holes" in the seq sequence it observes, not evidence of a
  dropped frame. The original `observe()` treated any `seq > lastServerSeq
+ 1` as opening a gap that only closes on an EXACT `lastServerSeq + 1`
  delivery — for a hole that will structurally NEVER be filled (the
  client's own excluded op), that condition can never be satisfied, so
  `lastServerSeq` freezes forever the first time it happens (almost
  immediately in any 2+-party session). `onGapPersisted()` then
  unconditionally closed the socket exactly 5 seconds later with NO
  re-check that the gap was still meaningfully open. Net effect: in ANY
  session with two or more concurrent editors, EVERY client force-
  reconnected roughly 5 seconds after the first exchange of operations —
  not a rare fault-recovery path but a guaranteed, silent disruption of
  ordinary multi-user editing, invisible until now because Phase 10's own
  test (1,000 alternating inserts) completes in under a second, well
  before the 5-second timer could ever fire. Confirmed directly: logging
  connect/disconnect events during a real 3-browser session showed all
  three reconnecting in lockstep at ~t=5-6s, with or without Phase 14's
  own delay relay in the path — proving this was never a relay artifact.
  **Fixed** by redesigning `SequenceGapTracker` (packages/client/src/sync/
gapTracker.ts) around "is there any forward-moving seq activity at all"
  instead of "did one specific number ever arrive": `observe()` now
  advances `value` to ANY newly-seen `seq` greater than the current one,
  regardless of contiguity, and records that as progress; `hasGap` is
  kept as an informational-only signal; a NEW `hasStalled()` — true only
  once `GAP_RECONNECT_TIMEOUT_MS` has passed with NO forward progress AT
  ALL — is the actual reconnect signal, checked on the existing PING
  cadence (`startPingTimer`) rather than a separate one-shot timer,
  removing `gapReconnectTimer`/`onGapPersisted`/`clearGapReconnectTimer`
  entirely. A genuine network stall (the server truly stops sending
  anything) still reconnects correctly; a client's own routinely-excluded
  operations no longer do. Phase 10's own `gapTracker.test.ts` and the
  sequence-gap section of `syncClient.test.ts` were rewritten to assert
  the corrected behavior (including a test that runs 20 rounds of
  "every other seq is mine" and asserts no reconnect is ever triggered).
  **This finding was surfaced to the user and its fix explicitly
  approved before implementation**, given its scope (redesigning
  previously-completed, tested Phase 10 protocol behavior) — see the
  in-conversation record for the exact options presented.

  **Finding 3 — a related, separate client-side data-loss path: a local
  edit could be silently orphaned during the (now much rarer, but still
  possible, e.g. Phase 14's own genuine server-kill scenario) reconnect
  window.** `SyncClient.engine` is deliberately preserved (never nulled)
  across a disconnect — "last known state," Phase 10's own documented
  choice — but `requireEngine()` only ever checked `engine !== null`,
  never `state.value === "synced"`. A local edit minted during the
  `"reconnecting"` window (between the old connection dropping and a
  fresh SNAPSHOT replacing `engine` wholesale) would apply to the OLD,
  soon-to-be-discarded engine object, attempt to send over an
  already-dead socket, and then be silently discarded the instant the new
  snapshot replaced `engine` — never reaching the server, never reflected
  anywhere. **Fixed** two ways: `requireEngine()` now also requires
  `state.value === "synced"` (throwing the SAME "not synced yet" error
  `localInsert`'s own doc comment already promised, closing the gap
  between that promise and what the code actually checked) as a
  backstop; `inputPipeline.ts`'s `handleBeforeInput` guard was extended
  from `!deps.sync.engine` to also check `deps.sync.state.value !==
"synced"`, so a real user typing during a reconnect simply has that
  keystroke ignored (matching "not synced yet" behavior) rather than
  throwing an uncaught exception through a DOM event handler.

  **A new, sanctioned test-seeding method, `SyncClient.
seedForTesting(engine)`** (sets `engine` AND flips `state` to `"synced"`
  together) replaces the bare `sync.engine = new Engine(...)` pattern
  every prior phase's test harness used — that pattern stopped being
  sufficient the moment `requireEngine()` started checking `state` too.
  Updated in `mutationSentinel.test.ts`, `inputPipeline.test.ts`,
  `EditorView.test.tsx`, and both e2e specs that construct a `SyncClient`
  directly in-browser (`inputPipeline.spec.ts`, `mutationSentinel.spec.
ts`) — all pre-existing tests from Phases 12-13, none of which needed
  behavioral changes beyond this one substitution.

  **The toxiproxy substitute (`e2e/support/delayRelay.ts`) — "toxiproxy
  substituted with an in-process delay relay for E2E testing purposes,"
  per this phase's own infrastructure guidance.** A lightweight in-
  process WebSocket relay (not a separate binary/container) that buffers
  each frame and forwards it after `delayMs` (~75ms each direction, ~150ms
  round trip) in both directions. It ONLY delays — it never duplicates,
  reorders, or drops frames on purpose; RFC §8.8-grade fault injection
  (duplicate/reorder/drop) remains Test Plan §3.5/DUR-05's job, in a much
  later phase. FOUR real bugs were found and fixed in it while actually
  running E2E-CONV-01 under real 3-browser load (each documented in full,
  with the exact mechanism, in the file's own header comment):
  1. Held a direct reference to `ws`'s own message buffer across the
     delay window instead of copying it immediately — corrupted forwarded
     bytes often enough under load to trip the SERVER's own engine-level
     canary (Engine Spec §6.2 sub-case iii-d, Phase 6's "must never fire
     on any correct input" assertion) — direct proof some delivered
     operation was structurally impossible for any correct client to have
     produced. Fixed by copying into a fresh `Buffer` the instant a frame
     is received.
  2. Independent per-message `setTimeout` timers do not structurally
     guarantee delivery in arrival order under real load. Fixed with one
     explicit, strictly-ordered FIFO queue per direction per connection.
  3. The queue's drain loop checked `upstream.readyState === OPEN` and, if
     not open yet (the upstream connection to the real server has its own
     handshake latency), SILENTLY DISCARDED that frame — a genuine
     data-loss bug reproduced as both engine-level divergence and a
     `pendingCount()` that never drained (Invariant I9's exact failure
     shape). Fixed: never discard for not being ready — retry the SAME
     head-of-queue item every 5ms until the socket opens.
  4. Even after all three fixes, a genuine connection teardown (a real
     reconnect, or — discovered while testing E2E-CONV-03 specifically —
     the abrupt loss of the upstream connection when the real server
     process is killed) tore down a connection's queues immediately,
     abandoning whatever was still sitting inside the `delayMs` window at
     that exact moment. Fixed with `flush()` — sends everything still
     queued immediately, best-effort, BEFORE `stop()` on every close/error
     path. A related, smaller bug surfaced by E2E-CONV-03 specifically: an
     abrupt upstream close can report a code `ws.close()` refuses to
     re-send (only 1000 or 3000-4999 are legal to set manually) — fixed by
     falling back to a codeless `close()` in that case.

  **A limitation in the relay substitute, initially disclosed as
  unresolved, then fully root-caused in an extended DoD-verification
  investigation the same day (2026-08-31) — see `tests/regression/README.md`'s
  "FINAL RESOLUTION" section and entries R0001-R0007 for the complete,
  evidence-by-evidence account. Summary of what actually happened, since
  an earlier draft of this entry stated an unverified claim as fact (see
  the correction note at the end of this bullet):**

  After the four delayRelay.ts bugs above were fixed, E2E-CONV-01-shaped
  runs at the full 60-second/3-browser duration still failed intermittently
  (roughly 1 in 5-6 runs) — sometimes the engine's own Case C canary
  (Engine Spec §6.2 sub-case iii-d) firing on the server, never before
  observed outside a deliberately mutated engine; once, a genuine silent
  cross-client text divergence with no assertion catching it at all. This
  was investigated exhaustively rather than accepted as a rounding error:
  reproduced independently via Playwright's own native
  `routeWebSocket()`/`connectToServer()` API (zero shared code with
  delayRelay.ts) to rule out a bug specific to the hand-rolled relay;
  node-level diagnostic hooks (`__collabDebug.getEngineNodes()`, a server
  `/v1/documents/:id/replay-nodes` endpoint) were added to compare full
  CRDT structure, not just text, across all three clients and the server's
  independent operation-log replay; a browser-to-slot permutation test
  initially (and, per the sequence of evidence, prematurely) implicated
  Firefox specifically, until a later run showed WebKit failing with the
  identical signature, correcting that conclusion. The actual mechanism
  was found via send-vs-receive frame counting: a
  `WebSocket.prototype.send` monkey-patch (injected via Playwright,
  touching no production code) counting every send call client-side,
  against a new server-side `documentCoordinator.ts` field
  (`receivedFrameCount`, incremented in `gateway.ts` per connection) —
  this showed the diverging client's own send-call count and
  `bufferedAmount` behaving completely normally (client never stops
  sending, browser never backlogs) while the server's received-frame
  count for that one connection froze at one exact value and never
  advanced again for the rest of the run, on neither end ever reporting
  an error or closing. **The decisive test**: the identical instrumented
  60-second/3-browser scenario run 8 times with NO delay-injection layer
  at all (direct connection, no relay, no routeWebSocket) — 8/8 clean,
  and an automated scan of every 3-second sample across all 8 runs found
  zero freeze occurrences, versus reproducing within 1-3 attempts under
  either injection mechanism. **Conclusion: this was always a defect in
  the test harness's delay-injection layer (present independently in
  both delayRelay.ts AND Playwright's own native routeWebSocket
  implementation), never in the shipped product** — `SyncClient`,
  `gateway.ts`, and `Engine` showed no abnormal behavior on any
  observable signal in any failing run, and the failure never once
  reproduced without an added relay/interception hop in the path. The
  exact mechanism inside the injection layer (Node's `ws` library or
  Playwright's WebSocketRoute internals, under sustained small-message
  real-time load through an extra hop) was not further isolated — that
  remains open test-infrastructure follow-up work, not a product concern.

  **Correction note**: an earlier draft of this document, written before
  this investigation, stated "the DIRECT (no-relay) path... has been
  independently verified fully reliable across many runs" as an
  established fact — at the time that sentence was written, the direct
  path had only been checked at short durations (~8s), never at the full
  60s duration the relay path was being evaluated against, and the
  claim was corrected on direct challenge before being allowed to stand.
  It is NOW genuinely true, backed by 13/13 clean full-60-second direct
  runs (5 from the initial confirmation + 8 from the decisive
  zero-injection control), the latter batch verified at the wire-frame
  send/receive level, not just the text level. The lesson (already
  written elsewhere in this document re: Phases 5/7, and repeated here
  because it recurred): a claim that sounds obviously true is not
  evidence until it has actually been checked at the same scale as the
  claim it's being compared against.

  **DoD status, now fully resolved rather than partially rounded up**:
  `pnpm test:convergence` re-ran to completion during this investigation
  and PASSED — 60,000/60,000 seeds, zero divergences, zero stuck-pending,
  across all 6 required configs (exact per-config numbers in this
  document's "How to run the test suite" section). The product's
  convergence guarantee is proven at both the unit-fuzz level and the
  real-multi-browser level. The E2E-CONV-01..04 automated suite itself
  (`packages/client/e2e/convergence.spec.ts`) still depends on
  `delayRelay.ts` for its ~150ms RTT injection, so it can still flake for
  the now-documented, non-product reason described above — a failure
  there should be checked against `tests/regression/R0001-R0007` before
  being treated as a convergence regression. Replacing or hardening the
  delay-injection layer itself is legitimate follow-up work, but is a
  test-infrastructure task, not a blocker to Milestone M1's actual
  deliverable.

- **Phase 15** — Database schema and migrations (API/Protocol/Data Design
  Spec v1.0 §2.2–§2.8; PRD FR-PS-1, FR-PM-1). The user supplied the real
  §2.2–§2.8 DDL verbatim, with the explicit instruction "do not modify
  column names, types, or constraints" — so, unlike Phases 5 and 7, there
  was no self-derive-then-correct pass here; the DDL below is that text,
  unmodified, split across seven migration files and run for real against
  a real Postgres instance (not merely typechecked).

  **Tooling choice: node-pg-migrate, not Prisma Migrate** — recorded here
  per this phase's own instruction to record the choice. Prisma Migrate
  generates SQL from a declarative `schema.prisma` file; expressing
  `CREATE RULE ... DO INSTEAD NOTHING` (operations' append-only guarantee)
  and a partial unique index gated on `WHERE role = 'owner'`
  (`docperm_single_owner_idx`) through Prisma's schema language would mean
  translating the spec's own literal DDL into a different representation
  and hoping the generated SQL matches — exactly the kind of translation
  step this phase's "use this DDL as-is" instruction was written to avoid.
  node-pg-migrate's `pgm.sql(...)` runs the spec's DDL nearly character
  for character, including its own inline SQL comments, which is the
  most direct way to satisfy "do not modify" literally.

  **Seven migration files, not one, and not eight** — one per API Spec
  §2 subsection (`§2.2` → `§2.3` → `§2.4` → `§2.5` → `§2.6` → `§2.7`),
  except `§2.8` (`version_marks` + `audit_runs`), which is kept as ONE
  migration because the spec itself presents them as one section:
  `packages/server/migrations/`:
  `1788134400000_create-users.js`,
  `1788134460000_create-documents.js`,
  `1788134520000_create-document-permissions.js`,
  `1788134580000_create-sessions.js`,
  `1788134640000_create-operations.js`,
  `1788134700000_create-snapshots.js`,
  `1788134760000_create-version-marks-and-audit-runs.js`. Each file's
  `up` is the spec's DDL verbatim (as one `pgm.sql()` call); each file's
  `down` drops what it created, in FK-safe order (a table before the enum
  type it depends on) — node-pg-migrate runs `down` migrations in the
  REVERSE of `up` order automatically (file 7 down first, ..., file 1
  last), which is what makes `users` (created first, referenced by
  everything) get dropped last, without this phase needing to reason
  about global drop order by hand. Files are plain ESM (`export const
up/down`, not `module.exports`), because `packages/server/package.json`
  declares `"type": "module"` and node-pg-migrate loads migration files
  as ES modules under that setting — this is the tool's own native
  convention, not a departure from it.

  **A real, if minor, mistake caught only by actually running the
  migrations, not by writing them carefully**: the first version of these
  files was named `0001_...` through `0007_...` — plain sequential
  integers, not real timestamps. `node-pg-migrate up` ran them
  successfully (they still sort correctly), but printed "Can't determine
  timestamp for 000N" for every file — a warning, not a failure, but an
  unexplained one in what should be routine `pnpm db:migrate` output.
  Fixed by renaming to real epoch-millisecond prefixes
  (`1788134400000_...`, 2026-08-31T00:00:00Z plus 60-second increments)
  — node-pg-migrate's own documented convention — which is why the
  filenames above look like real timestamps rather than `0001`/`0002`.
  Caught the same way this project has caught most of its real bugs since
  Phase 8: by actually running the command, not by reasoning about
  whether the tool would accept plain integers.

  **The append-only guarantee (`operations_no_update`/
  `operations_no_delete`) was verified as a live behavior, not assumed
  from reading the DDL**: `packages/server/src/db/schema.db.test.ts`
  inserts a row, issues a real `UPDATE ... SET payload = ...`, and
  asserts the stored `payload` is byte-for-byte unchanged (not that the
  query errored — `DO INSTEAD NOTHING` makes it a genuine no-op, not a
  rejection); a separate test issues a real `DELETE` and asserts the row
  is still there. Both pass against a real, migrated Postgres instance
  via Docker Compose.

  **The single-owner and duplicate-stamp constraints were verified as
  live rejections**: inserting a second `document_permissions` row with
  `role = 'owner'` for the same `document_id` (a different `user_id`)
  throws `duplicate key value violates unique constraint
"docperm_single_owner_idx"`; inserting a second `operations` row with the
  same `(document_id, stamp_r, stamp_c)` at a DIFFERENT `seq` throws the
  same class of error against `operations_stamp_uq` — proving this is
  duplicate-OPERATION suppression (API Spec §9.1's layer 3), not merely a
  `seq` collision the primary key would have caught anyway.

  **The EXPLAIN test needed a real, and non-obvious, correction after its
  first run genuinely failed** — the kind of finding this project's own
  "green isn't evidence until checked at the right scale" lesson
  (Phases 5/7/14) predicts, one level down at the level of a single SQL
  query plan rather than a whole test suite. The first version populated
  only 2 documents × 500 rows (1,000 total) and asked Postgres to plan
  `WHERE document_id = $1 AND seq > $2 ORDER BY seq` for one of them.
  Postgres chose `Sort + Seq Scan`, correctly — the target document was
  50% of the whole table, and a sequential scan genuinely IS cheaper than
  an index lookup at that selectivity. This would have been a plausible
  but wrong test: it looked like it was testing "does the index get
  used," but was actually testing "does Postgres's planner make a
  reasonable choice on a not-representative table," which happened to
  answer "no" for the DoD's expected reason. Fixed by populating a table
  the reconnection query's REAL selectivity profile resembles: 60
  documents × 2,000 rows each (120,000 total, one target document being
  under 2% of the table), inserted via a single `unnest(...) CROSS JOIN
generate_series(...)` statement rather than 120,000 individually
  parameterized rows (both for speed and to stay under Postgres's
  per-statement parameter limit), followed by an explicit `ANALYZE` so
  the planner has real statistics rather than none. Against that table,
  `EXPLAIN` shows `Index Scan using operations_pkey` with no `Seq Scan`
  anywhere in the plan — the actual DoD claim, now verified against data
  shaped like what the reconnection query will really see in production
  (many documents, one of them queried at a time), not an arbitrary small
  fixture. The bulk insert itself is slow enough (~15-18s baseline) that
  this phase raised `vitest.db.config.ts`'s `testTimeout`/`hookTimeout`
  from the 5s/10s defaults — first to 30s (caught by the suite's own
  first run timing out, not anticipated in advance), then to 60s after a
  SECOND real observation: a run that happened to overlap another `pnpm
test` invocation took 40s and blew through the 30s budget. 60s was
  chosen to leave genuine headroom rather than trade one flaky threshold
  for a merely-less-flaky one.

  **`pgmigrations` (node-pg-migrate's own bookkeeping table, tracking
  which migrations have run) is excluded from the "exactly eight tables"
  assertion** in `schema.db.test.ts`, with a comment explaining why: it's
  an implementation detail of the chosen migration tool, not one of API
  Spec §2's eight tables. Caught the same way as the items above — the
  test's first run failed with a real, present ninth table, not
  predicted before running it.

  **`packages/server/src/db/`** (new): `pool.ts` (`createPool()`, a thin
  `pg.Pool` wrapper) and `schema.db.test.ts` (the DoD suite, described
  above). **Explicitly NOT wired into `documentCoordinator.ts`/
  `gateway.ts` this phase** — the write path (persisting real operations/
  snapshots as the coordinator processes them) is Phases 16-17; Phase
  15's own scope is schema + migrations + seed only, and the coordinator
  remains in-memory-only exactly as before. `config.ts`'s `ServerConfig`
  gained a required `databaseUrl` field (read from `DATABASE_URL`,
  previously listed in `.env.example` but never read by any code) — used
  today only by `pool.ts`'s callers (the seed script, the DoD tests), not
  by `index.ts`'s server startup path.

  **`packages/server/scripts/seed.ts`** (new): inserts one fixed-UUID dev
  user, one fixed-UUID document owned by that user, and that document's
  (necessarily singular, per `docperm_single_owner_idx`) owner permission
  row — all via `ON CONFLICT ... DO NOTHING`, so `pnpm db:seed` is safe
  to run repeatedly against the same database (verified: ran twice in a
  row, second run left the row counts unchanged). `password_hash` is
  seeded with a literal, obviously-not-a-real-hash placeholder string —
  password hashing doesn't exist until auth (Phases 26-29), and the
  column is `NOT NULL`, so seeding needs *some* value; the placeholder is
  deliberately unusable as a real hash so it can never be mistaken for
  one later.

  **`docker-compose.yml`** (new, repo root): a single `postgres:16-alpine`
  service, credentials/db name matching `.env.example`'s `DATABASE_URL`
  exactly (`postgres:postgres@localhost:5432/collab_editor`), a named
  volume for data persistence across container restarts, and a
  healthcheck (`pg_isready`) so `docker compose up -d` followed
  immediately by `pnpm db:migrate` doesn't race a not-yet-ready database
  — local dev only, no production deployment config exists yet.

  **DoD verification, all against a real, Docker-Composed Postgres
  instance — not mocked**: `pnpm db:migrate` creates all eight tables
  from a clean database (verified twice: once from an empty volume, once
  again after a full `pnpm db:reset`); `pnpm db:reset`
  (`node-pg-migrate down -m migrations 0` followed by `up`) was run to
  completion, confirmed the database returns to exactly `pgmigrations`
  (i.e. every one of the eight tables actually dropped) at the down-0
  step, then rebuilds cleanly; `pnpm test:db`
  (`packages/server/vitest.db.config.ts`, gated out of the default `pnpm
test` for the same reason convergence/properties/mutation are — see "How
  to run the test suite" below) passes all 7 tests: the two existence
  checks, the UPDATE/DELETE no-op checks, the two constraint-rejection
  checks, and the EXPLAIN check, all described above. `pnpm test`
  (301 tests, unrelated to this phase) and `pnpm lint`/`pnpm
format:check`/`pnpm typecheck` were re-run afterward to confirm nothing
  outside this phase's own new files regressed. One PRE-EXISTING,
  unrelated typecheck failure was found this way (out of Phase 15's own
  scope, not caused by it): `packages/server/src/heartbeat.test.ts`
  didn't set the `receivedFrameCount` field Phase 14 added to
  `CoordinatorSession` for its send/receive frame-counting investigation
  (`documentCoordinator.ts`) — confirmed via `git log`/`git show` against
  `d0447cf` (the Phase 14 merge commit) that this predates Phase 15's own
  branch entirely, and via `git status` that neither file was touched by
  Phase 15's own work. Since this failure blocked `pnpm typecheck` at the
  repo root — and therefore blocked CI, `.github/workflows/ci.yml`'s
  `Typecheck` step running unguarded ahead of `Test`/`Adversarial suite`
  in the single `ci` job — it was fixed as a SEPARATE, explicitly-labeled
  one-line change once flagged and confirmed with Srikanth, touching only
  `heartbeat.test.ts`'s `fakeSession()` test fixture (added
  `receivedFrameCount: 0`, a correct fixed value since this fixture never
  exercises frame receipt) — no other Phase 14 file was touched. `pnpm
typecheck` now passes cleanly across all six workspace packages; `pnpm
test` still passes all 301 tests afterward.

- **Phase 16 — Operation log and acknowledgement-implies-durability**
  (API Spec §6.3's write path, §3.5.7 OP_ACK, §11.2; PRD FR-PS-2, FR-PS-3,
  M2; Test Plan DUR-04). The phase brief's own framing was accurate: "the
  single most consequential ordering decision in the system" — and,
  distinctively for this project, it also surfaced THREE separate
  structural conflicts between already-committed designs (Phase 15's
  verbatim schema, Phase 7-14's wire protocol, and Postgres's own rule
  system) that had to be resolved with the user before writing any
  production code, not discovered and patched afterward. All three are
  documented below because each one changes how a future phase should
  reason about this system, not just how Phase 16 was implemented.

  **Decision 1 — persistence had to become injectable, not hard-wired.**
  `createCollabServer()` previously took no arguments. Making the write
  path's new Postgres dependency unconditional would have forced
  `gateway.test.ts`, `httpApp.test.ts`, and — critically —
  `packages/client/src/sync/headlessHarness.test.ts` (part of the
  DEFAULT `pnpm test`, no Postgres required today) to all require a real
  database just to run. Resolved (user-approved) as: an `OperationStore`
  interface with two implementations — `PostgresOperationStore`
  (production, real durability) and `InMemoryOperationStore` (the new
  default for every test that doesn't construct one explicitly, no real
  durability, exactly reproducing pre-Phase-16 behavior). `pnpm test`
  stays infra-free; Phase 16's OWN new persistence tests
  (`packages/server/src/db/*.db.test.ts`) are gated behind `pnpm test:db`,
  the same pattern Phase 15 established.

  **Decision 2 — `operations.seq` had to become per-OPERATION, not
  per-frame.** Since Phase 7, `seq` was assigned once per ingested WIRE
  FRAME — an `OP_INSERT_RUN`/`OP_DELETE_BATCH` frame (Phase 7's "2,000
  characters → one frame" optimization) represents N operations under
  ONE seq. But Phase 15's `operations` table (built verbatim from the
  real spec DDL) has `PRIMARY KEY (document_id, seq)` — one row per seq
  — and `operations_stamp_uq`'s unique index is on singular
  `stamp_r`/`stamp_c` columns, meaning one row can only ever represent
  ONE operation's identity. Storing a run as one row would either violate
  the PK (multiple operations sharing one seq) or lose per-character
  duplicate-stamp protection for every character but the run's first.
  Resolved (user-approved) as: `coordinator.currentSeq` now advances by
  `ops.length` per message, not by 1 — a run of N operations consumes N
  consecutive seq values, and the relayed/acked `seq` is the range's
  STARTING value. The wire format itself is UNCHANGED (a run still
  relays as one compact `OP_INSERT_RUN` frame — Phase 7's optimization
  is intact on the broadcast path); only the numbering underneath it
  changed. `packages/client/src/sync/syncClient.ts`'s `handleOps` was
  updated to compute `endSeq = seq + ops.length - 1` for both
  `highestAppliedSeq` and `gapTracker.observe()` — `gapTracker.ts` itself
  needed NO changes, since its Phase 14 redesign ("advance to any newly
  seen greater seq, regardless of contiguity") already tolerates a
  frame that jumps the counter by more than 1.

  **Decision 3 — a `documents`/`users` row had to exist before ANY
  operation could be persisted, and reaching that row required going
  one FK hop further than first planned.** `operations.document_id`
  references `documents(id)`, and `documents.owner_id` references
  `users(id)` — neither existed anywhere; coordinators were still purely
  in-memory constructs created lazily on first WebSocket connection
  (Phase 8's "any client can join any document by guessing its id, no
  auth yet" design). Resolved (user-approved) as: coordinator warm start
  auto-provisions a `documents` row (owned by a single fixed
  `SYSTEM_USER_ID` placeholder) via `ON CONFLICT (id) DO NOTHING`,
  mirroring the existing no-auth stance rather than inventing new
  semantics. **This decision's own scope turned out to be incomplete,
  discovered only by actually running the write path against a real
  database**: `operations.author_session REFERENCES sessions(id)`, and
  `sessions.user_id REFERENCES users(id)` for a PER-SESSION user — a
  DIFFERENT table Decision 3's original users/documents provisioning
  never touched. Every real commit failed on
  `operations_author_session_fkey` until `commitOperations` ALSO
  auto-provisions a per-session `users` row (keyed by the session's own
  placeholder `userId`, not collapsed onto `SYSTEM_USER_ID` — that would
  have thrown away even the thin per-connection identity signal Phase 8
  already established) and a `sessions` row, both `ON CONFLICT DO
NOTHING`, in the SAME transaction as the operations themselves. This
  extended the already-approved auto-provisioning principle one FK hop
  further rather than reopening the question with the user, since it was
  the same decision applied consistently, not a new fork.

  **⚠️ KNOWN INTERIM BEHAVIOR, flagged explicitly rather than left
  implicit: this auto-provisioning is NOT self-gating and creates REAL,
  PERMANENT rows with no authentication and no rate limiting.** Concretely,
  as of Phase 16: (1) `getOrCreateCoordinator` (gateway.ts) constructs a
  `DocumentCoordinator` for ANY `documentId` a client names in HELLO, no
  validation — its warm start immediately `INSERT`s a real `documents`
  row for it (owned by the placeholder `SYSTEM_USER_ID`). (2)
  `gateway.ts`'s handshake mints a fresh `randomUUID()` as `userId` on
  EVERY connection (never client-supplied) — the first operation that
  session commits creates a real, permanent `users` row and `sessions`
  row for that random id, unconditionally, never reused. This is a
  materially different risk than every EARLIER phase's placeholder
  identity: before Phase 16, a bogus join produced only in-memory state,
  gone on restart; now it produces rows that persist in Postgres forever,
  with no cap — and step 3 of this same phase's write path (rate check)
  is explicitly stubbed to always-allow, so nothing bounds how many.
  This is consistent with this project's standing no-auth stance (Phase
  8: "any client can join any document by guessing its id... not yet a
  security concern since nothing is exposed publicly") — it is not a
  NEW authorization hole — but the unbounded, PERSISTENT row growth is a
  genuinely new operational concern (disk/table growth from anyone who
  can reach the WebSocket endpoint) that prior phases' in-memory-only
  placeholders never had. **It will not be superseded automatically when
  real auth (Phases 26-29) lands** — nothing here is behind a flag or a
  TODO that fails loudly; a future phase must deliberately find and
  replace both auto-provisioning call sites (`PostgresOperationStore.
warmStart`'s documents/system-user insert, and its `commitOperations`'s
  per-session users/sessions insert) with real authenticated-identity
  lookups, or this interim behavior will simply keep running unnoticed.
  Do not point this server at a shared or production-like database
  before that happens.

  **A fourth, unplanned discovery — found only by actually running the
  write path, not by reading the schema — was more fundamental than a
  missing row: Postgres REFUSES `INSERT ... ON CONFLICT` on any table
  that has a `CREATE RULE` defined on it.** `operations` has two
  (`operations_no_update`/`operations_no_delete`, Phase 15, verbatim
  from the spec, not something Phase 16 may change) — so the obvious
  `INSERT ... ON CONFLICT (document_id, stamp_r, stamp_c) DO NOTHING`
  for duplicate-stamp suppression (the DoD's own literal requirement)
  fails outright: `ERROR: INSERT with ON CONFLICT clause cannot be used
with table that has INSERT or UPDATE rules`. This is a genuine,
  load-bearing conflict between two already-committed, unmodifiable
  designs — not a wiring bug — and required a different mechanism
  entirely, not a workaround at the call site. Fixed by wrapping each
  operation's plain `INSERT` (no `ON CONFLICT`) in its own `SAVEPOINT`,
  catching a unique-violation (SQLSTATE `23505`, `operations_stamp_uq`
  firing) and issuing `ROLLBACK TO SAVEPOINT` for just that one row —
  the rest of the transaction (other rows in the same batch, the
  `documents.current_seq` UPDATE, the COMMIT) is unaffected, exactly
  reproducing what `ON CONFLICT DO NOTHING` would have done if Postgres
  allowed it here. See `operationStore.ts`'s `commitOperations` for the
  implementation and its own extensive comment.

  **The write path itself** (`packages/server/src/writePath.ts`,
  `processIncomingOperation`) implements API Spec §6.3's nine steps
  literally, including the two the phase brief explicitly asked to be
  stubbed (`authorize` until Phase 28, rate-check until Phase 30 — both
  always-allow functions with a citing comment, not silently omitted),
  and carries the exact required comment verbatim above the
  broadcast/commit/ack sequence. Step 2 ("verify stamp.r ===
  session.replica_id") is a REAL new check, not decorative — an
  operation whose claimed replica doesn't match the sending session's
  own is rejected with `OP_REJECT`/`IDENTITY_MISMATCH`, sent to the
  sender only, never broadcast or persisted. This broke two PRE-EXISTING
  `gateway.test.ts` tests that hardcoded an arbitrary local `Engine`
  replica id (`101`, `202`) instead of the id the server actually
  assigned via WELCOME — a real, if narrow, gap in those tests' own
  fidelity that this phase's own new correctness check exposed; both
  were fixed to use `welcome.replicaId`, the only reasonable value for a
  client to have used even before this phase.

  **Ack batching** (`packages/server/src/ackBatcher.ts`, `AckBatcher`):
  up to 64 entries or 20ms, whichever first — one per `CoordinatorSession`
  (constructed at handshake time in `gateway.ts`, closed on disconnect).
  A single `add()` call exceeding 64 entries (a large paste) flushes in
  64-entry chunks immediately rather than producing one oversized frame.

  **A real regression, found only by running the FULL existing test
  suite after wiring the write path in — not anticipated in advance**:
  `AckBatcher`'s 20ms timer can fire DURING the gap between
  `Gateway.close()`'s synchronous `ws.terminate()` (Phase 8/9) and the
  socket's asynchronous `'close'` event (which is what calls
  `ackBatcher.close()`) — producing a send-after-close inside
  `sendQueues.ts`'s fire-and-forget `pump()`, which had no error handling
  around its `sendRaw` call and turned that into an unhandled promise
  rejection, observed as two `httpApp.test.ts`-adjacent failures the
  first time the full suite ran post-wiring. This was a genuine gap
  `sendQueues.ts` always had (any late `enqueue()` after termination
  could have hit it), just never previously reachable, since every
  pre-Phase-16 caller only ever enqueued synchronously within the same
  message-handling turn. Fixed in `sendQueues.ts`'s `pump()`: a failed
  send is now caught, marks the queue `closed`, and stops draining —
  the same end state an explicit `close()` call leaves it in — rather
  than propagating.

  **Coordinator warm start** (`DocumentCoordinator`'s `ready: Promise<void>`,
  kicked off in the constructor): replays the persisted log (in seq order
  — causally valid, since a row's own `seq` was only ever assigned after
  a LIVE `applyRemote()` already accepted it, so replaying in that order
  reproduces the same causal-readiness path) into a fresh `engine`, then
  asserts `engine.pending.length === 0` — the DoD's own `pendingCount()
=== 0` requirement — throwing loudly (not continuing silently) if a
  persisted operation's causal dependency is missing. `gateway.ts`'s
  `handleHandshake` (now `async`) awaits `coordinator.ready` before
  admitting ANY client, including the very first connection to a
  brand-new document — so the documents/users/sessions auto-provisioning
  above always happens before that connection's own operations could be
  persisted, and no client can ever be handed a SNAPSHOT of an empty
  engine while that same document's real history is still loading in the
  background. A warm-start failure closes the socket with 1011 (a
  server-side fault, not `closeMalformed`'s 1008).

  **`currentSeq` restoration on warm start reads `documents.current_seq`,
  never `MAX(operations.seq)` or `ops.length`.** A resent duplicate
  operation is still assigned a NEW seq by step 6 before the write path
  ever checks whether its stamp already exists (that check happens only
  at the `INSERT`, via the SAVEPOINT mechanism above) — so a seq value
  can be "spent" (advancing `documents.current_seq`) with NO row of its
  own if the retry's `INSERT` hit a duplicate. Restoring from `ops.length`
  or `MAX(seq)` instead would eventually reissue an already-spent seq
  after a restart and crash on the operations table's own PRIMARY KEY
  the moment a genuinely new operation collided with it — a subtle
  correctness trap avoided by design, documented in
  `operationStore.ts`'s `WarmStartResult` rather than discovered later.

  **DUR-04** (`packages/server/src/db/durability.db.test.ts`): the SAME
  production `writePath.ts` module is exercised in both orderings via
  `MUTATE_ACK_BEFORE_COMMIT=1` (an env flag, per the Test Plan's own
  wording — never set outside this one test, not in `.env.example`, not
  read by any startup path) plus an injected `simulateCrashAtCommitPoint`
  hook (a function parameter, not env-based — precise single-shot
  triggering doesn't fit an env flag) that throws to simulate a crash at
  exactly "the commit point." Under the MUTATED ordering, the throw lands
  BEFORE the transaction starts — the operation is confirmed absent from
  the database afterward (queried directly via a fresh `pool.query`, not
  through the coordinator's own in-memory state, the same "ground truth
  from the database itself" discipline as Phase 15's constraint tests and
  Phase 14's replay endpoint). Under the REAL ordering, the identical
  throw lands AFTER the commit — the operation is confirmed PRESENT.
  This test is permanent (not a one-off verification), runs on every
  future `pnpm test:db`, and is the reason `writePath.ts` reads an env
  var at all rather than taking a constructor-injected ordering flag —
  the phase brief's own point was that the shipped module itself must be
  what gets toggled, not a parallel copy that could drift.

  **Other DoD verification, all against a real, Docker-Composed Postgres
  instance**: a NEW test file,
  `packages/server/src/db/serverRestart.db.test.ts`, builds a REAL
  `createCollabServer()` with a real `PostgresOperationStore`, commits
  "hi" through a real WebSocket client, closes that server AND its pool
  entirely, builds a SECOND real server (fresh port, fresh in-memory
  coordinator map, fresh pool, same database), and confirms a fresh
  client's SNAPSHOT already contains "hi" — the DoD's literal headline
  claim ("server restart replays the log and restores state"), proven
  through the actual `createCollabServer`/`createGateway` construction
  path, not just by constructing a `DocumentCoordinator` directly.
  `durability.db.test.ts` additionally verifies: ON CONFLICT-equivalent
  dedup (the same operation sent through the write path twice produces
  exactly one row); ack batching (a 10-character run produces 10
  `AckEntry` objects, all still individually addressable for the
  client's `UnackedQueue`, batched under the hood); and the latency
  claim (a `commitOperations` wrapped with an artificial 500ms delay —
  test-only, not exported from production code — still lets a peer
  receive the broadcast relay within ~50ms, proving the fanout path
  never waits on the database). All three new `*.db.test.ts` files
  passed together (17 tests) across multiple repeated runs, including
  runs that accumulate data across a shared database without an
  intervening `pnpm db:reset`, to rule out one-off flakiness.

  **DoD verification against the pre-existing suite**: `pnpm test` (301
  tests, unchanged in count) passes with ZERO unhandled rejections after
  the `sendQueues.ts` fix above; `pnpm typecheck`/`pnpm lint`/`pnpm
format:check` all pass across every package. Two pre-existing
  `gateway.test.ts` tests needed the `welcome.replicaId` fix described
  under "the write path itself" above — both are real fixes this
  phase's own new correctness check required, not scope creep into
  unrelated Phase 8/9 territory. `handshake.test.ts` and
  `heartbeat.test.ts`'s fixtures were updated for the new required
  `DocumentCoordinator`/`CoordinatorSession` fields
  (`operationStore`/`ackBatcher`) — mechanical updates, not behavior
  changes.

- **Phase 17 — Snapshots and coordinator warm start** (API Spec §6.4's
  cadence, §2.7's schema; RFC §13.2; PRD FR-PS-4). Implements RFC §13.2's
  MAYBE-SNAPSHOT() — 500 operations or 30 seconds since the last
  snapshot, whichever comes first, checked reactively after every
  committed operation batch — and redirects coordinator warm start
  (Phase 16) from "always replay the full operation log from genesis" to
  "load the latest snapshot, then replay only the suffix after it."

  **A load-bearing note, recorded here per this phase's own explicit
  instruction: snapshots are server-side only and are NOT required to be
  deterministic across replicas (RFC §13.2).** Block splitting (a later
  phase, Engine Spec §7.5) means two replicas can reach the same document
  through different block histories — CONTENT is deterministic (every
  correct replica converges to the same visible text, OBSEQ's whole
  guarantee), but STRUCTURE is not (the exact sequence of tombstones/
  blocks a given replica's engine happens to hold can differ from
  another's, even though both render identical text). This is why
  `snapshots.content` (materialized text) is what the integrity audit
  compares a log replay against — never `snapshots.structure` — and why
  Phase 17's own warm-start correctness test (below) asserts text
  equality against a full genesis replay, not structural equality.

  **`packages/server/src/snapshotter.ts`** (new): `maybeScheduleSnapshot`
  — called as `processIncomingOperation`'s (writePath.ts) own last step,
  after the commit (and ack) have already happened, never awaited. Adds
  `opsJustCommitted` to `coordinator.opsSinceSnap`, checks it against
  `coordinator.snapshotOpThreshold`/`snapshotTimeThresholdMs` (500 /
  30,000ms by default — `SNAPSHOT_OP_THRESHOLD`/
  `SNAPSHOT_TIME_THRESHOLD_MS`), and — if due, and no snapshot write is
  already in flight for this coordinator (`snapshotInFlight`) — defers
  the actual work via `setImmediate`. Scope-IN's own warning
  ("materialize() is O(N) and must never sit between a keystroke and its
  broadcast") is satisfied structurally: scheduling itself is two field
  reads and a comparison, and by the time `setImmediate`'s callback
  fires, this operation's broadcast AND ack have already been sent —
  `writeSnapshotNow` reads `coordinator.engine`/`currentSeq`/
  `opsSinceSnap` AT EXECUTION TIME (not at scheduling time), so a
  snapshot always reflects whatever the latest state actually is by the
  time it runs, never a stale capture, regardless of how many more
  operations landed in the deferral window. A failed write is logged and
  swallowed, deliberately leaving `opsSinceSnap`/`lastSnapAt` unreset —
  the very next committed operation's own `maybeScheduleSnapshot` call
  naturally re-triggers, a retry-via-next-op with no dedicated retry
  logic needed.

  **`DocumentCoordinator` gained a THIRD constructor parameter,
  test-only**: `snapshotThresholds?: { opThreshold?, timeThresholdMs? }`,
  defaulting to the RFC values everywhere in production (`gateway.ts`
  only ever uses the two-argument form). This exists specifically so
  Phase 17's own DoD tests can prove "does not measurably affect
  operation latency" via genuine A/B comparison (a coordinator whose
  threshold can never be reached vs. one at the real RFC value) and
  exercise the 30-second time-based trigger in milliseconds rather than
  actually waiting 30 real seconds — the SAME reactive-check code path,
  just measured against a reachable number.

  **Warm start redesign** (`operationStore.ts`'s `WarmStartResult`,
  `documentCoordinator.ts`'s `warmStart()`): `PostgresOperationStore.
warmStart` now queries `snapshots_latest_idx` for the latest snapshot
  (`ORDER BY seq DESC LIMIT 1` — Phase 15's own index, built for exactly
  this), decodes its `structure` via `decodeStructureSnapshotBody`
  (`@collab-editor/protocol`, Phase 9's placeholder format — used as-is,
  per this phase's own explicit instruction not to touch it), and loads
  only `operations WHERE seq > snapshotSeq` as the suffix (falling back
  to `snapshotSeq = 0` — the full log — when no snapshot exists yet, the
  same behavior every document had before this phase). The coordinator
  seeds its already-constructed `engine` from the snapshot's nodes via
  `replaySnapshotNodesInto` (see below), then replays the suffix via the
  normal `applyRemote` loop, then asserts `pending.length === 0` exactly
  as Phase 16 did — the assertion's meaning is unchanged; only how much
  gets replayed to reach that point is new.

  **`seedEngineFromSnapshot`/its replay logic MOVED from `packages/
client/src/sync/snapshotSeed.ts` to `packages/protocol/src/
snapshotSeed.ts`**, exporting a new `replaySnapshotNodesInto(engine,
  nodes)` (replays into an EXISTING engine — the server's use case, since
  `DocumentCoordinator.engine` is already constructed as a class field)
  alongside the original `seedEngineFromSnapshot(replicaId, nodes)`
  (constructs a fresh one — the client's existing use case, unchanged
  behaviorally). This is a genuine move, not a duplication, unlike
  `wireHelpers.ts`'s deliberate server-logic duplication client-side
  (Phase 10) — that duplication exists specifically because a client must
  never depend on `@collab-editor/server`, a constraint that doesn't
  apply here: both client and server already depend on
  `@collab-editor/protocol`, so there was no reason to maintain two
  copies of the identical two-pass insert-then-delete replay algorithm
  once a second consumer needed it.

  **`DocumentCoordinator.operationLog` was REMOVED entirely, not just
  changed** — a direct, necessary consequence of warm start no longer
  loading the full genesis history into memory. It existed solely to
  back `httpApp.ts`'s two diagnostic endpoints (`/replay`, `/replay-nodes`,
  Test Plan §2.7 E2E-CONV-01 assertion 3's independent ground truth); a
  new `OperationStore.loadFullOperationLog(documentId)` method (real
  implementation: an unfiltered genesis `SELECT`, unchanged from what
  `warmStart` used to run unconditionally; in-memory implementation:
  reads a `Map<documentId, Operation[]>` populated by `commitOperations`,
  needed because this endpoint's own existing test — part of the default
  `pnpm test`, no Postgres — relied on that in-memory tracking, which
  `operationLog`'s removal would otherwise have silently broken) now
  serves both endpoints directly, on demand, deliberately ignoring
  whatever the coordinator's own live `engine` reflects — genuinely MORE
  independent ground truth than before, not less, since it no longer
  touches the coordinator's in-memory state at all.

  **DoD verification, all against a real, Docker-Composed Postgres
  instance** (`packages/server/src/db/snapshots.db.test.ts`, new — 5
  tests): the 500-operation threshold writes a snapshot with `op_count`
  between 500 and 520 (the operation that CROSSES the threshold is always
  included in what triggers the write, never dropped, hence the small
  slack above exactly 500); the 30-second threshold, exercised via the
  test-only constructor override (100ms, not 30,000ms) with the op
  threshold set unreachably high, fires with `op_count = 4` — proving the
  TIME trigger independently of the count trigger; a 5,000-operation
  document (one snapshot at 4,000) warm-starts to text BYTE-IDENTICAL to
  an independent full genesis replay (`loadFullOperationLog` + a fresh
  `Engine`); a 50,000-operation document (one snapshot at 49,000)
  warm-starts in well under the DoD's 2-second budget; and a genuine A/B
  latency comparison (600 real operations through the real write path,
  p95 measured per-call) shows snapshotting-active latency within 2x of
  snapshotting-effectively-disabled latency (a generous margin,
  documented as such — this is real database I/O with natural jitter,
  not a tight statistical claim; the point is ruling out the specific bug
  class of "a snapshot write blocks the hot path," which would blow WAY
  past 2x, not sit within it).

  **Fixture construction for the 5,000/50,000-operation tests
  deliberately avoids the real `Engine`/write path for SETUP** (though
  the actual warm-start/comparison logic under test always goes through
  the real `Engine`): a hand-built left-to-right append chain
  (`buildAppendChain` — each operation's `originLeft` is the immediately
  preceding operation's own id, `originRight` always `null`, independently
  verified against `Engine.localInsert`'s own source to be the identical
  shape real sequential typing produces) is bulk-inserted directly via
  `unnest(...)` (Phase 15's own EXPLAIN-test technique), bypassing the
  real write path's per-row SAVEPOINT transaction machinery entirely.
  This is fixture SETUP speed, not a shortcut on what's being verified —
  warm start itself, and the genesis-replay comparison, always run the
  real `engine.applyRemote()` path Phase 3 built and 60,000 fuzz trials
  have exercised.

  **DoD verification against the pre-existing suite**: `pnpm test` (301
  tests, unchanged in count) and `pnpm test:db` (22 tests: the 17 from
  Phases 15-16 plus these 5) both pass, the latter repeated across
  multiple runs including without an intervening `pnpm db:reset`, to rule
  out one-off flakiness. `pnpm typecheck`/`pnpm lint`/`pnpm format:check`
  all pass across every package. `httpApp.test.ts`'s existing replay-
  endpoint test (default `pnpm test`, `InMemoryOperationStore`) initially
  broke when `operationLog` was removed — a real regression this phase's
  own verification caught, fixed by adding the in-memory tracking
  described above, not by reverting the removal.

- **Phase 18 — Integrity audit and bisect** (API Spec §6.6; Test Plan
  §3.2's DUR-01; PRD FR-PS-6). The phase brief's own framing, worth
  repeating verbatim because it explains why this component exists at
  all: "Every other check compares replicas to each other and would
  report health if they were all wrong in the same way. This one
  compares the live server against an independent replay of durable
  storage." Every prior phase's tests — convergence fuzzing, the
  adversarial suite, E2E-CONV, DUR-04 — all compare two things this
  project itself built against each other. AUDIT() is the first check
  whose failure mode is genuinely different: it can catch a bug shared
  by every replica, because its reference point (a fresh `Engine`
  replaying ONLY what Postgres durably has) shares no code path, no
  memory, and no assumptions with anything else currently running.

  **`packages/server/src/audit.ts`** (`auditDocument`): implements API
  Spec §6.6's six steps. Step 3 (`pendingCount() === 0`, Engine Spec I9)
  is checked and reported BEFORE any text comparison — DUR-01's own
  reasoning, restated in the code: a replay whose buffer is non-empty can
  still MATERIALIZE correctly if the stranded operations were duplicates
  or later deletes, so a text match alone would be a false pass for a
  permanently orphaned operation. Step 4 compares an independent genesis
  replay **through the snapshot's own seq** (not the full/latest replay)
  against `snapshot.content` — a snapshot legitimately represents a
  PREFIX of history once more operations have landed since it was taken,
  which is the normal case for a continuously-running audit; comparing
  against the FULL replay instead (DUR-01's own literal wording, which
  only works because its own test scenario explicitly quiesces first)
  would make a healthy, actively-edited document fail every single audit
  tick. Step 5 (compare against the live coordinator) is genuinely
  OPTIONAL — `AuditOptions.liveText`, a plain string, not a
  `DocumentCoordinator` reference, keeping this module decoupled from
  gateway/server internals — because the standalone CLI (below) has no
  way to read a running server's memory and must still produce a
  meaningful, correct steps-1-4 audit without it.

  **BISECT** (Scope-IN: "must be built, not skipped"). The search space
  is the document's OWN persisted snapshots, ascending by seq — not an
  arbitrary seq range — because a snapshot's `content` is the only thing
  independently checkable AT a specific, known seq without an external
  reference; there is no correct text known in advance at an arbitrary
  seq that isn't a snapshot boundary. Binary search assumes
  `matches(i)` — "does genesis replay through `snapshots[i].seq` equal
  `snapshots[i].content`" — is MONOTONIC across the sorted list (true for
  a prefix, false from some point on), the SAME assumption every real
  bisection tool makes, `git bisect` included, and with the SAME
  documented limitation: a single, isolated, non-contiguous corruption
  (one hand-tampered row, nothing before or after it touched) isn't
  guaranteed to be found correctly by binary search, only by a linear
  scan. Accepted deliberately — the realistic failure mode this audit
  exists to catch is a PERSISTENCE-LAYER bug, which plausibly corrupts a
  contiguous suffix of history once it starts (genuinely monotonic), not
  a surgical single-row edit. With exactly one snapshot (the common case
  for a document that hasn't been running long), bisect correctly
  degenerates to checking that one snapshot — no search machinery
  needed, same code path, matching the DoD's own corruption scenario
  exactly. A live-coordinator mismatch (step 5) with NO corresponding
  snapshot disagreement is reported as its OWN distinct diagnosis —
  "durable storage is internally consistent; the live coordinator itself
  has diverged" — rather than silently reusing the snapshot-bisect
  result, which would misleadingly report "nothing found" for what is
  actually a live/in-memory bug, not a persistence one.

  **`packages/server/src/auditScheduler.ts`** (`startAuditScheduler`):
  the "continuously running production control" half of Phase 18's own
  framing — a `setInterval` (default 5 minutes, `DEFAULT_AUDIT_
INTERVAL_MS`, not a spec-mandated value — RFC §13.2 names 500 ops/30s
  for SNAPSHOTTING specifically, not for how often an unattended audit
  should run; configurable via this function's own parameter precisely
  because it's a judgment call, not a spec number) that audits every
  document with a currently-open `DocumentCoordinator`
  (`gateway.coordinators`), supplying `liveText: coordinator.engine.
text()` for the full 5-step audit. `timer.unref()` so this never keeps
  a Node process alive on its own — every test constructs its own server
  directly (never through `index.ts`'s direct-run block, the only place
  this scheduler is ever started), so no test needs to remember to stop
  it. One document's audit (or even its own coordinator's warm start)
  failing is caught and logged per-document, never aborting the rest of
  that tick's sweep.

  **`packages/server/scripts/admin.ts`** (`pnpm --filter
@collab-editor/server run admin -- audit --doc=<id> [--verbose]`, or
  `pnpm admin audit --doc=<id> [--verbose]` at the repo root) — the
  Scope-IN CLI. `./admin` in the phase brief names the CONCEPT, not a
  literal filename: this project's other admin-style tooling
  (`scripts/seed.ts`, `pnpm db:seed`) is invoked via a pnpm script, not a
  bare shell executable, for the same reason `db:migrate`/`db:seed` are
  — no assumption that a bash script is directly runnable on Windows,
  this project's actual dev environment. A SEPARATE process from any
  running server — connects to Postgres directly via `DATABASE_URL`
  (same pattern as `seed.ts`), never to a live server's memory — so a
  CLI-invoked audit can only ever run steps 1-4 (no `liveText`),
  documented explicitly in the script's own header rather than silently
  producing a partial audit with no explanation. Exits 0 on `result:
'ok'`, 1 on `'mismatch'`/`'error'` (so a cron/script wrapper can alert on
  a nonzero exit code), 2 on a usage error. A real, if minor, wiring bug
  was found and fixed while manually smoke-testing this against a real
  seeded document: the ROOT-level `pnpm admin` wrapper script originally
  ended in a trailing `--` (`"pnpm --filter @collab-editor/server run
admin --"`), which — combined with pnpm's OWN forwarding of a script
  invocation's extra CLI args — produced a literal double `--`, making
  `scripts/admin.ts`'s own arg parser see `"--"` as the `command`
  instead of `"audit"`. Fixed by removing the wrapper's own trailing
  `--`; confirmed via an actual `pnpm admin audit --doc=<seeded-doc-id>
--verbose` run against a real Postgres instance, both from the repo
  root and from `packages/server` directly.

  **`packages/server/src/db/operationStore.ts` gained six new
  `OperationStore` methods**, all implemented for both stores
  (`PostgresOperationStore` for real; `InMemoryOperationStore` with its
  own small in-memory maps, keeping every pre-Phase-18 test infra-free
  exactly as before): `loadFullOperationLogWithSeq` (same query as Phase
  17's `loadFullOperationLog`, but keeping each operation's own `seq` —
  bisect and the `pendingCount()`-error path both need to NAME a
  specific seq, which the seq-stripped version can't provide;
  `loadFullOperationLog` now calls this and drops the seq, rather than
  duplicating the query); `getLatestSnapshot`/`listSnapshots` (content
  only — bisect never needs a snapshot's `structure`, only its stored
  text, for the byte comparison); `writeAuditRun`/`listAuditRuns`/
  `getLastSuccessfulAuditRunAt` (API Spec §2.8's `audit_runs` table,
  written to on EVERY run including a healthy one — a `result: 'ok'`
  row is what "last successful run," the DoD's own metric, is computed
  from).

  **`packages/server/src/httpApp.ts` gained `GET /v1/documents/:id/
audit-runs`** — the DoD's "audit_runs rows are queryable and the 'last
  successful run' timestamp is exposed as a metric" requirement,
  read-only observability (nothing here TRIGGERS an audit — that's the
  scheduler or the CLI). `?limit=` defaults to 20, capped at 200.

  **DoD verification, all against a real, Docker-Composed Postgres
  instance**: DUR-01 passes on a genuine 5,000-operation, 3-client
  session — "3 clients" built via the phase brief's own explicitly
  sanctioned lightest-weight option ("treating headless client sessions
  ... as sufficient," not a real WebSocket/SyncClient/Playwright setup):
  three independent `Engine` instances, each minting its own local
  operations through the REAL write path (`processIncomingOperation`)
  and each receiving every OTHER simulated client's relayed OPS frames
  through a captured `ConnectionSendQueues` callback that decodes and
  applies them — reproducing exactly what three real `SyncClient`s
  would end up with, with no real network involved. DUR-01's own line 7
  ("every client's DOM textContent") is satisfied by comparing all
  three simulated clients' own `engine.text()` against an independent
  genesis replay — there is no real DOM in this test, so this is
  literally the state a DOM would just be rendering. A deliberately
  corrupted snapshot (`UPDATE snapshots SET content = 'CORRUPTED'`) is
  detected, BISECT correctly reports the exact (only) snapshot's own
  seq, an `audit_runs` row records it, and restoring the original
  content makes the audit pass again. An orphaned operation
  (`operations_no_delete` makes literally deleting a middle row
  impossible, so — the SAME substitution Phase 16's own
  `durability.db.test.ts` already established for the identical
  constraint — a second row is inserted directly whose `originLeft`
  references an identifier no other row ever provides) fires the
  `pendingCount()` assertion with `result: 'error'`, distinct from a
  `'mismatch'`. A 100,000-operation document (fixture built via the
  same fast synthetic-append-chain bulk-insert technique Phase 17
  established, since fixture SETUP speed must not be confused with what
  the DoD is actually timing) audits in ~13 seconds, well under the
  30-second budget. `audit_runs` rows are confirmed queryable and
  `getLastSuccessfulAuditRunAt` confirmed to return `null` before any
  run and a real, correctly-ordered timestamp after one. All 5 new
  tests (`packages/server/src/db/audit.db.test.ts`) pass together and
  alongside the full pre-existing `test:db` suite (27 tests across 5
  files total).

  **DoD verification against the pre-existing suite**: `pnpm test` (301
  tests, unchanged) and `pnpm typecheck`/`pnpm lint`/`pnpm format:check`
  all pass across every package. `durability.db.test.ts`'s own
  `delayedStore` test double needed the same six new interface methods
  added as trivial pass-throughs to its wrapped real store — a
  mechanical update, not a behavior change, and the SAME kind of update
  this exact object literal already needed once before, in Phase 17.

- **Phase 19 — Indexed position structure** (Engine Spec §8.5 index
  contract, §8.2-§8.4; RFC §7.8, §10.4; Test Plan §2.6 I6). Replaces
  `packages/engine`'s flat-array, O(N) linear-scan node storage — a
  deliberate Phase 3 placeholder ("no index (§8.5) yet — position lookup
  during integrate() is a linear scan") — with `PositionIndex`
  (`packages/engine/src/positionIndex.ts`), an implicit-key TREAP
  (randomized balanced BST, no rotation bookkeeping) augmented with
  subtree `size` (total node count) and `visibleCount` (non-tombstoned
  count), plus parent pointers for O(log N) upward position walks.
  Explicitly NOT a performance-only change per the phase brief's own
  framing: two acceptance criteria — RC-27 (RFC §10.4) and M3-c/M8-a
  (Engine Spec §8.3) — fail outright without it.

  **What moved to the index, and what deliberately did not.** Engine
  Spec §8.2 measured `integrate()`'s Case A/B/C scan WINDOW as already
  effectively constant (p50=0, p95=4, p99=9 nodes on a 20,000-node
  structure) — the phase brief's own "index what actually costs"
  instruction, so that scan loop's internal logic is UNCHANGED, still
  reading one node at a time via a direct positional accessor
  (`this.index.nodeAt(i)`, replacing `this.nodes[i]`). What WAS O(N) and
  needed to move: `indexOfOrigin` (identifier → position, called twice
  per `integrate()` call, via `PositionIndex.indexOf`), the final
  placement (`this.nodes.splice(...)` → `this.index.insertAt(...)`), and
  `localInsert`/`localDelete`'s visible-position lookups (previously
  `this.visible()` — a full O(N) materialize-then-index on EVERY
  keystroke — now `this.index.nodeAtVisible(k)` directly, O(log N)).
  `stats()` also moved from an O(N) traversal to reading
  `index.size`/`index.visibleSize` directly (O(1) — the augmented counts
  the tree already maintains for every other operation).

  **The six-item Engine Spec §8.5 list is five real operations plus one
  correctness property, not six operations** (the phase brief's own
  wording: "the six operations... and property 6: iteration order
  identical to S at all times" — property 6 is itself the sixth list
  item, not an operation). `PositionIndex` implements all five —
  `indexOf(node)`, `nodeAtVisible(k)`, `visibleIndexOf(node)`,
  `splice(position, deleteCount, ...insert)`, `setDeleted(node,
  deleted)` — plus `toArray()` (an in-order traversal, satisfying
  property 6 by construction: a treap's own ordering invariant IS
  position order, regardless of shape). One additional method,
  `nodeAt(position)` (total-position → node), is NOT one of the five
  named operations but is required internally by `integrate()`'s own
  scan loop (the direct successor to the flat array's `this.nodes[i]`) —
  documented in its own doc comment as exactly that: engine-internal
  plumbing beyond the public contract, the same category as Phase 3's
  own (still-private) `indexOfOrigin`. `splice`'s removal path (`deleteCount
  > 0`) is implemented fully per the spec's own general contract even
  though the engine itself only ever calls it with `deleteCount === 0`
  (physical removal doesn't happen pre-GC, Invariant I5) — a
  half-implemented contract operation would be a worse trap for Phase 21
  (GC) to inherit than a fully correct, currently-unexercised one.

  **`engine.nodes` became a GETTER, not a stored field** — `get nodes():
  readonly Node[] { return this.index.toArray(); }` — preserving the
  exact external shape (`readonly Node[]`) every existing consumer across
  the whole workspace already relies on, confirmed via an exhaustive
  workspace-wide grep before writing a line of engine.ts: server's two
  replay endpoints and its snapshot/audit/handshake code
  (`coordinator.engine.nodes`), `invariants.ts` (reads it ONCE per call
  into a local `const nodes = engine.nodes`, then reuses that reference —
  safe with a getter, no repeated-traversal cost), testkit's
  adversarial/property/mutation suites (`seed.nodes`, all read-only:
  `for...of`, `.map`, indexed reads — never `.push`/`.splice`/reassignment
  outside `engine.ts` itself). This getter is O(N), same as the flat
  array it replaces would cost for the same "materialize the whole
  sequence" operation — the fix is that NOTHING on the hot path calls it
  anymore, not that whole-document reads got any cheaper (they were
  never the problem `Engine Spec §8.2` identified).

  **Priorities are a small deterministic generator (SplitMix32-shaped,
  per-`PositionIndex`-instance seed and counter), not `Math.random()`** —
  a deliberate choice, not an oversight. A treap's SHAPE is a pure
  implementation detail invisible to every external observer (property
  6 above holds regardless of shape), so nothing about convergence
  requires reproducibility here — but this project's engine has been
  kept 100% deterministic given identical inputs since Phase 0 (two
  independent purity-enforcement mechanisms exist for exactly this), and
  `Math.random()` would have been the ONLY source of true
  non-determinism the engine has ever had, for a detail nothing outside
  `positionIndex.ts` can even observe. Priorities are independent of
  node content/position by construction, which is what gives a treap its
  O(log N) EXPECTED height guarantee regardless of insertion PATTERN —
  verified directly, not just asserted: a dedicated unit test inserts
  200 nodes always at position 0 (the exact pattern that degenerates a
  naive unbalanced BST into a linear chain) and confirms `toArray()`
  still returns them in correct order, which by itself doesn't prove
  balance, but the same shape is what the logarithmic scaling benchmark
  below empirically confirms at 100,000 nodes.

  **`applyDelete`/`applyUndelete` now route their tombstone mutation
  through `PositionIndex.setDeleted(node, deleted)`, never `node.deleted
  = true/false` directly** — the SOLE place that field is written as of
  this phase, so the augmented `visibleCount` along a node's ancestor
  path can never drift out of sync with the field it's summarizing. The
  causally-latest `deletedBy` attribution logic itself (Engine Spec §4.5
  line 3, unchanged since Phase 3) is untouched — only the LINE that
  flips `node.deleted` moved.

  **`localDelete`'s snapshot-free rewrite required a real (if small)
  correctness argument, not just a mechanical substitution** — documented
  inline in engine.ts, restated here because it's easy to get wrong by
  intuition: the pre-Phase-19 version snapshotted `this.visible()` ONCE
  and indexed `vis[visibleIndex + k]` for k=0..count-1 into that static
  array. The rewrite instead re-queries the SAME `visibleIndex` against
  the LIVE, mutating index on every iteration. These are equivalent
  because each successful delete removes exactly one unit from vis(S) AT
  `visibleIndex` itself — removing position P shifts everything after P
  left by one, so whatever now occupies that same visible position P is
  exactly what would have been at P+1 in the original snapshot. Verified
  both by direct reasoning and by the fact that every pre-existing
  engine/adversarial/property/convergence test exercising delete ranges
  still passes unchanged.

  **The reference cross-check (Test Plan §2.6 I6)**: a plain flat-array
  linear-scan oracle (`packages/engine/src/positionIndex.crosscheck.test.ts`),
  sharing the SAME `Node` object references as the `PositionIndex` under
  test, driven through an identical random operation sequence per seed.
  Every operation's immediate structural consequence (the resulting
  order, via `toArray()`) is checked after EVERY step; the full
  positional-query contract (`indexOf`/`visibleIndexOf` for every node,
  `nodeAt`/`nodeAtVisible` for every position) is checked exhaustively
  once per seed, against that seed's own accumulated (randomly shaped)
  structure. **10,000/10,000 seeds, zero disagreements.** Split into its
  own file/vitest config (`pnpm test:index`,
  `packages/engine/vitest.crosscheck.config.ts`) rather than living in
  the fast, direct contract-test file (`positionIndex.test.ts`, which
  stays in the default `pnpm test`) — the 10,000-seed run takes ~20s,
  fuzz-suite scale, not inner-loop scale, the same reasoning behind this
  project's existing convergence/properties/mutation split (root
  `vitest.config.ts`'s own `exclude`).

  **A genuine, pre-existing bug found and fixed while re-running the
  mandatory mutation-matrix regression check — NOT a Phase 19 regression,
  but surfaced by this phase's own work.** Re-running `pnpm test:mutation`
  against the rewritten engine initially crashed outright (not a changed
  kill/survive result — a hard failure) with `mutant M2_no_right_bound:
  expected exactly 1 occurrence of its find-text in engine.ts, found 0`.
  Root cause: `packages/testkit/src/mutation/loadMutantEngine.ts` reads
  each source file via plain `readFileSync(..., "utf8")` and matches a
  mutant's `find` string (written with literal `\n`) against it — this
  breaks the instant the target file is checked out with CRLF line
  endings, which `engine.ts` (along with 163 other files, confirmed by
  scanning `packages/**`) already was on this Windows checkout, via
  git's `core.autocrlf=true` — a REPO-WIDE, pre-existing condition
  (`pnpm format:check` already failed on 164 files before this phase
  touched anything) unrelated to any of this phase's own edits. Every
  mutant with a MULTI-LINE `find` string (M2, M3, M5, M6, M7, M8, M9,
  M10 — only single-line M1/M4 survived by accident) was equally broken
  by this, confirmed directly (M5, untouched by this phase's edits,
  failed the identical way). **Fixed at the harness level**, not by
  reformatting the checked-out files: `loadEngine()` now normalizes
  `source.replace(/\r\n/g, "\n")` immediately after reading each file,
  before both the find/replace matching AND the transpile step (TypeScript
  is line-ending-agnostic, so this is always safe) — a durable fix that
  makes the harness robust to line-ending style regardless of how any
  future checkout happens to be configured, rather than a one-time
  workaround. Re-run after the fix: **identical to the documented Phase 6
  baseline** — 9 of 10 mutants killed, `M3_no_case_c` survives every
  suite, same per-mutant kill/survive breakdown column for column. No
  regression, no change in results — the mandatory gate this phase's own
  brief required ("if the mutation matrix's results change at all... stop
  and report that explicitly") is satisfied by their NOT changing.

  **Of the ten mutants, four needed their `find`/`replace` text updated
  to match engine.ts's new source** (not three, as initially scoped
  before implementation — `M9_delete_first_wins` targets the exact same
  `applyDelete` body text as `M6_physical_delete`, which was missed in
  the initial per-mutant scan and only caught by actually re-deriving
  each mutant's anchor text against the rewritten file): `M2_no_right_bound`
  (`this.nodes.length` → `this.index.size`), `M3_no_case_c`
  (`this.nodes.splice(destIndex, 0, node)` → `this.index.insertAt(destIndex,
  node)`), `M6_physical_delete` (`node.deleted = true` → `this.index.setDeleted(node,
  true)` for its FIND anchor — and its REPLACE text's own mutation logic
  also had to change, from `this.nodes.splice(this.nodes.indexOf(node),
  1)` to `this.index.splice(this.index.indexOf(node), 1)`, since
  `this.nodes` is now a getter returning a FRESH throwaway array every
  call — splicing it would silently no-op and falsify the mutant's whole
  point), `M9_delete_first_wins` (same FIND-anchor change as M6; its
  REPLACE text keeps calling `this.index.setDeleted(node, true)`
  unconditionally, changing ONLY the `deletedBy` attribution rule — so
  the index's own `visibleCount` bookkeeping stays correct and isn't an
  unrelated confound for a mutant whose whole point is attribution logic,
  not tombstone visibility). Each mutant's ORIGINAL semantic intent (which
  invariant it violates) is unchanged — only the literal anchor text moved.
  `loadMutantEngine.ts`'s `SOURCE_FILES` list also gained `"positionIndex.ts"`
  (engine.ts now imports it at runtime, not just for types — the mutant
  scratch-directory build would fail to resolve the import otherwise).

  **Full regression suite, re-run in full per the phase brief's own
  CRITICAL instruction, all passing**: default `pnpm test` — 308 tests
  (up from 301; +7 new direct `PositionIndex` contract tests), all
  passing, ~25s (down from an initial ~68s before the reference
  cross-check was split into its own gated file — see below); `pnpm
  test:adversarial` — 22/22 ADV cases; `pnpm test:properties` — 6/6
  suites (PROP-1..5, 10,000 generated cases each); `pnpm test:convergence`
  — **60,000/60,000 seeds converge, zero divergences, zero stuck-pending,
  across all 6 required configs** (C1-baseline 10,000/10,000, C2-collision
  10,000/10,000, C3-delete-heavy 10,000/10,000, C4-deep 10,000/10,000,
  C5-wide 10,000/10,000, C6-skew 10,000/10,000 — every one of the ten
  Engine Spec §5 invariants I0-I9 actively checked via `assertInvariants()`
  after every mutating call, exactly as Phase 4 established); `pnpm
  test:mutation` — 9/10 killed, identical to the Phase 6 baseline (see
  above); `pnpm test:index` — the new 10,000-seed reference cross-check,
  zero disagreements. `pnpm typecheck`/`pnpm lint`/`pnpm check:purity` all
  pass across every package (`check-engine-purity.mjs` now scans 13 files,
  up from 11, `0 violations`). The convergence run took considerably
  longer wall-clock than prior phases' documented runs (~27 minutes) —
  flagged honestly rather than rounded away: part of this is genuine
  per-operation treap overhead (object allocation, recursive split/merge,
  a `Map` lookup per `PositionIndex` operation, versus a flat array's
  native, highly-optimized `splice`/`indexOf` at the SMALL-to-medium
  document sizes a single fuzz trial actually reaches) and part is CPU
  contention from running the mutation-matrix re-run concurrently in a
  separate background process during the same measurement — the two were
  NOT deliberately isolated for a clean timing signal, since correctness
  (zero divergences), not wall-clock speed, is what this particular gate
  exists to verify; the scaling benchmark below is the dedicated,
  isolated timing measurement.

  **Scaling benchmark** (`packages/testkit/src/benchmark/scaling.ts` +
  `scaling.bench.test.ts`, run via `pnpm test:benchmark`; full numbers in
  `docs/benchmarks.md`). Lives in `packages/testkit` (the project's own
  "load harness" package), not `packages/engine` — timing measurement
  needs `performance.now()`, which engine-purity rules forbid everywhere
  in `packages/engine/src`, including test files (`scripts/
  check-engine-purity.mjs`'s own comment: "Test files are scanned too,
  deliberately"). Methodology: build a document of N characters via N
  sequential end-appends, then time 500 FURTHER `localInsert()` calls at
  uniformly random VISIBLE positions (deliberately not more appends — an
  append-only workload never exercises `indexOfOrigin`'s worst case,
  which is what actually distinguishes O(log N) from a linear scan).
  **Measured, at N = 1,000 / 32,000 / 100,000 nodes**: p95 = 0.021ms /
  0.014ms / 0.017ms — **0.80x growth over a 100x size increase** (the
  theoretical O(log N) expectation is ~1.67x; a pre-Phase-19 O(N) scan is
  cited in this phase's own brief as having measured ~61x). **M3-c**
  (Engine Spec §8.3: 100,000-char document, local insert p99 ≤ 16ms):
  measured p99 at 100,000 nodes is **0.030ms**, ~533x under budget.
  **RC-27** (RFC §10.4: previously missed M6 by 3.6x, 12.3s vs. a 1.1s
  target under the old O(N) implementation): with per-operation costs now
  in the tens-of-microseconds range even at 100,000 nodes, the bottleneck
  RC-27 was measuring no longer exists on this path. Two real assertions
  back these numbers, not just a printed report: `p95GrowthRatio <
  10` (generous headroom above the ~1.67x theoretical value, while
  remaining utterly incompatible with ~100x linear growth) and `p99 at
  100,000 nodes ≤ 16` (M3-c's literal number).

## Current phase in progress

None — Phase 19 (indexed position structure) complete. `packages/engine`'s
node storage moved from a flat array (linear-scan position lookup, a
deliberate Phase 3 placeholder) to `PositionIndex`, an implicit-key treap
with O(log N) expected `indexOf`/`nodeAtVisible`/`visibleIndexOf`/`splice`/
`setDeleted`. All required regression gates re-run and passing: default
`pnpm test` (308), `pnpm test:adversarial` (22/22), `pnpm test:properties`
(6/6, 10,000 cases each), `pnpm test:convergence` (60,000/60,000 seeds,
0 divergences), `pnpm test:mutation` (9/10 killed, identical to the Phase
6 baseline — no regression), and the new `pnpm test:index` (10,000-seed
reference cross-check against a linear-scan oracle, zero disagreements).
Scaling benchmark confirms logarithmic growth (p95 0.80x over a 100x size
increase, 1,000 → 100,000 nodes) and M3-c's p99 ≤ 16ms target (measured
0.030ms) — see `docs/benchmarks.md`. A genuine, pre-existing (not
Phase-19-caused) CRLF-sensitivity bug in the mutation-testing harness was
found and fixed along the way — see the Phase 19 completed-phase entry.

## What is explicitly NOT yet built

Undo/redo's real resurrection semantics beyond Undelete's structural
inverse (Phase 36); garbage collection (Phase 21); block run-length
encoding (later, alongside GC) — and because of that, SNAPSHOT's
structure-form body serialization
(`packages/protocol/src/snapshotBody.ts`) is a deliberate Phase 9 placeholder
EXPECTED to be reworked in Phase 20, not a finished format. The OPS and
CONTROL channels both now flow end to end (Phases 7-9); PRESENCE message
types and any presence broadcast do not exist yet (Phase 31) — a stale
session is only logged/marked, never actually removed from anything.
Reconnection catch-up (CATCHUP/ALREADY_HAVE, API Spec §3.6.4-§3.6.7) is not
built server-side — only fresh handshakes work, so every reconnect (Phase
10's `SyncClient` now performs these automatically, with real backoff) gets
a brand-new replica id and a full fresh SNAPSHOT, never a delta. Session-
inactivity eviction (10 minutes with no PING) is scaffolded (constant
defined, cited to §11.4) but not wired to anything — Phase 21's concern.
**Operations are durably persisted as of Phase 16, and snapshotted as of
Phase 17** — every operation is committed to Postgres before its client
is acknowledged (API Spec §6.3), and a coordinator warm-starts from the
latest snapshot plus only the operation-log suffix after it (RFC §13.2's
MAYBE-SNAPSHOT, 500 ops/30s), not a full genesis replay. What remains NOT
built: block run-length encoding (Engine Spec §7.5, Phase 20 —
`snapshotBody.ts`'s structure serialization is still the same Phase 9
placeholder, used as-is per Phase 17's own explicit instruction not to
touch it); garbage collection (Phase 21); any retention/pruning policy
for the `snapshots` table itself (every MAYBE-SNAPSHOT trigger adds a new
row forever — not a problem yet, but nothing prunes old ones);
`SyncClient`'s unacked-operation queue is still in-memory only client-side
(IndexedDB is Phase 22 — a client that closes its tab mid-edit still loses
whatever hadn't been acked yet, even though the SERVER now durably has
everything it did receive); `documents.next_replica_id`/`sessions`/
`document_permissions` are durably provisioned only as a SIDE EFFECT of
Phase 16's own foreign-key requirements (placeholder identities, `ON
CONFLICT DO NOTHING`), not because session/replica-id persistence was
itself in scope — a reconnecting client still gets a brand-new in-memory
replica id (`DocumentCoordinator.allocateReplicaId()`'s counter, still
purely in-memory, unaffected by Phase 16) and the placeholder `sessions`
rows Phase 16 creates carry no real meaning beyond satisfying `operations`'s
foreign keys — **and are REAL, PERMANENT database rows, unbounded by any
rate limit, created for literally any documentId/connection with no
authentication at all; see the Phase 16 entry's "⚠️ KNOWN INTERIM
BEHAVIOR" callout above for the full risk and what must change when
auth lands.** No auth (Phases 26-29) — any WebSocket client can join
any document by guessing its id and is unconditionally granted the
EDITOR role, which is
correct for this phase and not yet a security concern since nothing is
exposed publicly. A React component (`EditorView`), the full `beforeinput`
dispatch pipeline (Phase 12), MutationObserver-based DOM reconciliation
(`MutationSentinel`, Phase 13), and a real demoable app (`packages/client/
src/app/`, Phase 14/Milestone M1) now exist and are wired together —
including, as of Phase 14, a REMOTE peer's edits actually appearing live
in this session's DOM (`SyncClient.onRemoteOpsApplied`, a real gap this
milestone found and fixed — an earlier draft of this document had assumed
remote edits simply wouldn't show up yet; Phase 14's own two-window manual
test proved that assumption both true at the time and unacceptable for a
milestone whose whole point is DEMONSTRATING convergence). What remains
missing is specifically cursor TRANSFORMATION under remote edits (Phase
32): the current fix re-mounts the whole subtree from `engine.text()` on
every remote batch and restores THIS session's own caret to the SAME
NUMERIC visible index it was at before — correct content, but not
adjusted to stay in the same RELATIVE position the way a real concurrent
editor should feel (an insert landing before the local caret should shift
it forward by the insert's length; it currently doesn't). Reconciliation
(Phase 13) separately guards against a FOREIGN mutation drifting the DOM
from the engine, but has one inherent, documented limit worth restating
here rather than only in the Phase 13 completed-phase entry: if a foreign
mutation happens to replace the EXACT DOM node the user's live caret sits
inside, the DOM's own boundary-point-adjustment behavior can move that
caret before this (necessarily async) sentinel ever gets to observe its
"before" position — reconciliation still correctly reverts the CONTENT in
that case, but the restored caret position is best-effort, not guaranteed
to be the literal pre-mutation index. IME composition
(`insertCompositionText`/`deleteCompositionText`) still never emits an
operation and the browser's own composition UI will still visibly
misbehave mid-composition — real IME support was NOT part of Phase 13's
actual scope (Phase 13 built ONLY MutationObserver-based reconciliation;
an earlier phase's documentation had speculatively attributed IME support
to "Phase 13's sentinel," which this correction retracts) and remains
unbuilt, unassigned to a specific phase number in this document yet.
`historyUndo`/`historyRedo` are prevented but stubbed with no engine call
(Phase 36).

**Milestone M1 status, stated plainly (Phase 14's own DoD requirement to
list what's still missing)**: the core promise — two or more real
browsers, real network round trips, converging to byte-identical text
with nothing lost — is proven. Still missing, all previously-scoped to
later phases and unaffected by this milestone: **persistence** (a
coordinator restart loses all content, Phases 15-17), **auth** (any
client can join any document as EDITOR by guessing its id, Phases
26-29), **presence** (no cursors/avatars for other users, Phase 31),
**offline editing** (no queue-and-replay while disconnected — an edit
attempted while reconnecting is simply not applied, Phase 22),
**undo/redo** (stubbed, Phase 36), and **IME composition** (never emits
an operation, unbuilt, unassigned to a phase number). Also still open:
real cursor transformation under remote edits (Phase 32, see above). The
delay-relay test substitute's intermittent full-60-second failure,
initially disclosed as an unresolved limitation, was fully root-caused
the same day and confirmed as a defect in the test harness's
delay-injection layer, not the product (see the Phase 14 completed-phase
entry's final bullets and `tests/regression/README.md`'s "FINAL
RESOLUTION" section) — no longer an open item.

No permissions; no version history; no Docker setup; no deployed
environment. Server state
is in-memory only and lost on restart — correct through Phase 11, not
yet for anything after Phase 15. GitHub branch-
protection required-status-check wiring for
`convergence`/`properties`/`nightly-mutation-matrix` remains a manual,
one-time repo-settings action, as does the nightly workflow's first
manual `workflow_dispatch` trigger (Claude cannot push branches or
trigger GitHub Actions runs).

## Key technical decisions with source citations

- **A `MutationObserver`-based "did I cause this write" guard must be
  synchronous (`observer.takeRecords()` in a `finally` block), never a
  boolean flag — and the failure mode is worse than "extra reconciliations
  per keystroke."** Phase 13 actually swapped the correct implementation
  for a flag-based one and ran the real e2e suite against it: rather than
  merely mis-firing once per keystroke (the DoD's own framing), the broken
  version entered an INFINITE reconciliation loop starting from the very
  first legitimate write, because `reconcile()`'s own corrective re-render
  is itself wrapped in the same guard — under the flag, that re-render's
  own mutation records are never drained, so the observer's callback fires
  for them too, sees the (already-cleared) flag, reconciles again, forever.
  Both e2e tests hung and hit Playwright's 30-second timeout. The general
  lesson: a reactive detector guarding against ITS OWN writes must
  distinguish "did I write this" using information that survives past the
  microtask boundary where the detector's own callback runs — a
  synchronously-cleared flag never does, but synchronously draining the
  observer's OWN queue (leaving nothing for the async callback to see)
  does. — API Spec §7.7.1, §11.11; PRD M3.
- **A live DOM `Selection`/`Range` is not a reliable source of "the caret
  position before this mutation" once the mutation has already happened.**
  The DOM's own CharacterData "replace data" algorithm adjusts any
  Selection/Range boundary point anchored inside the affected node the
  INSTANT `.data` is reassigned — before any `MutationObserver` callback
  (necessarily async) gets a chance to read it. A reactive DOM-reconciler
  can only ever capture whatever the LIVE selection says AT THE MOMENT its
  callback runs, which may already differ from the true pre-mutation
  position if the mutation touched the caret's own anchor node. This is
  not fixable by reading Selection more cleverly; it's fixable only by
  tracking caret position through an independent, proactive channel (not
  yet needed in this project — no phase before 32 requires perfect caret
  fidelity through an arbitrary foreign mutation, only through this
  project's OWN edits, which never hit this path since they go through
  `applyPatches()` and never trigger reconciliation at all). Discovered
  empirically (a test's assumption failed, not predicted in advance) —
  see the Phase 13 completed-phase entry for the exact repro.
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
cp .env.example .env   # PORT (Phase 8) and DATABASE_URL (Phase 15) are read by
                        # packages/server/src/config.ts
pnpm lint
pnpm format:check
pnpm typecheck
pnpm check:purity
pnpm test
```

## How to run Postgres locally (Phase 15, wired into the server as of Phase 16)

```bash
docker compose up -d   # starts postgres:16-alpine, credentials matching .env.example
pnpm db:migrate         # runs every migration in packages/server/migrations/ (node-pg-migrate)
pnpm db:seed            # optional — inserts one dev user + one dev document (idempotent)
```

Other commands: `pnpm db:migrate:down` (rolls back the most recent
migration), `pnpm db:reset` (rolls back to zero, then migrates back up —
this is how migration reversibility is actually tested, not merely
asserted). `pnpm test:db` runs every `packages/server/src/db/*.db.test.ts`
file (schema/constraint checks, Phase 16's DUR-04/warm-start/ack-batching/
latency suite, Phase 17's snapshot/warm-start suite, and Phase 18's
integrity-audit suite) against whatever database `DATABASE_URL` points
at — requires `docker compose up -d` and `pnpm db:migrate` to have been
run first; see "How to run the test suite" below for why it's gated out
of the default `pnpm test`.

**Phase 18's admin CLI**: `pnpm admin audit --doc=<documentId> [--verbose]`
(repo root) or `pnpm --filter @collab-editor/server run admin -- audit
--doc=<documentId> [--verbose]` — runs a real, standalone AUDIT() against
whatever `DATABASE_URL` points at, exits 0 on `ok`, 1 on `mismatch`/
`error`, 2 on a usage error. Requires `docker compose up -d` + `pnpm
db:migrate` (same as everything else on this page) but NOT a running
server — it connects to Postgres directly, the same way `pnpm db:seed`
does.

**As of Phase 16, `pnpm run dev`'s server IS wired to this database for
real** (`index.ts`'s direct-run block constructs a real
`PostgresOperationStore` — the exact same construction
`serverRestart.db.test.ts` exercises automatically, described below;
this was NOT separately re-verified by hand through the M1 demo's
browser UI this phase, only through that automated test) — every
operation sent through the write path is now durably committed to
Postgres before the client's own save indicator would consider it safe
(there is no visible save indicator yet — PRD US-PE-3's actual UI is a
later phase — but the underlying guarantee, "acknowledged implies
durable," is real and DUR-04-tested). `pnpm test`'s own server tests
(`gateway.test.ts`, `httpApp.test.ts`, and client's
`headlessHarness.test.ts`) still run against `InMemoryOperationStore`
(`server.ts`'s own default when no `operationStore` is passed) and
require no Postgres — only `index.ts`'s actual direct-run path
(`pnpm run dev`) and Phase 16's own `*.db.test.ts` files ever construct
a real `PostgresOperationStore`.

**As of Phase 14, both halves of the app can actually be run standalone —
see "How to run the M1 demo" below.** `packages/server` now has `pnpm run
dev` (`tsx watch src/index.ts` — `tsx`, new devDependency, transpiles TS
directly, sidestepping the `dist/` import issue described below entirely)
and `packages/client` has `pnpm run dev` (`node scripts/serveApp.mjs`, an
esbuild `serve()` dev server). Running the COMPILED server output directly
(`node dist/index.js`, i.e. `tsc`'s own build output, not `tsx`) still
fails at import time — verified, not assumed: `@collab-editor/engine` and
`@collab-editor/protocol`'s `package.json` still point `main`/`types` at
`./src/index.ts` (a pre-existing decision from Phase 0, "no project-level
TypeScript references between packages"), which plain Node cannot import
as a module once server's OWN code has been compiled to `dist/`. This has
no effect on `pnpm test` (Vitest transpiles on the fly) or on the new `tsx`
-based dev scripts (same reason) — it only affects a hypothetical
`node dist/index.js` invocation specifically, which nothing in this
project actually does. Fixing it (project references, a bundler, or
switching every package's `main` to point at compiled output) is not
itself part of any phase's stated scope yet and wasn't attempted here to
avoid scope creep — flagging it now so it isn't mistaken for an untested
claim later.

## How to run the Milestone M1 demo

Two terminals, no relay involved (the delay relay is test-only
infrastructure — see the Phase 14 completed-phase entry):

```bash
# Terminal 1 — the real backend
pnpm --filter @collab-editor/server run dev
# → logs {"message":"server.listening","port":8080}

# Terminal 2 — the real frontend
pnpm --filter @collab-editor/client run dev
# → "Confluence Editor client dev server running at http://127.0.0.1:5173/"
```

Then open **`http://127.0.0.1:5173/?doc=demo-m1`** in TWO separate browser
windows (any two real browsers, or two windows of the same one — both
work) — using the exact same `?doc=` value in both is what joins them to
the same document; `getOrCreateDocumentId` (urlParams.ts) would otherwise
mint a fresh, different id per window. Click into the editor in each
window and type — normal typing in one window appears in the other within
about a second (no artificial delay locally); typing THE SAME WORD
simultaneously in both windows, at the same time, is the actual demo:
both windows converge to the identical final text with nothing lost, with
no merge-conflict prompt ever appearing. The connection-state pill in the
header reads "Synced" once both windows are live.

## How to run the test suite

```bash
pnpm test              # Vitest, all packages EXCEPT the convergence + property suites, single run
pnpm test:watch        # Vitest, watch mode
pnpm test:convergence  # the convergence suite ONLY — C1-C6, 10,000 seeds each, invariants active
pnpm test:properties   # the property-based suite ONLY — PROP-1..5, 10,000 generated cases each
pnpm test:adversarial  # the adversarial suite ONLY — ADV-01..22, hand-constructed, also part of `pnpm test`
pnpm test:mutation     # the mutation matrix — ten mutants x four suites, MUT-KILL-01 at a small sanity budget
pnpm test:index        # PositionIndex reference cross-check ONLY — 10,000 seeds vs. a linear-scan oracle (Phase 19, Test Plan §2.6 I6)
pnpm test:benchmark    # PositionIndex scaling benchmark ONLY — p95/p99 at 1,000/32,000/100,000 nodes (Phase 19); real numbers in docs/benchmarks.md
pnpm test:db           # schema (Phase 15) + write-path/durability (Phase 16) suites — requires a real, migrated Postgres
```

### The Playwright suite (real browsers, Phase 11-12)

```bash
cd packages/client
pnpm run test:e2e:install  # one-time: downloads real Chromium + Firefox + WebKit binaries
pnpm run test:e2e          # rebuilds both bundles, then runs every e2e/*.spec.ts against all three browsers
```

Separate from `pnpm test` and from Vitest entirely — Playwright is its own
test runner, configured in `packages/client/playwright.config.ts`, with
three browser projects (`chromium`, `firefox` as of Phase 12, `webkit`).
Test Plan §7.1 requires real browsers specifically because jsdom does not
implement real Selection/Range quirks, and DOM-03's whole point is that
Chromium and WebKit disagree on what an empty, focused contenteditable's
DOM looks like. `e2e/build-bundle.mjs` (esbuild) bundles TWO scripts: `
packages/client/src/binding` into `window.Binding` (Phase 11) and
`e2e/support/inputHarness.ts` into `window.InputHarness` —
`DomWriter`/`SyncClient`/`Engine`/`attachInputPipeline`/`MutationSentinel`
(the last added Phase 13) bundled together for `e2e/inputPipeline.spec.ts`
and `e2e/mutationSentinel.spec.ts`, kept as a test-only e2e support file
rather than a production package export (see the Phase 12 completed-phase
entry above for why `Engine` specifically needed a bundle-only re-export).
Every spec except Phase 14's `convergence.spec.ts` injects its bundle
directly via `page.addScriptTag` against a blank page rather than
navigating to a running app. Currently PASSES: 55 DOM-01/DOM-03 test-runs
(Phase 11, ×3 browsers) plus 64 of 66 `inputPipeline.spec.ts`/
`mutationSentinel.spec.ts` test-runs (Phases 12-13; 2 skipped, both
WebKit-only, for the documented `DataTransfer` protected-mode limitation
— see the Phase 12 entry).

### E2E-CONV (Milestone M1, Phase 14) — the real app, a real server, real network delay

```bash
cd packages/client
pnpm run test:e2e:conv   # runs ONLY convergence.spec.ts, under its own `convergence` Playwright project
```

Unlike every other spec in this suite, `convergence.spec.ts` navigates
real browsers to the REAL app (`scripts/serveApp.mjs`, an ephemeral-port
instance — the SAME dev server the manual M1 demo above uses) through a
REAL `@collab-editor/server` instance (`e2e/support/testServer.ts`, one
per spec file, not `globalSetup` — see that file's own comment for why:
`globalSetup` doesn't share memory with the actual test process, and
E2E-CONV-03 needs to literally kill and restart the server mid-test) and,
for E2E-CONV-01/-02/-03, a delay relay injecting ~150ms round-trip
latency (`e2e/support/delayRelay.ts` — the toxiproxy substitute; see the
Phase 14 completed-phase entry for the four real bugs found fixing it,
and the one disclosed, unresolved limitation at full duration/high
throughput). Duration/timing constants are overridable via environment
variables (`E2E_CONV01_DURATION_MS`, `E2E_CONV02_DURATION_MS`,
`E2E_CONV02_DISCONNECT_MS`, `E2E_CONV03_DURATION_MS`,
`E2E_CONV03_KILL_AT_MS`, `E2E_CONV04_DURATION_MS`) — the DoD's own
values (60s/30s/60s+kill-at-30s/30s) are the code's defaults; shorter
values are useful for fast local iteration and are what this phase's own
validation runs actually used for most of its repeated-run confidence
(see the completed-phase entry for exactly which durations were run how
many times, and the honest DoD status this phase is actually shipping
with).

`pnpm test` currently passes: 308 tests across 37 files (up from 301/36 —
Phase 19 added `packages/engine/src/positionIndex.test.ts`, 7 direct
`PositionIndex` contract tests; the 10,000-seed reference cross-check
lives separately in `positionIndex.crosscheck.test.ts`, run via `pnpm
test:index`, not part of the default suite — see the Phase 19 entry
above). Historical counts below (301/36 etc.) predate Phase 19 and are
kept for their own narrative context; the paragraph immediately below was
written as of Phase 14 — Phase 14 added `packages/client/src/app/{urlParams,App}.test.ts(x)`
and rewrote `gapTracker.test.ts`/part of `syncClient.test.ts` for the
corrected stall semantics; `packages/server/src/httpApp.test.ts` is also
new, covering the `/v1/documents/:id/replay` endpoint), including
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
fixes that check surfaced), and Phase 10's `packages/client/src/sync/
*.test.ts` (34 tests): `backoff.test.ts` (5, the full-jitter envelope
math and the 20-non-identical-delays check), `gapTracker.test.ts` (6),
`unackedQueue.test.ts` (6), `syncClient.test.ts` (13, a fake but fully
synchronous `WebSocketLike` driven together with `vi.useFakeTimers()` —
handshake/SYNC_COMPLETE, snapshot seeding, sequence-gap-triggers-
reconnect, and the full backoff-reset-only-after-60s matrix including
the "dies immediately after WELCOME" case from §3.10's own text), and
`headlessHarness.test.ts` (3, real server + real global `WebSocket`, no
mocks: 1,000-operation convergence, and the kill-the-server/restart-on-
the-same-port/reconnect/re-converge scenario with connection-state
sequence assertions), and Phase 11's `packages/client/src/binding/
*.test.ts` (50 tests: `unicodeOffsets.test.ts`, `renderIndex.test.ts`,
`domEngineConsistency.test.ts` — the last using a real Phase-3 `Engine`,
no DOM — and `domWriter.test.ts`, run under jsdom via a per-file
`// @vitest-environment jsdom` pragma), and Phase 12's
`packages/client/src/input/*.test.ts` (38 tests: `graphemeSegmentation.
test.ts`, 15, plain Node — including the GRA-02 family-ZWJ-emoji fixture
— and `inputPipeline.test.ts`, 23, jsdom, covering every dispatch-table
row reachable without a real OS/clipboard trigger plus the 20-inputType
`defaultPrevented` sweep), `packages/client/src/editor/EditorView.test.
tsx` (4 tests, jsdom, `react-dom/client` + `act` directly — no React
Testing Library dependency), and `packages/client/src/sync/wireHelpers.
test.ts` (5 tests, new this phase) plus one new `syncClient.test.ts` case
covering the "2,000 chars → ONE frame on a fake socket" assertion, and
Phase 13's `packages/client/src/sentinel/mutationSentinel.test.ts` (5
tests, jsdom: MUT-02 via a rogue-sibling-node mutation, the same-node-
replacement caret-restoration edge case, a legitimate-write sanity check,
a 50-write/macrotask-boundary burst sanity check, and the `desync_error`
fault-injection test).
Real-browser coverage (DOM-01's round trip, DOM-03's element-selection
normalization, Phase 12's `inputPipeline.spec.ts`, and Phase 13's
`mutationSentinel.spec.ts`, against real Chromium, Firefox, AND WebKit via
Playwright) is separate from `pnpm test` — see "How to run the Playwright
suite" below.

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
Re-confirmed clean against the Phase 19 `PositionIndex`-backed engine
(all six configs, 60,000/60,000 seeds, zero divergences) — see the Phase
19 completed-phase entry.

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
above for its result. Re-run against the Phase 19 `PositionIndex`-backed
engine: IDENTICAL result (9/10 killed, `M3_no_case_c` survives every
suite, same per-mutant breakdown) — no regression. Four of the ten
mutants' `find`/`replace` text needed updating to match engine.ts's new
source (M2, M3, M6, M9 — see the Phase 19 entry for the full account,
including a genuine pre-existing CRLF-sensitivity bug in
`loadMutantEngine.ts` found and fixed while re-running this).

`pnpm test:index` (Phase 19) currently PASSES: 10,000/10,000 seeds, zero
disagreements between `PositionIndex` and a linear-scan reference oracle
(Test Plan §2.6 I6) — see the Phase 19 completed-phase entry and
`docs/benchmarks.md`.

`pnpm test:db` currently PASSES: 27 tests across five files, run
against a real, Docker-Composed Postgres instance — repeated across
multiple runs (including runs that accumulate data across a shared
database with no intervening `pnpm db:reset`) to rule out one-off
flakiness, not just observed once.
- `packages/server/src/db/schema.db.test.ts` (7, Phase 15) — table/index
  existence (all eight API Spec §2 tables plus every named constraint),
  the `operations` append-only rules (a real `UPDATE` and a real
  `DELETE` both verified as silent no-ops), the `docperm_single_owner_idx`
  and `operations_stamp_uq` rejections (real thrown Postgres errors, not
  application-level checks), and the reconnection-query `EXPLAIN` check
  (`Index Scan using operations_pkey`, no `Seq Scan`, against a
  120,000-row table shaped like the query's real production selectivity
  profile).
- `packages/server/src/db/durability.db.test.ts` (9, Phase 16) — DUR-04's
  two halves (the MUTATED ordering genuinely loses an acked operation;
  the REAL ordering, under the identical crash injection, never does);
  ON-CONFLICT-equivalent dedup (a resent operation commits exactly once,
  via the SAVEPOINT mechanism `operations`'s rules forced — see the
  Phase 16 completed-phase entry); coordinator warm start (`pendingCount()
=== 0` both on a clean replay and confirmed to FIRE — a real thrown
  error — when the persisted log has a genuinely unmet dependency,
  constructed via a direct row insert rather than `DELETE`, which
  `operations_no_delete` correctly blocks); ack batching (64-entries flush
  immediately, fewer flush after 20ms, a real 10-character run through
  the write path produces 10 individually-addressable `AckEntry`
  objects); and the latency claim (a `commitOperations` wrapped with an
  artificial 500ms delay still lets a peer receive the broadcast relay
  within ~50ms).
- `packages/server/src/db/serverRestart.db.test.ts` (1, Phase 16) — a
  REAL `createCollabServer()` with a real `PostgresOperationStore`
  commits "hi" via a real WebSocket client, is closed entirely (server
  and pool), and a SECOND real server (fresh port, fresh in-memory
  coordinator map, fresh pool, same database) hands a fresh client a
  SNAPSHOT that already contains "hi" — the DoD's literal headline claim,
  proven through the actual server construction path.
- `packages/server/src/db/snapshots.db.test.ts` (5, Phase 17) — the
  500-operation trigger (real `op_count` between 500 and 520 in the
  table); the 30-second trigger, exercised via `DocumentCoordinator`'s
  test-only threshold override rather than a real 30-second wait (a
  100ms threshold, op threshold set unreachably high), firing with
  `op_count = 4`; a 5,000-operation document (one snapshot at 4,000)
  warm-starting to text BYTE-IDENTICAL to an independent full genesis
  replay; a 50,000-operation document (one snapshot at 49,000)
  warm-starting in well under 2 seconds; and a genuine A/B p95-latency
  comparison (600 real operations through the real write path,
  snapshotting active vs. effectively disabled via the same threshold
  override) staying within a documented 2x margin — actual measured
  numbers (not just the ratio) are logged on every run via `console.log`,
  since a passing ratio alone can't distinguish "1ms vs 2ms, irrelevant"
  from "50ms vs 100ms, a real regression."
- `packages/server/src/db/audit.db.test.ts` (5, Phase 18) — DUR-01 on a
  real 5,000-operation, 3-client session (three independent `Engine`s,
  each minting through the real write path and receiving every other
  simulated client's relayed frames — no real network — converging to,
  and matching, an independent genesis replay); a deliberately corrupted
  snapshot detected, BISECT correctly identifying the exact (only)
  snapshot's own seq, an `audit_runs` row recording it, and a clean
  restore afterward; an orphaned operation (the same DELETE-is-blocked
  substitution `durability.db.test.ts` established in Phase 16) firing
  `pendingCount()`'s `result: 'error'`, distinct from a `'mismatch'`; a
  100,000-operation document (fixture built via Phase 17's own fast
  bulk-insert technique) auditing in ~13 seconds against the 30-second
  budget; and `audit_runs` confirmed queryable with a correctly-ordered
  "last successful run" timestamp.

Excluded from the default `pnpm test` (requires `docker compose up -d` +
`pnpm db:migrate` first; most dev/CI environments don't have a Postgres
instance running by default) — same reasoning as
convergence/properties/mutation. Not yet wired into CI as its own job;
that requires a Postgres service container in the GitHub Actions
workflow, which neither Phase 15 nor Phase 16's own scope asked for and
wasn't added here to avoid scope creep — worth flagging for whichever
future phase next touches `.github/workflows/ci.yml`.
