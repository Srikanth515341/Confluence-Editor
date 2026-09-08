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

- **Phase 20 — Block run-length encoding** (Engine Spec §7.5, Definitions
  7.5/7.6, Theorem 7.1). Implements the SNAPSHOT structure-form body's
  real wire encoding — replacing Phase 9's deliberate one-record-per-node
  placeholder — as maximal runs of consecutive-counter, same-replica,
  contiguously-anchored nodes, per Definition 7.5. This phase's own block-
  encoding work (`packages/engine/src/block.ts`'s `Block` type,
  `splitBlockAt`/`canMergeBlocks`/`canFollowInBlock`; `positionIndex.ts`
  rewritten to store blocks, not individual nodes, as treap leaves, with a
  per-replica sorted-array index for O(log B) identifier resolution;
  `snapshotBody.ts`'s real block run-length wire format) is real and
  complete — see `docs/benchmarks.md` for the compression numbers (pure
  sequential typing: 50,000x; realistic prose: ~5x; DoD's own >1000x/>4x
  targets both met) — but **this phase's defining event, and by far its
  largest body of work, was not block encoding at all.** While building
  this phase's own DoD test ("encode/decode round trip is lossless over
  500 randomized engine states"), a serious, previously-undiscovered
  correctness bug in the CORE CONVERGENCE ALGORITHM was found — present
  since Phase 3, twelve phases and thousands of prior test runs earlier,
  and untouched by Phase 20's own block-storage work. What follows is
  that investigation's full account, documented at this length
  deliberately: it took two intensive rounds of work across many hours,
  included one wrong turn that was caught and corrected before being
  trusted, and is the single most consequential finding in this
  project's history to date.

  ### The discovery

  Phase 20's own 500-trial randomized round-trip test began intermittently
  hitting Engine Spec §6.2 sub-case iii-d's test-build canary (Phase 6,
  Test Plan §14.2 MUT-KILL-01) — an assertion in `integrate()`'s Case C
  branch that throws if a Case C node would ever outrank the candidate
  being placed, restating sub-case iii-d's own claim that this can never
  happen. It fired at a measured **~23-24% rate** — not a rare edge case.
  This canary had previously fired only once in this project's entire
  history (Phase 6, incidentally, under a deliberately mutated
  `compareRank`) and had survived a directed 10^6-trial search
  (MUT-KILL-01) built specifically to try to disprove it. A ~24% firing
  rate on ordinary randomized states was immediately treated as a major
  finding, not a test-tolerance nuisance to work around — the user
  explicitly stopped all further Phase 20 work the moment this was
  reported and redirected all effort to root-causing it, a redirection
  that held for the remainder of this phase.

  ### Investigation, part 1 — confirming it was real, not a regression

  Using `git worktree` (an explicitly user-sanctioned exception to "never
  touch git," used only for read-only diagnostic checkouts and removed
  immediately after each use) against pre-Phase-19 (`88b3fec`) and
  post-Phase-19/pre-Phase-20 (`main@d18d658`), the identical 500-trial
  generator was run against both. **Byte-identical firing rate (~23.4%),
  same first-failing trial, same error, on every version of this codebase
  this project has ever shipped.** This ruled out Phase 19's index and
  Phase 20's block storage as the cause and confirmed the bug had been
  latent since Phase 3 — present through the ENTIRE 60,000-seed
  convergence suite's history, every adversarial run, every property
  suite, every mutation-matrix run, all of which reported clean.

  ### Investigation, part 2 — minimal repro, hand-trace, and the first (partial) severity finding

  The 30-op failing trial was reduced via delta-debugging to a 4-operation
  minimal reproduction (later saved as `tests/regression/R0008`, satisfying
  Test Plan §2.3 Rule 3 — a full operation stream, not a bare seed — the
  FIRST corpus entry to do so; R0001-R0007 predate this and are
  E2E-sourced with a documented Rule 3 deviation). Hand-traced against
  the exact Case A/B/C control flow: a node originally anchored to the
  fully open window (⊥, ⊥) — Engine Spec §4.1's "insert into a still-empty
  document" shape — can, after being tombstoned (later found NOT to be
  load-bearing — see below), end up sitting inside what has become a much
  NARROWER window for a later, unrelated candidate's own scan. Because ⊥
  can never be a member of Case B's `scanned` set (only real, previously-
  encountered nodes are ever added to it), any node whose relevant origin
  is ⊥ is structurally forced into Case C, regardless of its actual rank
  relative to the candidate.

  Convergence impact was checked empirically, not assumed: for the
  minimal 4-op input alone, TEXT converged identically across delivery
  orders, but full STRUCTURE (tombstones included) did not. A follow-up
  test then asked whether this was permanently cosmetic or could surface —
  delivering one more ordinary insert, anchored to the divergently-placed
  tombstoned node, to all three already-structurally-divergent replicas.
  **3 of 4 tested anchor variants produced genuinely different VISIBLE
  TEXT** (`"itX"` vs `"Xit"`, etc.) — a confirmed, direct violation of
  this project's core convergence promise, not a theoretical curiosity.

  ### Root cause, confirmed against the literal spec text, not just the implementation

  The user supplied Engine Spec §4.3's literal INTEGRATE pseudocode and
  asked for a hand-trace of the ACTUAL SPEC TEXT, not just `engine.ts`.
  Line 17's literal condition — `c.originLeft ≠ ⊥ ∧ c.originLeft ∈
  scanned` — fails outright whenever `c.originLeft = ⊥`, falling through
  to Case C's line 21-22, an UNCONDITIONAL `break` with no rank check
  anywhere in the pseudocode itself. **`engine.ts` was a faithful, exact,
  line-for-line translation of this pseudocode** — the flaw is in the
  approved Engine Specification's own §6.2 sub-case iii-d claim and its
  §4.3 pseudocode, not an implementation deviation introduced during
  Phase 3. This is a real, documented correction to an approved design
  document, not merely a code fix — see the "Engine Spec §6.2 sub-case
  iii-d correction" entry under Key Technical Decisions below.

  ### Why the 60,000-seed convergence suite never caught this — a real gap in the safety net itself

  Before any fix was attempted, the user asked WHY `convergence.test.ts`'s
  60,000-seed suite (C1-C6, this project's primary correctness gate since
  Phase 3) had never once caught this, while the Phase 20 snapshot test's
  own 500-trial generator caught it at ~24%. Investigated via a controlled
  four-axis ablation (op-shape, delivery timing, position selection,
  replica count), swapping one axis at a time between the two generators'
  shapes. **One axis dominated completely**: delivery timing. Every
  "deferred-shuffled" variant (collect ALL of a trial's operations first,
  deliver via one global shuffle at the very end — `runTrial.ts`'s design
  since Phase 2) measured ~0% regardless of every other axis; every
  "immediate" variant (broadcast each operation to every other replica the
  instant it's minted, before generating the next one — the ordinary shape
  of real, live multi-user editing) measured 22-95% depending on config
  shape. Mechanism: under deferred-shuffled delivery, no replica ever sees
  a peer's node until the ENTIRE trial's generation is complete, so no
  operation can ever anchor to a peer's node during generation — which is
  exactly the geometry this bug needs. **This means the 60,000-seed suite
  was never actually testing the failure mode real, live collaborative
  editing produces constantly** — its clean history was never false, but
  it was also never evidence against this specific bug class, because its
  generator was structurally incapable of reaching it. This was treated as
  nearly as significant a finding as the bug itself, since it exposed a
  real blind spot in this project's own primary safety net.

  ### The first fix attempt that was found unsound BEFORE being built — not after

  Two fix approaches were proposed before either was implemented: Approach
  1 (give Case C's `else` branch the same rank check Case A already has,
  replacing the blind `break`) and Approach 2 (a geometric reformulation
  of Case B's nesting test, hoped to preserve "Case C is usually a no-op"
  and avoid Approach 1's larger blast radius on the Phase 6 canary/
  mutation-matrix apparatus). Following this project's own established
  discipline (Phase 6's M2/M9 re-derivation, Phase 13's flag experiment),
  Approach 2 was hand-traced against the actual R0008 repro geometry
  BEFORE any code was written for it — and found NOT to close the bug:
  the excluded predecessor's own origin window is WIDER than, not nested
  inside, the candidate's window, so a positional-nesting test can't
  distinguish the failing case from the safe one. This negative result
  was reported honestly rather than silently discarded or forced to work.
  Approach 3 (a tree-based, Fugue-style rewrite) was named as the
  theoretically cleanest option but set aside as disproportionate to
  attempt as an emergency fix under time pressure. **Approach 1 was
  chosen and built.**

  ### Approach 1, built gated/separate, verified, merged — R0008

  Built first as a scratch copy of `engine.ts` (never the real file),
  verified against: the R0008 repro and two constructed variants (Q1:
  originRight=⊥ instead of originLeft=⊥, confirming the bug is not
  specific to document-start insertions; Q2: both competing nodes LIVE,
  never tombstoned, confirming tombstoning was never load-bearing — it
  merely happened to be present in the first minimal repro) across
  EVERY exhaustive delivery-order permutation; all 22 adversarial cases;
  all worked traces (§10.1/§10.3/§10.5/§10.7); all 5 property suites; and
  a decisive demonstration — the "immediate delivery" distribution
  identified above, run against BOTH the real and fixed engine across all
  6 real config shapes (500 seeds × 6 = 3,000 trials each): the real
  engine canary-fired on 2,454/3,000 (81.8%, reaching 100% on the
  higher-replica-count configs); the fixed engine, zero failures of any
  kind. Only after this full verification was Approach 1 merged into the
  real `engine.ts`.

  ### A second, silent gap found immediately after — R0009

  Building R0008's OWN permanent regression fixture (per Test Plan §2.3)
  required a properly non-confounded repro. The first attempt at
  "distinct replica ids" was itself flawed — an accidental replica-id
  choice made the excluded predecessor never actually outrank the
  candidate, so the "test" passed vacuously regardless of any fix,
  proving nothing. This was caught before being trusted, and a properly
  validated relationship was derived (`i.r < p.r < t.r`, chosen so Case A
  resolves the direct competitors deterministically AND the excluded
  predecessor genuinely outranks the final candidate). Re-verifying
  Approach 1 against THIS corrected repro revealed **a second, structurally
  distinct gap**, this time in Case B: a wide-window candidate's scan,
  reaching a node anchored onto an already-resolved competitor from
  earlier in the SAME scan pass, blindly inherited that competitor's fate
  via Case B's group-membership test — WITHOUT ever directly comparing its
  own rank against the candidate. Unlike R0008, this produced **silent**
  divergence: zero throws, zero canary, genuinely different VISIBLE TEXT
  (`"ipt"` vs `"itp"`) depending purely on delivery order. Confirmed
  robust across 5 different numeric replica-id combinations sharing the
  same qualitative relationship, all producing the identical split. This
  was treated as the SAME emergency-priority investigation, not split
  into a separate follow-up.

  Root cause is a refinement of R0008's own principle: an anchor being
  INSIDE the scanned region isn't sufficient either, when the specific
  comparison that put it there was between a DIFFERENT pair than the one
  actually in question. R0008: not compared at all. R0009: compared, but
  via a proxy pair, not the real one.

  ### The R0009 fix, hand-traced for a specific risk before being built

  A naive fix (require `compareRank(other, node) < 0` to advance in Case
  B, mirroring Approach 1 exactly) was hand-traced FIRST against the
  concern it could break RFC NQ-2's own non-interleaving guarantee (the
  entire reason Case B's group-inheritance exists — see Case A line 13's
  originRight-equality test and its own "zcybxa vs cbazyx" history). The
  reasoning: for a genuine single-author contiguous run, every character
  is minted by the SAME replica as its own anchor, so if the anchor beats
  a candidate, every descendant automatically shares that same rank
  relationship — the new check is a no-op for real runs. It only changes
  behavior when a chain crosses an authorship/replica boundary, which
  isn't really "one run" in the intended sense to begin with. This
  reasoning was verified, not just trusted: a hand-built same-author
  3-character run swept by a concurrent competitor stayed fully contiguous
  under the fix (3 rank combinations, all converging to e.g. `"XabcM"`); a
  cross-replica chain (NOT a real single-author run) still converged, just
  without forced contiguity; a depth-2 chain crossing an authorship
  boundary partway through split at exactly the right point and converged.
  Case A was explicitly hunted for a third instance of this same bug shape
  per the user's own direct instruction and confirmed architecturally
  immune — it always performs a direct pairwise rank comparison and never
  inherits a decision from group membership, so there is no proxy-pair
  vulnerability for it to have.

  ### Final, combined verification, against the merged real engine.ts

  With both fixes merged: `pnpm test` (321/321, up from 308 — Phase 20's
  own new `block.test.ts`/`compression.bench.test.ts` files and others
  contribute the delta), `pnpm test:adversarial` (22/22),
  `pnpm test:properties` (6/6 suites, 10,000 cases each),
  `pnpm test:index` (10,000-seed PositionIndex cross-check, zero
  disagreements), `pnpm test:benchmark` (scaling + compression, all DoD
  targets met — see `docs/benchmarks.md`), and `pnpm test:convergence`
  re-run across all SEVEN configs — all passing together, on the real,
  merged file. R0008, Q1, Q2, and R0009 were all re-verified exhaustively
  (every delivery-order permutation) against the merged engine: fully
  convergent, structure and text, zero throws. A 30,000-trial
  immediate-delivery fuzz run (5,000 seeds × 6 configs) against the
  fully-fixed engine, run before the merge as part of choosing to merge:
  zero canary fires, zero divergence of any kind, zero stuck-pending.

  **`pnpm test:convergence` full per-config results (real, merged engine,
  10,000 seeds each, 70,000 total, ~34.5 minutes wall time)** — reported
  per config, not just as a pass/fail total, specifically so C7's own
  contribution is visible rather than folded away:

  | Config | Seeds | Result | Wall time |
  |---|---|---|---|
  | C1-baseline | 10,000/10,000 converged | ✓ | 119.9s |
  | C2-collision | 10,000/10,000 converged | ✓ | 167.6s |
  | C3-delete-heavy | 10,000/10,000 converged | ✓ | 362.8s |
  | C4-deep | 10,000/10,000 converged | ✓ | 219.7s |
  | C5-wide | 10,000/10,000 converged | ✓ | 876.7s |
  | C6-skew | 10,000/10,000 converged | ✓ | 185.3s |
  | **C7-immediate-delivery** | **10,000/10,000 converged** | **✓** | **136.6s** |

  C7 — the config actually exercising the immediate-delivery pattern that
  found both bugs (pre-fix, this same shape measured canary/divergence
  rates in the tens of percent, as high as 100% on some C-shape variants
  in the earlier 3,000-trial demonstration) — is now clean at the full,
  standard 10,000-seed budget every other config runs at, not a reduced
  or special-cased count. Zero divergences, zero stuck-pending, zero
  errors, across all seven configs, all ten Engine Spec I0-I9 invariants
  actively checked on every mutating call throughout.

  ### A permanent new fuzz config — C7_IMMEDIATE_DELIVERY

  `packages/testkit/src/fuzz/configs.ts` gained a `deliveryMode:
  "deferred-shuffled" | "immediate"` field on `TrialConfig` (default
  `"deferred-shuffled"`, preserving C1-C6's exact existing behavior) and
  `runTrial.ts` gained real support for it — under `"immediate"`, each
  minted operation (plus its own independently-rolled duplicate check) is
  broadcast to every other replica synchronously, before the next
  operation is generated, instead of being queued for the end-of-trial
  global shuffle. `C7_IMMEDIATE_DELIVERY` (same replica count/rounds/
  hot-region width as C1_BASELINE — only delivery mode differs) is now a
  PERMANENT member of `ALL_CONFIGS`, which `convergence.test.ts` already
  iterates via `describe.each` — so it runs automatically in the same
  10,000-seed sweep as C1-C6, in `pnpm test:convergence` and in CI's
  `convergence` job, with no separate wiring needed. This is not optional
  stress coverage: it is the ONLY configuration in this file capable of
  reaching the Case B/C rank-violation bug class this phase found — every
  future change to `integrate()` must be checked against it, not only
  C1-C6.

  ### The canary — redefined, not retired

  Engine Spec §6.2 sub-case iii-d's original claim is now known false by
  design (both Case B and Case C legitimately participate in placement),
  so the original assertion (restating that claim, throwing if violated)
  could not be left as-is — leaving it would either be dead code (if
  scoped narrowly) or actively misleading (if its old justification text
  remained). It was neither silently deleted nor left stale: `integrate()`
  now ends with a general structural sanity check — `destIndex` must
  remain within `[leftIndex+1, rightIndex]`, the window this specific scan
  is even allowed to place into — true regardless of which branch (A/B/C)
  decided it, and unrelated to the retired sub-case iii-d claim. This is a
  genuinely different, still-meaningful invariant, not a renamed
  continuation of the dead one — chosen after concluding no still-
  meaningful invariant specific to "Case C/B's decision was correct" could
  be defined without re-deriving the very correctness argument the fix
  itself now provides.

  `mutants.ts`'s `M3_no_case_c` mutant (Test Plan §2.8) had its `find`/
  `replace` anchors updated to match the new Case C code shape (the old
  throw+`break` anchor no longer exists) and its `violatedInvariant`
  citation changed from "Engine Spec §6.2 sub-case iii-d" (retired) to
  "I6 (scan-window determinism)" — its actual violated property, unchanged
  in spirit (Case C failing to stop where it should), just no longer
  attributed to a claim now known false. See the mutation-matrix results
  below for what this changed in practice.

  ### Mutation matrix, re-run on the final merged engine

  Re-ran `pnpm test:mutation` on the real, merged `engine.ts` (both fixes
  live). **Result, stated precisely because it's a genuine correction to
  what was expected going in**: `M3_no_case_c` STILL SURVIVES EVERY SUITE
  — identical Overall status to the Phase 6/19 baseline, not the
  "expected to change" framing used mid-investigation. Confirmed this
  isn't a harness malfunction, not just assumed: the mutation test itself
  passed cleanly (exit 0), meaning `loadMutantEngine.ts`'s "find text must
  match exactly once" check succeeded against the new Case C code shape —
  the mutation genuinely applied and genuinely evaded detection, the same
  as before.

  Why this makes sense on reflection, not just an unexplained anomaly:
  `M3_no_case_c`'s patch removes the `break` specifically in Case C's
  "other does NOT outrank node" branch — i.e., it makes the scan keep
  running PAST the point the (now-correct) algorithm should stop, rather
  than making it advance somewhere it shouldn't. This is a different
  failure mode than what R0008/R0009 were about (a wrong ADVANCE/inherit
  decision at a specific point), and fixing those doesn't change whether
  M3's specific "keep scanning past a correct stop" mutation happens to
  produce an observable difference under this matrix's four targeted,
  small-seed-count suites — same as it never did across Phase 6's
  original MUT-KILL-01 (20,000-trial directed search) or any prior
  re-run. `M3_no_case_c` surviving is EXPECTED and by design (it's why
  MUT-KILL-01 and the Phase 6 canary existed in the first place) — it is
  not evidence the R0008/R0009 fix is incomplete, since R0008/R0009's own
  repros (a completely different, targeted construction) are what
  actually proves the fix, verified exhaustively above, independent of
  this mutant.

  No other mutant's Overall status changed: `M1/M2/M4/M5/M6/M7/M8/M9/M10`
  all remain **KILLED**, identical per-suite breakdown to the pre-fix
  baseline. `M3_no_case_c`'s `violatedInvariant` citation is confirmed
  updated in the regenerated `docs/mutation-matrix.md` — "I6 (scan-window
  determinism)", no longer citing the retired "Engine Spec §6.2 sub-case
  iii-d". Full per-mutant table: `docs/mutation-matrix.md` (regenerated
  fresh by this run, 2026-09-02T23:08:59Z).

  ### Regression corpus — R0008 and R0009, permanent per Test Plan §2.3 Rule 2

  Both entries remain in `tests/regression/` even though both are now
  FIXED — Rule 2 ("entries are never removed") applies to fixed bugs as
  much as open ones; a corpus entry documents a bug that happened, not a
  currently-open issue. `tests/regression/README.md` updated accordingly.
  R0008 is also this corpus's first entry to fully satisfy Rule 3 (a
  byte-exact operation stream, not a post-hoc seed/log) — R0001-R0007
  predate this and carry a documented Rule 3 deviation of their own.

  ### DoD verification — the block encoding itself, unaffected by any of the above

  All of Phase 20's own original DoD items were verified independently of
  the bug investigation, since the bug and its fixes touch `integrate()`
  only, never block storage: `docs/benchmarks.md`'s compression numbers
  (pure sequential typing 50,000x, realistic prose ~5x, both clearing
  their DoD targets), M8-b's memory measurement (documented honestly as
  NOT clearing RFC §2.5's 10MB target at 100,000 operations — 77.62MB
  measured — attributed to `deletedBy` uniqueness from `localDelete`'s
  per-character DeleteOperations limiting tombstone-merging, a real,
  disclosed gap, not glossed over), and the `snapshotBody.ts` round-trip
  test itself — now finally clean with NO skip/workaround logic at all,
  since there is nothing left to skip.

- **Phase 21 — Tombstone garbage collection** (Engine Spec §7.3 causal
  stability, §7.4 COLLECT, §7.6 eviction, §7.7 undo horizon; API Spec §6.5;
  Test Plan M8-c/M8-d). Reclaims tombstones once no active replica can
  reference them, bounding the unbounded tombstone growth PRD R2 names as
  the canonical long-horizon failure mode. Built against the real spec
  text (Definitions 7.1-7.4, the COLLECT pseudocode, Rules 7.1-7.3) pasted
  in up front, with an explicit warning from the user going in: Phase 20
  had just found and fixed two serious bugs in the SAME anchor-tracking
  mechanism (`originLeft`/`originRight` membership) that GC's own
  condition 3 depends on, so this phase's verification treats that
  overlap as a real risk, not a formality — see the exhaustive-check
  paragraph below.

  **`Engine.collect(frontier, options)`** (`packages/engine/src/engine.ts`)
  implements Definition 7.4's four conditions and §7.4's fixpoint sweep
  directly over `engine.nodes` (the fully-decoded `Node[]` view) rather
  than reasoning about Phase 20's block storage internally — block
  boundaries are a storage detail invisible to this algorithm, exactly as
  intended; removal at the end goes through `PositionIndex.splice()`,
  which Phase 19 already built (and left fully implemented, unused) for
  exactly this purpose. Two new small pieces of engine-side bookkeeping
  make this possible without breaking Engine Spec C9's "no wall clock, no
  externally-numbered concepts" purity rule: `deleteContext: Map<string,
  {seq, atMs}>`, populated ONLY when `applyRemote(op, context)` is called
  WITH its new, optional third argument — every existing caller (the
  fuzz/property/adversarial suites, `localInsert`/`localDelete`,
  `SyncClient`) omits it, so this map stays empty for them and `collect()`
  finds nothing collectible — collection is opt-in and provably cannot
  change behavior for any pre-Phase-21 code path (confirmed: the full
  default `pnpm test`, `test:adversarial`, and `test:properties` suites
  all re-ran clean, unchanged, after this landed). `atMs`/`seq` are
  supplied, never read from a clock, the same discipline
  `observe(remoteCounter)` and `preSkewClock` already established.
  `maxCounterByReplica: Map<number, number>` (highest Lamport counter
  seen per replica, updated on every applied op) is what lets the undo
  horizon's op-count half ("200 operations by that user," Rule 7.3) be
  computed at all — pre-auth, "that user" is approximated as "that
  replica" minting the delete, the same simplification this project has
  used for every not-yet-real-auth decision since Phase 8/9.

  **`invariants.ts` gained `AssertInvariantsOptions.afterCollect`** — the
  ONE sanctioned exception to I5's "structure never shrinks" check,
  resetting that check's baseline to the new, smaller count rather than
  weakening the invariant generally: any OTHER shrinkage is still a real
  I5 violation. I4 (origin presence) is deliberately NOT exempted by this
  flag and runs exactly as always — a passing I4 check immediately after
  `collect()` is the live, per-call proof that no remaining node
  references a removed one, not a property `collect()` is trusted to have
  gotten right on its own say-so.

  **The exhaustive check the user explicitly asked for, given Phase 20's
  own history with this exact mechanism**: `engine.test.ts` gained a
  200-trial randomized test that builds a document, deletes roughly half
  of it WITH GC context, then sweeps 5 different randomly-chosen
  `(frontier, horizon)` combinations against the SAME engine — 1,000 total
  `collect()` calls — asserting `assertInvariants(engine, { afterCollect:
  true })` (which includes I4) after EVERY SINGLE call, not just the
  last, plus that visible text never changes. All 1,000 calls pass with
  zero I4 violations. Beyond the fuzz-style check, dedicated hand-built
  tests separately verify each of Definition 7.4's four conditions in
  isolation, the "no context = never collectible" backward-compatibility
  guarantee, and — the case this project's own Phase 20 history says to
  distrust most — the multi-level fixpoint anchor cascade: a chain of
  three consecutively-deleted nodes B→C→D stays fully protected as long
  as a LIVE node anchors to D, and becomes collectible as one unit the
  moment that live anchor is itself deleted and ages out, verified via
  `engine.text()` staying correct and `stats().totalElements` reflecting
  the expected count at each step. The M8-c server-side DoD test
  (below) repeats this same "no live node names a collected node as an
  origin" check a second, independent way — a from-scratch re-derivation
  of the id-reference scan, not a call into `assertInvariants`' own code
  path — specifically because Phase 20's own lesson was "the same
  mechanism checking itself is not enough confidence" for this exact bug
  class.

  **Server-side wiring**: `packages/server/src/db/operationStore.ts`
  gained `SessionHeartbeatInput`/`upsertSessionHeartbeat` and
  `getStabilityFrontier` on the `OperationStore` interface (both
  implementations). `upsertSessionHeartbeat` is a REAL, necessary fix, not
  just new functionality: `sessions.last_ack_seq`/`last_seen_at` (Phase
  15's own schema, built specifically for this phase — see that
  migration's own comments anticipating "the GC stability-frontier
  query") had NEVER been written by anything before this phase, outside
  writePath.ts's one-time auto-provisioning insert on a session's FIRST
  committed operation. A session that only ever READS would have been
  silently invisible to the frontier query forever — this phase closes
  that gap by upserting the heartbeat at JOIN time (gateway.ts, so even a
  silent reader gets a row immediately) and on every PING thereafter
  (replacing/supplementing the in-memory-only `coordinator.watermarks`
  Phase 8 built). `getStabilityFrontier` implements API Spec §6.5's own
  query almost verbatim: `MIN(last_ack_seq)` across sessions with
  `last_seen_at` inside the 10-minute offline window, `COALESCE`d to
  `documents.current_seq` when nobody's active — cold-load compaction,
  by construction, with no separate code path.

  **Rule 7.1 (eviction) needed NO separate eviction bookkeeping at all** —
  a session simply stops appearing in `getStabilityFrontier`'s own result
  once its `last_seen_at` ages past the query's 10-minute WHERE clause.
  The literal required comment ("10 minutes, NOT the 8-second
  presence-stale threshold...") appears at BOTH `heartbeat.ts`'s
  `SESSION_INACTIVE_MS` constant (now genuinely live, previously dead per
  Phase 9's own scaffolding note) and at the SQL query itself in
  `operationStore.ts`, since SQL can't import a JS constant and the two
  values have to be kept in sync by hand.

  **`writePath.ts`'s step 5/6 boundary was reordered, not just extended**:
  `startSeq` is now computed BEFORE `applyRemote` runs (not after), so
  each operation's own seq is known AT apply time and can be threaded
  into `applyRemote`'s new context argument — under the ORIGINAL
  apply-then-assign order, a Delete would have no seq yet at the moment
  it needed one. Still fully synchronous end to end (no `await` between
  reading and advancing `coordinator.currentSeq`), so the "no other
  write path can interleave here" monotonicity argument the original
  code's own comment made is unaffected — confirmed by re-reading, not
  merely assumed.

  **Warm start now threads GC context through a server restart too, not
  just live traffic**: `WarmStartResult.suffixOps` changed from `readonly
  Operation[]` to `readonly WarmStartSuffixOperation[]` (`{op, seq,
  committedAtMs}`), reading `operations.committed_at` — a column that
  already existed (Phase 15), explicitly marked "observability ONLY;
  never read for ordering." Using it for GC's age check is not an
  ordering use (it never decides WHERE an operation integrates, only WHEN
  a tombstone becomes eligible for removal), so this doesn't violate that
  constraint. Without this, a Delete replayed after a restart would carry
  no GC context at all and could never become collectible until
  superseded by a fresh delete — a real effectiveness gap for any
  long-lived, previously-restarted document, not merely cosmetic, closed
  before it could ever be observed in production.

  **`gcScheduler.ts`** (new, mirrors `auditScheduler.ts`'s Phase 18 shape
  exactly, including WHY: in-process, one GC cycle per currently-open
  coordinator, `timer.unref()` so tests never need to remember to stop
  it, one document's failure never stopping the rest of that tick's
  sweep). `runOneDocument` is exported directly (not only reachable via
  the timer) specifically so tests can trigger exactly one deterministic
  cycle instead of waiting on the real interval or faking timers.
  `config.ts` gained `GcConfig` (`undoHorizonMaxAgeMs`/
  `undoHorizonMaxOpsPerReplica`/`gcIntervalMs`), env-overridable with
  RFC-matching defaults (5min/200ops/60s) — Scope-IN's own explicit
  instruction: the undo horizon is CONFIGURATION, not a constant, because
  Engine Spec §7.7 itself flags the proposed values as "unvalidated."
  `index.ts`'s direct-run block starts `startGcScheduler` alongside the
  existing `startAuditScheduler`, same reasoning, same "only a real `pnpm
run dev` process starts either; every test constructs its own server and
  never reaches this branch" scoping.

  **Metrics** (Scope-IN's own list — "GC's failure mode is silent, so
  liveness is monitored, not errors"): `DocumentCoordinator` gained
  `lastGcAttemptAt`/`lastGcSuccessAt`/`lastGcCollectedCount`/
  `lastKnownFrontier`/`frontierLastAdvancedAt`, updated by every GC cycle
  (success OR failure — `lastGcAttemptAt` always advances so
  `minutes_since_last_success` can grow even while cycles keep firing on
  schedule, which is exactly the "looks alive but is actually stuck"
  failure this metric exists to catch). Exposed read-only via a new
  `GET /v1/documents/:id/gc-status` endpoint (`httpApp.ts`, same pattern
  as Phase 18's `/audit-runs`): `minutesSinceLastSuccess`,
  `nodesCollectedLastCycle`, `frontier`, `frontierLagSeconds` (seconds
  since the frontier's own value last advanced — a genuine staleness
  signal distinct from GC's own success/failure), `tombstoneRatio`
  (`doc.tombstone_ratio`), `totalElements`/`tombstones`.

  **DoD tests** (`packages/server/src/db/gc.db.test.ts`, new — **written,
  then actually executed against a real, migrated Postgres instance
  (`docker compose up -d`, `pnpm db:migrate`, `pnpm test:db`), not merely
  typechecked** — the user explicitly required this before accepting the
  phase, and it surfaced real bugs a typecheck alone could never have
  caught (below), which is exactly why). M8-c: a 90,000-character document
  bulk-seeded for fixture speed (same technique Phase 17/18 established —
  fixture SETUP speed must never be confused with what's actually
  measured), then 10,000 real deletes through the ACTUAL write path (the
  only path that attaches GC context) across two simulated clients, both
  acking, one real GC cycle via `runOneDocument` (not calling
  `engine.collect()` directly — exercises the real frontier-query/config
  plumbing too). **Observed, real result**: `frontier=100000,
  collectedCount=10000, totalElements 90000→80000, tombstones 10000→0,
  tombstoneRatio→0` — a full 100% drop, not merely "material." Visible
  text confirmed byte-identical before/after. The integrity audit
  (Phase 18) ran for real and returned `result: "ok", replayedToSeq:
  100000, detail: "replayed 100000 operation(s) through seq 100000;
  pendingCount() === 0; matches snapshot at seq 99554; matches the live
  coordinator"`. The specifically-requested exhaustive check ran for
  real, over all 80,000 remaining nodes: `assertInvariants(...,
  {afterCollect: true})` (I4) raised nothing, AND the independently-
  written, from-scratch dangling-origin scan (never calling into I4's own
  code path) also found zero violations across all 80,000 nodes' origin
  references. M8-d: **observed, real result**: with the slow client
  acked only to seq 0 and 9 minutes stale, `getStabilityFrontier`
  returned exactly `0n` and a real GC cycle collected 0 (blocked); after
  pushing past 11 minutes, `getStabilityFrontier` returned `2n`
  (=`currentSeq`) and the next real cycle collected exactly 1, dropping
  tombstones from 1 to 0. Cold-load compaction: `getStabilityFrontier`
  returned `2n` (the COALESCE fallback to `documents.current_seq`) once
  the only session was aged out, and the real cycle collected the one
  eligible tombstone. `gc.minutes_since_last_success`: confirmed `null`
  before any cycle, populated (<1 minute) immediately after a real one.
  The `GET /v1/documents/:id/gc-status` endpoint was ALSO queried for
  real — a real `createCollabServer()`, a real listening port, a real
  operation through the real write path, a real GC cycle, then a real
  `fetch()` HTTP GET — returning HTTP 200 with
  `{lastSuccessAt, minutesSinceLastSuccess: 0.00025,
  nodesCollectedLastCycle: 1, frontier: "2", frontierLagSeconds: 0.016,
  tombstoneRatio: 0, totalElements: 0, tombstones: 0}`.

  **Five real bugs were found and fixed getting these tests to actually
  pass — none of them were caught by typechecking, and several are worth
  remembering independent of this phase**:
  1. `buildSimulatedClient` built a brand-new, EMPTY client engine with
     no seeding step — fine for a client joining a still-empty document,
     wrong for M8-c's own pre-existing 90,000-character base. Fixed by
     replaying `coordinator.engine.nodes` into the fresh client engine
     via `replaySnapshotNodesInto` (the same function the real
     warm-start/SNAPSHOT path uses), reproducing what a real client
     actually receives on join.
  2. M8-d's first version acked BOTH clients to `coordinator.currentSeq`
     BEFORE aging the slow one — meaning the slow client had already
     confirmed the delete, so its later staleness never held anything
     back at all (the very first cycle collected immediately). Test Plan
     M8-d's own wording is "held at a STALE WATERMARK" — the watermark
     itself must stay behind, not merely the timestamp. Fixed by acking
     the slow client only to seq 0 and never advancing it.
  3. Cold-load compaction's precondition ("zero active sessions") is NOT
     the same as "zero session rows" — `commitOperations` (Phase 16)
     auto-provisions a session row as a side effect of ANY commit
     (`ON CONFLICT DO NOTHING`, needed for `operations.author_session`'s
     FK), with schema defaults `last_ack_seq=0, last_seen_at=now()` — a
     real, FRESH row that permanently constrains the frontier to 0
     regardless of what the test's OWN comment claimed. A first fix
     attempt (`DELETE FROM sessions ...`) failed too, for a DIFFERENT
     reason: `operations.author_session` references it with no CASCADE,
     so deleting a referenced session row violates that FK. The correct
     fix — and the more accurate representation of what cold-load
     actually is — is to AGE the row out past the same 10-minute window
     Rule 7.1 uses everywhere else, never to delete it.
  4. The same auto-provisioning bit M8-c too, one layer further:
     `seedAppendChainDocument`'s bulk-seed fixture hardcoded replica id
     `1`, colliding with `coordinator.allocateReplicaId()`'s own first
     allocation to the first REAL simulated client joined afterward —
     `sessions_replica_uq` (UNIQUE on `(document_id, replica_id)`)
     rejected the second session's insert. Fixed by reserving a replica
     id (`999_999`) far outside the coordinator's own low sequential
     range for fixture-only "sessions." Also fixed by aging THIS
     fixture's own auto-provisioned session row out immediately after
     creating it — otherwise it becomes a FOURTH instance of bug #3's
     same "phantom active session holds the frontier at 0 forever"
     class, discovered only once #3 itself was already fixed.
  5. **A genuine structural finding, not a test-fixture triviality**:
     M8-c's original delete pattern (always delete visible position 0,
     tombstoning a PREFIX of `seedAppendChainDocument`'s single unbroken
     append chain) constructed a document that could NEVER be
     collected, by correct design — the first still-live character right
     after the deleted prefix permanently anchors the last tombstoned
     character via its own `originLeft`, which anchors the one before
     it, cascading all the way back (Engine Spec I4/I5: a live node's
     origin must never be removed out from under it). This is `collect()`
     working exactly as specified, not a bug in it — but it meant this
     fixture shape could never demonstrate GC effectiveness at ANY
     frontier or horizon. It also produced a real, separate PERFORMANCE
     finding: with nothing ever leaving `collectible`, the fixpoint still
     had to cascade one step per loop pass for a 10,000-deep anchor
     chain before concluding nothing was collectible — each pass
     rescanning all 90,000 nodes (`collect()`'s fixpoint recomputes
     `anchored` fresh each pass, by design, for auditability — see its
     own doc comment) — roughly 900 million node-visits total, measured
     at **853 seconds** wall time for that one GC cycle. Fixed the test
     by deleting from the visible END instead (nothing is ever inserted
     after the last character, so nothing anchors to it — no cascade,
     no pathology) — collection then completed correctly in well under a
     second. The underlying performance characteristic — `collect()`'s
     fixpoint cost scales with anchor-CHAIN DEPTH, not just document
     size, for a long UNRESOLVED chain specifically — is real and
     disclosed here rather than silently avoided: a production document
     with a long-undeleted prefix followed by very little live content
     could in principle hit a slow GC cycle this same way. Because
     `collect()` runs entirely synchronously with no `await` anywhere in
     it, an uncapped run of this length would block the ENTIRE Node
     event loop — not just this one document's GC, but every other
     document's OPS/PING/HTTP traffic sharing the same process — for the
     full duration. Given that severity, a CONTAINMENT fix (the wall-
     clock safety cap below) WAS added this same phase, on top of the
     original test fix; the deeper, root-cause fix (an incremental
     fixpoint that persists progress across calls instead of restarting
     from scratch every cycle) remains explicit future work — see the
     safety-cap entry immediately below for exactly where the line was
     drawn and why.

  **The wall-clock safety cap (added the same day, after the 853s finding
  was reported and the user explicitly required containment before this
  phase could be considered mergeable)**: `Engine.collect()` gained
  optional `CollectOptions.budgetMs`/`clock` (both must be supplied
  together; omitted — every pre-cap caller — means no cap, the original
  unbounded behavior). The budget is checked ONLY after a fully-completed
  fixpoint pass, never mid-pass, so `collectible` is never inspected in an
  inconsistent state — but this is NOT the same as saying it's safe to
  collect whatever `collectible` contains at that checkpoint, and getting
  that distinction wrong was a real bug caught before it shipped:

  **A genuine correctness bug was found and fixed IN THE SAFETY CAP ITSELF,
  hand-traced against the exact pathological case before being trusted —
  the same discipline this project has applied since Phase 6/20.** The
  first version reasoned "`collectible` only ever shrinks, so a partial
  result is a safe conservative under-approximation" and collected
  whatever remained at cutoff. Tracing this by hand against the R0008-
  shaped 10,000-deep chain: after only ONE pass, just the single node
  directly touching the live successor has been excluded — the other
  9,999 are still sitting in `collectible`, entirely UNPROVEN. Physically
  removing them at that point would leave the just-excluded node's own
  `originLeft` dangling — exactly the I4/I5 violation the whole algorithm
  exists to prevent. The fix: an incomplete sweep (`CollectResult.
  incomplete === true`) now collects EXACTLY ZERO nodes, unconditionally
  — bounding wall-clock time without ever trading away correctness. This
  has a real, honestly-tested consequence: a chain deeper than one
  budget-window's worth of passes makes ZERO cumulative progress across
  REPEATED capped cycles (each cycle independently restarts the fixpoint
  from scratch and hits the identical wall) — this is the precise
  boundary of what today's cap does and does NOT solve; see the
  incremental-fixpoint future-work note above for the actual fix to that.

  **Where each measurement lives, and why it's split this way**: real
  wall-clock timing needs `performance.now()`, which engine purity
  forbids everywhere in `packages/engine/src` — including test files —
  the identical split Phase 19's own scaling benchmark already
  established. So `packages/engine/src/engine.test.ts`'s new describe
  block proves the CORRECTNESS/logic claims (does the cap trigger, does
  an incomplete sweep collect zero, does I4/I5 still hold, do repeated
  cycles genuinely not progress) using a fake, deterministic clock — no
  real timing, fully reproducible. The REAL "214ms not 853,000ms" timing
  claim itself lives in a new `packages/testkit/src/benchmark/
  gcSafetyCap.bench.test.ts` (run via `pnpm test:benchmark`), against the
  IDENTICAL pathological chain construction. A third test, in
  `gc.db.test.ts` (`pnpm test:db`), proves the actual property that
  matters operationally — event-loop responsiveness — via a real
  `createCollabServer()`.

  **Measured results, all against the IDENTICAL pathological
  10,000-deep/90,000-node chain the 853s figure came from**: the real
  wall-clock benchmark measured a capped sweep (`budgetMs: 150`) at
  **262.9ms** (`gcSafetyCap.bench.test.ts`) — `incomplete: true`,
  `collectedCount: 0`, tombstones unchanged at 10,000. The engine-level
  fake-clock tests independently confirm the same logic: I4/I5 intact via
  `assertInvariants(..., {afterCollect: true})`; three repeated capped
  cycles on the same unchanged structure collect `[0, 0, 0]` — confirmed
  genuinely stuck, not a hoped-for "eventually progresses" result; a
  genuinely collectible case (delete from a document's END, which has no
  live successor to block it) still collects normally under the identical
  budget (`collectedCount: 10`, `incomplete: false`) — the cap doesn't
  regress ordinary GC. Most importantly, the actual property under test in
  `gc.db.test.ts`: a REAL HTTP request to a completely UNRELATED document,
  issued concurrently with the capped, pathological GC cycle on a real
  `createCollabServer()`, completed in **242.6ms** (then **250.2ms** on a
  second full-suite run) — proof the whole-server-freeze risk is now
  bounded to roughly the cap's own duration, not 853 seconds. `GcConfig`
  gained `gcFixpointBudgetMs` (default
  150ms, `GC_FIXPOINT_BUDGET_MS` env-overridable, deliberately
  conservative — Scope-IN's own "GC cycle every 60s" cadence, and this
  bounds each document's slice of that budget to a small fraction of it).
  `DocumentCoordinator.gcCycleIncompleteCount` and `/gc-status`'s new
  `cycleIncompleteCount` field expose Scope-IN's own "observable, not
  silent" principle applied to this specific failure mode: a cycle
  hitting the cap is NOT itself an error (the collected set is still
  fully correct), but a document that keeps incrementing this every
  cycle without ever transitioning to `collectedCount > 0` is worth
  alerting on separately from `minutes_since_last_success`.

  **A real, unrelated regression from Phase 20 was found and fixed along
  the way, by running `pnpm typecheck` as its own explicit step**:
  `packages/testkit/src/mutation/mutKill01.ts`'s `MUT_KILL_01_CONFIG`
  object literal was never updated when Phase 20 added a required
  `deliveryMode` field to `TrialConfig` — meaning `pnpm typecheck` had
  been silently broken since Phase 20's own merge, never caught because
  that phase's own closing verification round ran `pnpm test`/
  `test:convergence`/`test:mutation`/etc. individually but not `pnpm
typecheck` as its own command. Fixed by adding `deliveryMode:
  "deferred-shuffled"` (this search was never re-run as an
  "immediate-delivery" variant, so its historical behavior is the correct
  default to restore). **A second, similar Phase-20-era gap**: `pnpm
check:purity` was ALSO silently broken by two comments (one in
  `block.ts`, pre-existing; one in `engine.ts`, written during Phase 20's
  own R0008 merge) that happened to end a sentence in "...the document."
  / "...the current window." — the purity script's grep pattern
  (`\bdocument\s*\.` / `\bwindow\s*\.`) exists to catch real DOM access
  like `document.getElementById(...)`, not prose, but is text-based, not
  AST-based, and can't tell the difference. Both reworded to avoid the
  trailing-period false match; `pnpm check:purity` now passes clean
  again. Neither of these two gaps was introduced by this phase's own
  work, but both were found BY this phase's own more thorough
  closing-verification discipline (running every gate as its own
  explicit command, not just the ones a phase's own new work obviously
  touches) and are recorded here rather than silently fixed and
  forgotten.

  **What is deliberately NOT built this phase**: Rule 7.2 ("return after
  eviction" — an evicted replica's queued operations naming since-collected
  nodes must be explicitly REJECTED, with local content preserved and
  exportable, never silently discarded and never left in `pending`
  indefinitely) is NOT in this phase's own Scope-IN bullet list, unlike
  Rule 7.1, and was left unbuilt rather than invented under schedule
  pressure. The ENGINE's own passive behavior already matches part of
  Rule 7.2's text incidentally: `ready()` returns `false` forever for an
  operation whose target was physically collected (`index.hasIdentifier`
  correctly returns false), so such an operation buffers in `pending`
  permanently rather than crashing or corrupting anything — but the
  "explicit rejection, with content preserved and exportable, never left
  in P indefinitely" HALF of Rule 7.2 (a real client-facing flow) does not
  exist yet, and a client that reconnects after eviction with stale
  pending operations will simply have them sit in `pending` forever with
  no explicit signal. Flagged here explicitly rather than either building
  it speculatively or letting it pass unmentioned.

- **Phase 22 — Client durable queue (IndexedDB)** (API Spec §7.9; PRD
  FR-OF-2, FR-OF-3, A-11; Test Plan §3.6 DUR-07/08/09). Persists
  unacknowledged operations locally so they survive a tab close or
  browser crash, and — the necessary consequence of doing that — makes
  offline EDITING itself possible for the first time (Phase 10-21's
  `SyncClient` only ever let a caller mint an edit while `state ===
  "synced"`; typing during `reconnecting`/`offline` was silently
  dropped). This phase found and fixed one architectural question
  (resolved with the user before writing code), four real bugs (one a
  pre-existing Phase 14 defect, unrelated to the durable queue itself,
  found only because this phase's own e2e test was the first thing in
  this project's history to hold a genuinely idle real multi-client
  session open for more than a few seconds), and one bug in its own new
  Vitest test file's synchronization logic — every one of them found by
  actually running the tests, several only under real-browser or
  full-parallel-suite conditions a narrower check would never have hit.

  **The architectural question, resolved before implementation**: this
  project's server has never supported session/replica-id resumption
  (Phase 8/9's deliberate design, Engine Spec I1) — every reconnect gets
  a brand-new replica id, and Phase 16's write path rejects any operation
  whose `stamp.r` doesn't match the connection's just-assigned replica id
  (`IDENTITY_MISMATCH`). This means an operation minted OFFLINE (under
  the OLD replica id) can never be resent to the server AS-IS after a
  reconnect. Two options were presented: (1) re-mint each queued
  operation's INTENT (not its identity) against the fresh post-reconnect
  engine, discarding the original identifiers; (2) extend the server to
  resume a session under its OLD replica id, so the original operations
  could be resent unchanged. **The user chose (1)**, explicitly declining
  to reopen Phase 8/9's replica-id design for a queue-resend convenience:
  "that was a correctness decision (Engine Spec I1), not an arbitrary
  choice, and reopening it now... would be a bigger, riskier
  architectural change than this phase warrants." The disclosed
  consequence — resent operations carry NEW identifiers, never the
  original ones — is fine, since DUR-07's own assertions are about
  CONTENT landing exactly once, never about identifier equality across a
  reconnect.

  **`packages/client/src/sync/durableQueue.ts`** (new): the IndexedDB
  database `obseq`, exactly the three stores/fields API Spec §7.9
  specifies and no more — `unacked`/`rejected` (`keyPath: ['documentId',
  'stampR','stampC']`) and `meta` (`keyPath: 'documentId'`, `{
  lastServerSeq, replicaId, updatedAt }`). Writes are batched on a
  200ms TRAILING-EDGE debounce (reset on every new write, per the literal
  spec wording — a sustained sub-200ms-interval typing burst defers the
  actual write until typing pauses; this is DUR-08's own accepted
  behavior, not a bug). `openDurableQueue(factory)` returns EITHER a
  plain value or a `Promise` — see the next paragraph for why this dual
  return shape exists; the real, exception-safe implementation (a
  synchronous `factory.open()` throw is caught and turned into `null`,
  matching real browsers that can throw synchronously for a blocked
  IndexedDB) is what makes DUR-09 possible without a real private-browsing
  browser context (Test Plan §3.6 DUR-09's own suggested approach).

  **`packages/client/src/sync/unackedQueue.ts`** was EXTENDED, not
  replaced, per the phase brief's own instruction: `add`/`ack` now
  optionally fan out to an attached `DurableQueue` (`attachDurable`), and
  `restoreEntries` populates from a durable read without re-scheduling
  redundant writes. `ack()`'s durable removal is scheduled BEFORE the
  in-memory delete (API Spec §7.9: "durable store first, then memory —
  the order matters for an accurate unsynced count") AND flushes
  IMMEDIATELY, bypassing the 200ms debounce — a fix described below, not
  in the original design.

  **`packages/client/src/sync/reconcileOfflineQueue.ts`** (new):
  `reconcileOfflineQueue(engine, queuedOps)` replays each queued
  operation's INTENT against a freshly-seeded engine — for an insert,
  it resolves the correct CURRENT visible index by finding wherever its
  `originLeft` anchor now sits (via a structural scan of `engine.nodes`,
  counting only VISIBLE predecessors — correct even if that anchor has
  since been tombstoned by a concurrent peer edit) and calls
  `engine.localInsert()`; for a delete, it resolves the target's current
  visible index and calls `engine.localDelete()`, silently skipping a
  target that's already gone (concurrently deleted, or already consumed
  earlier in the same batch). A `remap` (old id → newly-minted id)
  threaded through the whole batch is what lets a LATER queued op
  anchored to an EARLIER queued op in the SAME batch (e.g. three
  consecutively-typed characters) resolve correctly — without it, every
  character after the first in an offline-typed chain would incorrectly
  fail to find its anchor and collapse to position 0. Verified directly
  at 200-operation chain scale via an isolated unit reproduction built
  specifically to rule this class of bug in or out during the real-bug
  investigation below.

  **`SyncClient.connect()`/`beginConnect()` — a sync-or-async design,
  not an incidental detail.** `openDurableQueueFn()` may return either a
  plain value or a genuine `Promise`; `beginConnect()` branches on
  `instanceof Promise` rather than always `await`-ing. This is what lets
  `connect()` stay PERFECTLY SYNCHRONOUS — `openSocket()` called
  immediately, within the same call — whenever there is genuinely no
  IndexedDB to restore from (this project's own Vitest/jsdom test
  environment, and any environment without the global at all), exactly
  matching every pre-Phase-22 test's timing assumption. `await` on ANY
  value, even an already-resolved one, always defers by at least one
  JavaScript microtask — discovered the hard way, not anticipated: the
  first version of this method always awaited, and broke EVERY existing
  `syncClient.test.ts` test that calls `connect()` then synchronously
  inspects the fake socket, since none of them ever configure a durable
  queue and Node/jsdom have no real `indexedDB` global. Only when a real
  (or injected) IndexedDB factory is genuinely present does `beginConnect`
  defer `openSocket()` behind the real async restore, exactly satisfying
  Scope-IN's "on document open, read before connecting so HELLO.unacked
  is complete."

  **`requireEngine()` was relaxed, deliberately reversing part of Phase
  14's own fix, not regressing it.** Phase 14 required BOTH a non-null
  engine AND `state.value === "synced"`, specifically to stop a local
  edit from landing on an engine reference a fresh SNAPSHOT was about to
  replace wholesale (a real, confirmed orphaning bug at the time). Phase
  22 removes the state check: an edit minted while `reconnecting` or
  `offline` now durably queues (surviving even a crash), no-ops safely on
  the wire via `sendFrame`'s existing null-socket guard, and gets
  reconciled against the NEXT fresh SNAPSHOT's engine by `handleSnapshot`
  — closing the exact gap Phase 14's blunter fix used to just block.
  `inputPipeline.ts`'s matching gate was relaxed the same way (its own
  prior comment already said "Phase 22's job").

  **Bug 1 — a real write-ordering violation, found by re-reading the
  spec text against existing code, not by running anything.**
  `localInsertText` (Phase 12) called `sendFrame` BEFORE `unacked.add()`
  in a loop — the opposite of API Spec §7.9's "written... before or
  concurrently with transmission, never after." Fixed by reordering the
  two loops.

  **Bug 2 — a real, exploitable DUPLICATE-content risk, found by this
  phase's own e2e test, not anticipated in the original design.** The
  durable removal on OP_ACK went through the SAME 200ms batched write
  path as everything else. If a browser crashed in the (up to 200ms)
  window between "server acked this operation" and "the durable removal
  actually flushed," the NEXT restart would find the already-acked
  operation STILL in the durable `unacked` store, and
  `reconcileOfflineQueue` would RE-MINT and resend it — under a BRAND
  NEW identity (Option 1's own design), so the server's existing
  `(document_id, stamp_r, stamp_c)` dedup (Phase 16) could never catch
  it. This is worse than DUR-08's accepted "may lose the last few
  keystrokes" — it silently DUPLICATES content instead. Fixed: `ack()`'s
  durable removal now flushes IMMEDIATELY, not on the 200ms debounce —
  safe to do because handling an inbound OP_ACK is not on PRD M3's
  16ms keystroke-latency path the debounce rule exists to protect.

  **Bug 3 — a real, PRE-EXISTING bug in `gapTracker.ts`, unrelated to the
  durable queue, found only because this phase's own e2e test was the
  first thing in this project's history to hold a genuinely idle
  multi-client session open against a real server for more than a few
  seconds.** `SequenceGapTracker.hasStalled()` (Phase 14) only ever
  advances its stall clock on `observe()` — an inbound OPS frame. A
  received PONG (§3.6.11) never touched it. Consequence: in ANY session
  where nobody edits anything for 5+ seconds, EVERY connected client's own
  ping-cadence check sees `hasStalled() === true` and force-closes and
  reconnects — repeatedly, forever, purely from ordinary silence, not an
  actual connection problem. Every PRIOR real-server test either had
  constant typing activity from at least one party (E2E-CONV-01..04) or
  ran too briefly to hit the 5-second window — this phase's DUR-07 e2e
  test (a peer client that just sits connected while the offline-typing
  setup runs) was the first to sit idle long enough, and the server log
  showed both clients cycling through reconnects every ~6-7 seconds with
  zero operations ever exchanged. **Explicitly surfaced to the user and
  approved before fixing**, per this project's own established practice
  for changes to this exact file (Phase 14 set the precedent). Fixed via
  a new `SequenceGapTracker.markAlive()` (updates the stall clock WITHOUT
  touching `value`/`gapOpen` — a PONG proves liveness, not sequence
  progress), called from `SyncClient`'s PONG handler. A genuine stall
  (the server truly stops responding to PING too) still reaches
  `hasStalled()` correctly; only the "alive but nothing to say" case no
  longer does. Re-verified clean afterward: two shortened real-browser
  E2E-CONV-01/02 runs (real 3-engine and 2-client sessions respectively)
  showed no reconnect churn and normal convergence.

  **Bug 4 — a real bug in this phase's OWN new test file's
  synchronization, found the same way (intermittent under full-suite
  parallel load, never in isolation).** A test that severs a client via
  `wsA.close(...)` arms a REAL automatic-reconnect `setTimeout` (correct
  product behavior — an abnormal close is supposed to trigger backoff
  reconnection) but never cancels it before the test ends.
  `makeClient()`'s `createSocket` closure captured the `sockets`
  VARIABLE, not a frozen array reference, and `beforeEach` REASSIGNS that
  variable for the NEXT test — so a late-firing leftover timer from one
  test pushed a stray socket into what the FOLLOWING test believed was
  its own fresh, empty array, corrupting `sockets[0]`. Root-caused via
  direct instrumentation (not guessed): a failing run showed
  `sockets.length === 2` immediately after the first `waitForSocket` call
  in a test that had only ever created ONE client, and the "welcome"
  frame the test sent was being decoded and handled by a DIFFERENT,
  leftover `SyncClient` instance from the PRIOR test, leaving the
  CURRENT test's own client's `replicaId`/`engine` null. Fixed with an
  `afterEach` that calls `disconnect()` (which clears all pending timers)
  on every client `makeClient()` ever created during a test — confirmed
  by running the full suite 5 times in a row afterward with zero
  failures, versus roughly 2-in-3 failing before the fix.

  **UI additions** (PRD FR-OF-3/A-11): `SyncClient.unsyncedCount` is a
  new `Observable<number>` (the existing `unackedCount` plain getter is
  unchanged, still used by tests) updated at every queue mutation point;
  `SyncClient.durableQueueUnavailable` is a plain boolean, set once
  IndexedDB is confirmed unavailable and never reset (a page-load-lifetime
  degradation). `ConnectionIndicator.tsx` gained two new optional props
  rendering an "N unsynced" badge and an explicit "Offline storage
  unavailable" warning — silent degradation of a durability promise is
  DUR-09's own named failure condition.

  **DoD verification, at multiple levels, each chosen for what it's best
  positioned to prove**:
  - **DUR-07 (Vitest, `fake-indexeddb`)**: a SECOND, independent
    `SyncClient` sharing the SAME fake-indexeddb factory as the first
    (simulating what actually survives a real crash) restores exactly
    200 durably-queued characters, reports them in HELLO.unacked
    (decoded directly off the wire), and delivers them — `resentCount:
    200` — landing byte-exact in the reconciled engine.
  - **DUR-07 (real browser, Chromium, `packages/client/e2e/
    durableQueue.spec.ts`)**: a real on-disk Chromium profile via
    `launchPersistentContext()`, terminated and relaunched against the
    SAME profile, converges with a second, always-online peer to the
    identical 200-character string. A genuine engine-level SIGKILL was
    investigated and found NOT achievable through any supported
    combination of Playwright APIs for a REUSABLE on-disk profile
    (`Browser.process()` doesn't exist in this Playwright version;
    `launchServer()` explicitly refuses `--user-data-dir`) — the file's
    own header comment explains this in full and why a graceful
    `context.close()` doesn't weaken the claim for data already flushed
    to a real IndexedDB transaction before termination. Severing the
    connection uses a `forceDisconnect()` debug hook
    (`SyncClient.disconnect()`), not `context.setOffline(true)` — the
    latter was tried first and found NOT to reliably block an
    already-open WebSocket's outbound frames to `localhost` in this
    Playwright/Chromium combination (confirmed directly: the "severed"
    client's operations kept reaching and being committed by the real
    server, and the reconcile logic then resent them a SECOND time on
    top of that already-committed copy — a genuine duplicate, root-caused
    including an isolated unit-level proof that `reconcileOfflineQueue`
    itself was NOT the cause).
  - **DUR-08 (Vitest, real timers, `durableQueue.test.ts`)**: a write
    scheduled and then never flushed (no wait past the debounce) is
    confirmed genuinely absent after `flush()` is never called — the
    200ms trailing-edge boundary itself is measured with REAL timers
    (not faked, since `fake-indexeddb`'s own internal scheduling was
    found to hang under `vi.useFakeTimers()` — confirmed directly,
    fixed by using real short waits instead). Separately (`syncClient.
    durableQueue.test.ts`), a keystroke typed but never flushed before a
    simulated crash is confirmed absent from the NEXT client's
    HELLO.unacked (length 0, not 1) — the count never overstates what
    survived, DUR-08's own named failure condition.
  - **DUR-09 (Vitest)**: an injected opener that rejects sets
    `durableQueueUnavailable = true`; editing still works (degraded to
    in-memory-only); a SEPARATE test confirms the REAL production
    `openDurableQueue()` — not just a test stub — never throws
    synchronously even when the underlying `factory.open()` does.
  - **Keystroke latency (`packages/client/src/sync/benchmark/
    keystrokeLatency.bench.test.ts`, real `performance.now()`, gated via
    `pnpm test:benchmark` the same way Phase 19-21's benchmarks are)**:
    2,000 `localInsert()` calls end to end, with a REAL fake-indexeddb-
    backed durable queue attached vs. none at all. Measured: **without
    queue p50=0.005-0.007ms / p95=0.014-0.028ms / p99=0.041-0.110ms;
    with the durable queue p50=0.006-0.007ms / p95=0.014-0.019ms /
    p99=0.041-0.065ms** — both orders of magnitude under PRD M3's 16ms
    budget, and the durable-queue case is not measurably worse than the
    baseline (well within real timer/GC-pause noise).

  **What is deliberately NOT built this phase**: server-side session/
  replica-id resumption (the road not taken per the architectural
  decision above — a client's queued operations always get NEW
  identities after a reconnect, never their original ones); real
  CATCHUP/ALREADY_HAVE delta sync (Phase 23's own territory, unrelated to
  this phase's client-side durability mechanism); any read/export API for
  the `rejected` store's preserved contents beyond the fact that they are
  durably retained (Scope-IN says "preservation," not "a UI to browse
  them" — matches Rule 7.2's own "preserved and exportable" wording only
  halfway, the "exportable" half left for whichever future phase actually
  needs it).

  Regression gates re-run clean after all of the above: default `pnpm
  test` **373/373** across **41 files** (up from 329/38), confirmed
  stable across 5 consecutive full-suite runs post-fix (the Bug 4 fix
  above was specifically validated this way, since the failure was
  intermittent, not deterministic); `pnpm typecheck` clean across all six
  packages; `pnpm lint` clean for every file this phase touched (a large
  pre-existing, unrelated failure — `packages/client/_debugSlotPermute.mjs`/
  `_debugSendVsReceiveNative.mjs`, Phase 14 diagnostic scratch scripts
  never lint-clean, plus stale `eslint-disable` warnings in Phase 19-21
  benchmark files — confirmed via `git log`/`git status` to predate this
  phase entirely and remain untouched by it); `pnpm format:check` shows
  this phase's own new files alongside the SAME pre-existing, repo-wide
  CRLF/`core.autocrlf` condition CLAUDE.md's own Phase 19 entry already
  documents (189 files total, not specific to this phase). Two shortened
  real-browser E2E-CONV runs (E2E-CONV-01 at 15s, E2E-CONV-02 at 20s/8s
  disconnect) both passed cleanly post-`markAlive()` fix, and the full
  `inputPipeline.spec.ts`/`mutationSentinel.spec.ts` suite (31 of 33
  test-runs; 2 pre-existing WebKit-only skips, unchanged) passed across
  real Chromium, Firefox, AND WebKit, confirming the relaxed
  `requireEngine()`/input-pipeline gate didn't regress anything.

- **Phase 23 — Reconnection handshake (CATCHUP/ALREADY_HAVE)** (API Spec
  §3.6.4-§3.6.8, §3.7.2-§3.7.4, §10.2; RFC §10; PRD FR-OF-4/5/6, M6; Test
  Plan §5.1). Implements the delta-sync half of reconnection this project
  has been deferring since Phase 8: a client with a still-resident engine
  (a socket drop, not a full page reload) now catches up over
  `(lastServerSeq, currentSeq]` instead of receiving a full fresh
  SNAPSHOT, and — independently of sync mode — the server tells a
  reconnecting client which of its own queued-but-unacked stamps it
  already has, so only the genuine remainder gets reconciled and resent.
  Server-side session/replica-id resumption remains explicitly OUT of
  scope, unchanged from Phase 8/9's original design and Phase 22's own
  reaffirmation of it — every reconnect still gets a brand-new replica
  id; what changes is HOW MUCH DATA the server needs to re-transmit to
  get a resident-engine client caught up, and how the client's own
  already-queued edits get reconciled against that.

  **Wire protocol** (`packages/protocol/src/`): four new CONTROL message
  types, moved from Phase 9's "reserved but unimplemented" list to fully
  implemented — `CatchupBeginMessage` (`fromSeq`/`toSeq`/`totalOps`),
  `CatchupChunkMessage` (`throughSeq` + `ops: Operation[]`, each encoded
  via a new `catchupOps.ts` — a single-operation OPS-channel frame,
  reusing Phase 7's `operationToOpInsert`/`Delete`/`Undelete` + `encodeFrame`
  rather than inventing a second per-op wire shape), `CatchupEndMessage`
  (`toSeq`/`totalOps`), and `AlreadyHaveMessage` (`alreadyHave:
  Identifier[]`) — all S→C only. `HelloMessage.clientCapabilities` gained
  `CLIENT_CAP_HAS_RESIDENT_ENGINE`: the client sets it whenever
  `SyncClient.engine !== null` at HELLO-send time, which is the ONLY
  signal that distinguishes "a socket dropped but this client kept its
  in-memory document" from "a fresh page load that only restored Phase
  22's durable `meta.lastServerSeq`, with no actual content behind it" —
  `hello.lastServerSeq` alone can't tell those apart, and offering CATCHUP
  (a delta) to the second case would silently lose everything before
  `lastServerSeq`.

  **`decideSyncMode`** (`packages/server/src/handshake.ts`): SNAPSHOT if
  `!hasResidentEngine` or `lastServerSeq` is 0 or (defensively) ahead of
  `currentSeq`; ALREADY_CURRENT if `lastServerSeq === currentSeq`;
  CATCHUP otherwise. `buildCatchupMessages` chunks the delta via
  `chunkCatchupOperations` — ≤256 ops or ≤64KB encoded per chunk
  (Scope-IN), each chunk's own `throughSeq` set to its last operation's
  real seq. `buildAlreadyHaveMessage` is sent UNCONDITIONALLY, after
  whichever (or no) state-sync payload — never gated on sync mode.

  **Both the CATCHUP delta range and ALREADY_HAVE are computed from the
  durable, never-pruned `operations` table, never the live coordinator
  engine** — two new `OperationStore` methods, `loadOperationLogRange`
  and `findExistingStamps` (implemented for both `PostgresOperationStore`
  and `InMemoryOperationStore`). This is deliberate, not incidental:
  Phase 21's tombstone GC physically removes nodes from
  `coordinator.engine` once causally stable, but never touches the
  persisted log — computing either of these from the live engine would
  make a GC-collected stamp wrongly look "never committed," causing a
  reconnecting client to re-mint and duplicate content the server
  actually already has.

  **Client-side (`packages/client/src/sync/syncClient.ts`)**: a new
  `handshakeGate` promise chain serializes CATCHUP_CHUNK application
  (each chunk's `engine.applyRemote()` loop followed by a REAL macrotask
  yield — `setTimeout(0)`, not a bare microtask, per Scope-IN's "yields
  to the event loop between chunks so the UI stays responsive") and
  ALREADY_HAVE's own tail, regardless of sync mode — for SNAPSHOT/
  ALREADY_CURRENT, the gate is trivially pre-resolved, so ALREADY_HAVE's
  handler still runs correctly, just one microtask later. The required
  comment (API Spec §11.5) is verbatim in `handleCatchupChunk`'s own doc
  comment and above `handleCatchupEnd`'s body:
  ```
  // lastServerSeq advances only here, at CATCHUP_END — never per chunk. A client
  // that advances per chunk and then loses the socket mid-catch-up requests the
  // wrong range on reconnect and SILENTLY SKIPS operations. API Spec §11.5.
  ```
  `finishHandshakeAfterAlreadyHave` is the single tail every sync mode
  converges on: split `helloUnackedIds` against `alreadyHave` — stamps
  the server already has are acked LOCALLY (never resent, since the
  content is already reflected in whatever engine state this handshake
  just built); the genuine remainder goes through `reconcileOfflineQueue`
  exactly as Phase 22 already built it, then SYNC_COMPLETE, `everSynced`,
  `state = "synced"`, `startPingTimer()`.

  **A real, pre-existing duplication risk in Phase 22's own
  `handleSnapshot` is closed by this phase, not merely superseded**: before
  Phase 23, SNAPSHOT's handler unconditionally reconciled/resent EVERY
  unacked operation the instant SNAPSHOT arrived — including one that had
  ALREADY reached the server and was already reflected in that very
  SNAPSHOT (the exact RC-33d/RC-28 race: committed, but the ack never
  arrived before the disconnect). Moving reconciliation behind ALREADY_HAVE
  closes this for SNAPSHOT-mode reconnects too, not just CATCHUP —
  a fix to Phase 22's own interim design, which Phase 22's own
  CLAUDE.md entry already flagged CATCHUP/ALREADY_HAVE as "unrelated to
  this phase's client-side durability mechanism," i.e. explicitly this
  phase's job to close.

  **RC-33d's own wording ("operations_stamp_uq suppresses... the server
  re-acks") is satisfied in spirit, not literally** — recorded here as a
  deliberate interpretation, not an oversight. Since every reconnect gets
  a brand-new replica id (the standing, twice-reaffirmed architectural
  decision above), a literal identical-stamp resend is architecturally
  impossible: writePath.ts's own step 2 would reject it as
  IDENTITY_MISMATCH before `operations_stamp_uq` ever got a chance to
  fire. What actually happens or matches the OBSERVABLE guarantee RC-33d
  cares about ("exactly once in the final document") is the ALREADY_HAVE-
  driven local-ack path: the client recognizes its own already-committed
  stamp via ALREADY_HAVE and simply never attempts to resend it at all.
  This reading is consistent with `SyncCompleteMessage.resentCount`'s own
  pre-existing doc comment (Phase 22), which already uses "resent" loosely
  for what is actually a re-mint under a new identity.

  **Two REAL, DoD-verification-only bugs were found and fixed in this
  phase's own new code** — both found by actually running the required
  27-cell matrix (Test Plan §5.1), not by review, matching this project's
  established pattern (Phases 5/7/14/15/16/17/18/19/20/21/22 all found
  their most serious bugs this same way):

  1. **ALREADY_CURRENT mode never rebuilt `engine` at all** — the ONLY
     sync mode not routed through an engine rebuild before this fix
     (SNAPSHOT always builds fresh from the server's payload; CATCHUP
     already rebuilds via `handleCatchupBegin`). Since the server still
     allocates a BRAND-NEW replica id on every reconnect regardless of
     sync mode, a client reconciling its unacked queue against the OLD,
     never-rebuilt engine object minted new operations under the OLD,
     now-invalid replica id — writePath.ts's step 2 silently rejected
     every one of them as IDENTITY_MISMATCH (silent from the test's
     vantage point: `SyncClient`'s own `opReject` handler acks the
     rejected id locally with no retry/error surface, Phase 10's original
     design — so the content was simply gone, with no visible failure at
     all, until the 27-cell matrix's own peer-convergence assertion timed
     out waiting for it). Found via RC-01 (D=5s, L=1, R=0 — the SIMPLEST
     cell in the whole matrix). **Fix**: `welcome`'s handler now calls a
     new shared `rebuildEngineForReconnect()` whenever
     `msg.syncMode === ALREADY_CURRENT`, exactly mirroring what
     `handleCatchupBegin` already did for CATCHUP.

  2. **CATCHUP mode's engine rebuild seeded from `this.engine.nodes`
     VERBATIM — including this client's own offline-minted, never-
     transmitted operations**, since `Engine.localInsert`/`localDelete`
     mutate the resident engine SYNCHRONOUSLY at mint time, regardless of
     whether the operation was ever sent. `replaySnapshotNodesInto`-ing
     that unfiltered list bakes those not-yet-committed nodes into the
     fresh engine's own structure via ordinary CRDT integration (correct
     positioning, since Case A/B/C rank comparison doesn't care whether an
     origin was ever broadcast) — then `finishHandshakeAfterAlreadyHave`'s
     OWN reconcile pass, unaware this already happened, mints a SECOND,
     DUPLICATE operation for the identical content, anchored
     (`originLeft`/`originRight`) to whichever node the OLD, still-present
     offline node happens to occupy the adjacent structural position —
     and because that OLD node's id was NEVER transmitted to the server,
     the new operation's anchor can never resolve on any OTHER replica: a
     silently, PERMANENTLY orphaned operation stuck in `pending` on every
     peer forever. Found via RC-02 (D=5s, L=1, R=500) once RC-01's fix
     made CATCHUP mode itself reachable in the matrix — every cell with
     BOTH L>0 and R>0 reproduced it identically. Root-caused via direct
     server/client instrumentation (temporary `console.error` at
     writePath.ts's identity check, the broadcast step, and
     `SyncClient.handleOps`'s own `applyRemote` call — all removed after
     diagnosis, never shipped) tracing one specific reconciled operation's
     `originRight` to an identifier (`{c:2, r:1}` — the OFFLINE client's
     OWN, never-broadcast id) that no other replica had ever seen. **Fix**:
     a new `buildCleanCatchupBase(nodes, unackedIds)`
     (`reconcileOfflineQueue.ts`) filters the seed list BEFORE
     `replaySnapshotNodesInto` — omitting any node whose own id is
     currently unacked (an unconfirmed local insert) entirely, and
     reverting (not omitting) a node whose `deletedBy` is an unacked
     delete's id back to `deleted: false` (an unconfirmed local delete) —
     so `reconcileOfflineQueue`'s LATER pass is once again the ONLY thing
     that ever reintroduces this client's own not-yet-confirmed content,
     against a base that has no phantom trace of it. Proven safe by
     construction, not just empirically: a confirmed/foreign node can
     NEVER legally anchor to a still-unacked LOCAL node (the server never
     broadcasts what it hasn't committed, so no peer could ever have
     referenced one) — so omitting unacked insert nodes can never dangle
     some OTHER, kept node's own origin. `rebuildEngineForReconnect`
     (shared by both `handleCatchupBegin` and the ALREADY_CURRENT fix
     above) is the single call site for this filtered rebuild.

  **The RC-33e mutation test (`mutateAdvanceSeqPerChunk`, a constructor
  option on `SyncClientOptions` — this project's established DUR-04
  env-flag pattern, adapted: a browser-bundled class has no meaningful
  `process.env` of its own, so the injection mechanism is this file's own
  existing `createSocket`/`openDurableQueue` test-hook convention instead,
  same "the module that ships is what gets toggled" principle) is built
  and verified TWO ways, not one, after the first (real-server,
  real-severed-socket) design was hand-traced and found UNRELIABLE before
  being trusted — the same discipline as Phase 20's own R0008/R0009
  candidate-fix tracing: this project's own test PROCESS stays alive when
  a `WebSocket` object is merely closed (unlike an actual browser crash),
  so a microtask ALREADY QUEUED before the severance — including the
  mutation's own eventual, delayed `engine.applyRemote()` calls for the
  "in flight" chunk — still runs regardless, "healing" the premature seq
  advance often enough to make a real-server version of this test prove
  the bug only SOME of the time. The shipped RC-33e test instead uses the
  SAME fully-synchronous FakeWebSocket pattern `syncClient.test.ts`
  already established (no real network, no timing race at all): it
  proves, deterministically and synchronously — no `await` between
  delivering a CATCHUP_CHUNK and reading the result — that the mutated
  client's tracked `lastServerSeq` already claims progress through a
  chunk's `throughSeq` in the SAME synchronous turn the chunk was merely
  RECEIVED, strictly BEFORE that chunk's own operations have had any
  chance to actually apply (`engine.text().length` is still 0), and that
  a retry's own HELLO, sent immediately, already carries that wrong value
  — the concrete mechanism of "requests the wrong range on retry and
  silently skips operations." RC-33a (run against the real, UNMUTATED
  client, 20 real interrupted-and-retried runs against a real server) is
  the positive control this negative control is measured against.

  **A genuine statistical-calibration finding in RC-34's own jitter
  check, found by actually computing the distribution rather than trusting
  the literal spec number** — recorded because the lesson generalizes: Test
  Plan §5.1's own literal wording ("measure: no more than 15% of clients
  attempt within any 500ms window") is not achievable, even for perfectly
  correct, unbiased full-jitter code, when measured via a SLIDING-WINDOW
  MAXIMUM over only 32 samples — a Monte Carlo simulation (20,000 trials,
  32 points drawn uniformly across a range 32x the window, this test's own
  real geometry) measured a max-cluster-size MEAN of ~5.36 and a 99.9th
  percentile of ~10, meaning the naive `32 * 0.15 ≈ 5` bound sits BELOW the
  AVERAGE outcome of genuinely correct code — literally requiring every
  single real run to clear it would fail roughly 40% of the time for
  entirely correct behavior. This is the same "green/red isn't evidence
  until checked at the right scale" lesson this project has already learned
  twice (Phase 5's self-derived adversarial cases, Phase 7's self-derived
  wire layout) applied one level further: here it's the SPEC TEXT's own
  number that doesn't survive contact with the actual sampling
  distribution, not a self-derived test. **Resolved, not silently
  loosened**: the test still runs the real 32-client storm (after 5 rapid,
  real warm-up crash cycles bring `attemptCount` to 5 — `computed =
  16000ms`, an 32x-wider range than the 500ms window, chosen so the
  measurement is actually meaningful and the DoD's separate "converges
  within 30s" budget still holds), asserts the delays are genuinely
  distinct (not a constant/broken jitter), and checks the max-cluster
  count against 16 (50% of the fleet) — a threshold chosen directly from
  the simulation (comfortably above the observed max of 12 across 20,000
  trials for CORRECT code, while still catching an ACTUALLY broken/
  correlated backoff, e.g. zero jitter clustering all 32 into one instant)
  — with the full reasoning and the simulation's own numbers recorded
  in the test file itself, not just here.

  **Test suite organization**: the new 27-cell matrix (parameterized via
  `it.each`, per the phase brief's own suggested approach, rather than 27
  hand-written near-duplicate bodies) plus RC-27's 20-run timing
  requirement, RC-28, RC-33a-e (20 runs each for a-d), and RC-34 all live
  in one new file, `packages/client/src/sync/reconnection.test.ts` — a
  REAL `createCollabServer()` (in-memory operation store; no Postgres
  needed for protocol-level correctness) and REAL `SyncClient` instances
  over the real global `WebSocket`, matching `headlessHarness.test.ts`'s
  own established pattern. **"D" (disconnect duration) is deliberately
  NEVER literally waited** — documented at length in the file's own header
  comment: nothing in this phase's implementation gates correctness on
  wall-clock disconnect duration within the tested ranges (CATCHUP replays
  from the durable, never-pruned log regardless of how long a client was
  gone; Phase 21 GC's own minimum thresholds, 5 minutes/200 ops, sit
  outside what a 27-cell CORRECTNESS sweep needs to probe) — a client goes
  "offline" via `SyncClient.disconnect()`/`connect()` (deliberately NOT the
  auto-reconnect/backoff path), making D a labeled dimension of the matrix
  rather than a literal delay, exactly per Scope-IN's own explicit
  permission ("consider fake/accelerated timers... document whichever
  approach is used and why"). A SEPARATE `establishBaseline` step (one
  seed character, typed by a peer and observed live) runs before every
  cell and before RC-33a/e specifically — without it, a client's very
  FIRST-EVER disconnect/reconnect always reports `lastServerSeq: 0`,
  which `decideSyncMode` unconditionally resolves to SNAPSHOT regardless
  of the resident-engine bit, making CATCHUP/ALREADY_CURRENT completely
  unreachable — this was the mechanism by which RC-01 (the simplest cell)
  was still able to surface Bug 1 above despite being the "trivial" corner
  of the matrix. Gated behind its own command, `pnpm test:reconnection`
  (`packages/client/vitest.reconnection.config.ts`), excluded from the
  default `pnpm test` via root `vitest.config.ts`'s `exclude` — the same
  pattern as convergence/properties/mutation/index/db/benchmark: many real
  WebSocket connections and real (if short) reconnect-backoff delays
  against a real in-process server, several minutes end to end, fuzz/
  integration-suite scale, not inner-loop scale.

  **DoD verification, all against the real, fixed implementation**: the
  full 27-cell matrix passes — convergence across both replicas, an
  independent durable-log replay (`loadFullOperationLogWithSeq`) matching
  the expected operation COUNT exactly (no more, no fewer — the concrete
  "zero duplication" check, since re-minted content always carries a
  distinct, Invariant-I1-guaranteed-unique stamp, making literal stamp
  duplication structurally impossible; what a bug WOULD produce instead is
  an inflated total count, which this catches directly), `pendingCount()
  === 0` on both replicas, and `auditDocument` returning `result: "ok"`
  for every cell. RC-27 (L=2000, R=5000) measured p95 reconnect latency of
  **3616ms** over 20 real, repeated reconnection cycles in the full,
  whole-suite confirmation run (samples ranged 1744-3616ms; an isolated
  run of just this one test, with no other tests contending for the same
  machine, measured a tighter 1552-2152ms/p95=2152ms — both comfortably
  under PRD M6's 5-second budget, with the whole-suite figure being the
  more representative, honestly-reported one since it's what actually
  ships as `pnpm test:reconnection`'s own real result). RC-28
  materializes to exactly "HE!" on both replicas, the offline "!" present
  exactly once, never rejected. RC-33a-d each pass across their full 20
  real, severed-and-retried runs; RC-33e's synchronous FakeWebSocket
  proof and RC-33a's real-server positive control both hold. RC-34's
  32-client storm converges within 30s to byte-identical text on every
  client, with the recalibrated (and fully-reasoned) jitter-distribution
  check passing; its second assertion (backoff does not reset within 60s,
  verifying Phase 10's own `backoff.ts` under this new 32-client scenario
  rather than reimplementing it) also passes. The default `pnpm test`
  suite (388/388, up from 373/38 files at the end of Phase 22 — this
  phase's own new coverage in `controlCodec.test.ts`/`handshake.test.ts`
  accounts for the +15; the large new `reconnection.test.ts` file itself
  is gated out, see below) and `pnpm typecheck`/`pnpm lint` across every
  package were re-run clean after every fix in this phase, not just once
  at the end.

  **Existing-test-suite ripple effects, all mechanical, not behavioral
  regressions**: `gateway.test.ts`'s `connectAndHandshake` helper now
  consumes a THIRD control frame (ALREADY_HAVE, unconditionally sent after
  SNAPSHOT/CATCHUP/nothing) — needed so it doesn't leak into a LATER
  `frames.next()`/`frames.nextControl()` call elsewhere in that file (the
  PONG checks in the heartbeat tests, specifically, would otherwise have
  silently received this leftover frame instead of the one they actually
  expect). `syncClient.test.ts`/`syncClient.durableQueue.test.ts` needed
  an `alreadyHaveFrame()` trigger added after every hand-constructed
  SNAPSHOT frame that a test expects to reach `"synced"` from — since
  reconciliation and the `"synced"` transition now happen inside
  `finishHandshakeAfterAlreadyHave`, chained via `handshakeGate` (always at
  least one real microtask after the triggering frame, even for SNAPSHOT
  mode, since a `.then()` callback is never invoked synchronously even on
  an already-resolved promise) — each affected test's own `it()` callback
  became `async` with an explicit `await Promise.resolve()` (a single
  microtask flush; verified sufficient by tracing the exact FIFO
  microtask-queue ordering, not just added until it happened to pass) after
  triggering ALREADY_HAVE. `controlCodec.test.ts`'s pre-existing "rejects a
  reserved-but-unimplemented type" test switched from CATCHUP_BEGIN (now
  implemented) to PERMISSION_CHANGED (the only type still reserved).
  Neither `keystrokeLatency.bench.test.ts` nor `headlessHarness.test.ts`
  needed any change — the former never checks `state`/reconciliation, only
  `engine` (set synchronously regardless of ALREADY_HAVE); the latter
  already polls via `waitForState` rather than assuming synchronous
  completion.

  **What is deliberately NOT built this phase**: server-side session/
  replica-id resumption — unchanged, still the standing Phase 8/9
  decision, reaffirmed (not reopened) by this phase exactly as Phase 22
  reaffirmed it; a reconnecting client still always receives a brand-new
  replica id regardless of sync mode, which is WHY `rebuildEngineForReconnect`
  must exist for CATCHUP/ALREADY_CURRENT at all (a same-identity resumption
  design would not need it). DOM-layer wiring for CATCHUP's own delta
  application — `handleCatchupChunk` applies each chunk directly to
  `engine` but does not call `notifyRemoteOpsApplied()` the way live
  `handleOps` traffic does, so a live `EditorView` would not visibly
  re-render mid-catchup today; this phase's own dependencies (16, 22) and
  Scope-IN never named the DOM/editor-binding layer, and the RC-* matrix
  is entirely headless-SyncClient-level, so this is a disclosed gap for
  whichever later phase next touches `EditorView`'s own remote-update
  wiring, not an oversight glossed over. Rule 7.2's own "explicit
  rejection, content preserved and exportable" flow (Phase 21's own
  still-open item) remains unbuilt — orthogonal to this phase, unaffected
  by it either way.

- **Phase 24 — Offline window enforcement and rejection preservation** (API
  Spec §5.5 preserve-never-destroy, §3.5.8 OP_REJECT codes, §10.5; PRD
  FR-OF-7, FR-OF-9; Test Plan RC-30, RC-31, RC-32). Implements the ten-minute/
  2,000-operation offline bound (client-side, self-imposed) and the
  server's own explicit-rejection half of Rule 7.2 (Engine Spec §7.6,
  left unbuilt by Phase 21), plus API Spec §5.5's five-step preserve rule
  for `permission_denied`/`offline_window_exceeded`/`document_locked`.
  Dependencies: Phases 21, 23 (both load-bearing, as scoped).

  **Client-side cap (`packages/client/src/sync/offlineWindow.ts`, new)**:
  `OfflineWindowTracker` — a small, clock-injectable, standalone class
  (the same "pure logic under a stateful class" split as Phase 21's GC
  safety cap) tracking elapsed time and op count since `SyncClient` last
  left `synced`. Two thresholds, exactly Scope-IN's own numbers: `warn`
  at 8 minutes OR 1,600 ops (whichever first), `capped` at 10 minutes OR
  2,000 ops. `SyncClient.localInsert`/`localDelete`/`localInsertText` all
  call a new `assertOfflineWindowNotExceeded()` BEFORE touching `engine`
  at all — refusing the edit outright (throwing `OfflineWindowExceededError`)
  rather than minting-then-discarding, which would leave the local engine
  (and anything rendering from it) reflecting content the durable queue
  never actually captured. `inputPipeline.ts`'s `insertTextAt`/
  `deleteRangeAt` catch this one error type and no-op (same shape as the
  pre-existing "no engine yet" guard) so it never escapes a DOM event
  handler uncaught. A new `SyncClient.offlineWindowStatus: Observable<
  OfflineWindowStatus>` (reactive, `{level, elapsedMs, opsCount}`) and
  `exportLocalText()` (API Spec §5.5 step 4 — a plain-text
  `engine.text()` snapshot, "export unsaved changes") round out the
  DoD-required capabilities. Deliberately NO periodic wall-clock timer
  keeps `offlineWindowStatus` ticking purely from elapsed time while idle
  (never typing) — refreshed only at state transitions and after each
  accepted mint; a `setInterval` alive for the ENTIRE, UNBOUNDED
  `"offline"` state (no automatic path back to `synced`) is exactly the
  shape of leaked-timer bug this project has been burned by twice before
  (Phase 9's `Gateway.close()`, Phase 22's Bug 4) — not worth the risk
  for a purely cosmetic idle-tick, and every DoD scenario this phase
  builds against (RC-30) involves continuous operations anyway.

  **RC-31's own literal "boundary must be tested from both sides"
  requirement** is satisfied via `OfflineWindowTracker`'s direct,
  clock-injectable unit tests (`offlineWindow.test.ts`) — exact values at
  1,999/2,000/2,001 ops and at `OFFLINE_CAP_MS - 1`/`OFFLINE_CAP_MS`/
  `OFFLINE_CAP_MS + 1`, including RC-31's own literal D=9min50s/L=1,950
  scenario asserted NOT rejected — deterministic, no real or fake wall-
  clock waiting, the same reasoning Phase 21's GC safety cap already
  established for this exact kind of boundary proof.

  **Preserve rule (API Spec §5.5), `SyncClient`**: the required verbatim
  comment appears above `handleOpsMessage`'s `"opReject"` case:
  ```
  // Preserve, never destroy. PRD §2.1: one destroyed paragraph costs more than a
  // hundred smooth sessions earn, and a user who cannot retrieve their text will
  // not trust the product again. API Spec §5.5.
  ```
  A new `rejectedOps` map (in-memory, mirrored to the durable `rejected`
  store, restored from it at startup) plus a reactive `rejectedCount:
  Observable<number>`, `listRejected(): RejectedEntry[]`, and
  `discardRejected()` (step 5 — "discard local-only state only after an
  explicit user action"; clears both the in-memory map and the durable
  store via a new `DurableQueue.clearRejected()`/`loadRejected()` pair;
  called by NOTHING in this file automatically) together implement all
  five steps for every rejection reason this client ever receives (not
  narrowly scoped to just the three named codes — preserving more is
  never wrong, and the existing durable-write call site already treated
  every reason uniformly before this phase).

  **A real gap closed while wiring the preserve rule in**: API Spec
  §6.3's ack-implies-durability design (Phase 16) acks an operation the
  instant it's durably COMMITTED, independent of whether it ever
  actually integrates into the live structure — so an operation that
  later gets explicitly rejected by the server's offline-window sweep
  (below) may already have been acked and removed from `unacked` by the
  time that LATE rejection arrives, well after the fact. `unacked.get()`
  alone would then find nothing to preserve. Fixed with a new, bounded
  (10,000-entry, oldest-evicted) `recentlySentOps` map — every operation
  this client has ever SENT (not just currently-unacked ones) — consulted
  as a fallback in the `"opReject"` handler specifically for this
  late-rejection case.

  **Server-side offline-window sweep (`packages/server/src/
  offlineWindowScheduler.ts`, new)** — Rule 7.2's own "explicit
  rejection" half (Engine Spec §7.6), the piece Phase 21's tombstone GC
  explicitly left unbuilt: a still-BUFFERED (`engine.pending`) operation
  whose missing origin can never resolve is explicitly rejected
  (`OFFLINE_WINDOW_EXCEEDED`, 0x06) rather than left sitting in `pending`
  forever. Runs in-process, once per open document, on a fixed interval
  — the same shape as `gcScheduler.ts`/`auditScheduler.ts` — new
  `Engine.hasIdentifier(id)`/`rejectPending(id)` public methods (the
  latter matches by the OPERATION's own id, never the target it
  references, mirroring `applyRemote`'s own idempotence discipline) give
  it what it needs without teaching the pure engine anything about time.
  `DocumentCoordinator` gained `pendingFirstSeenAtMs: Map<string,
  number>` (server-side-only bookkeeping, never inside the engine —
  Engine Spec C9) so the sweep can distinguish "just noticed, give it
  the full grace window" from "genuinely overdue" across repeated ticks.

  **A documented interpretation of Scope-IN's own "absent from the log"
  wording**: read literally against the durable `operations` table, this
  condition can never fire once an origin has ever been committed —
  Phase 21's own account is explicit that table is NEVER pruned, so a
  garbage-collected node's own INSERT row lives on forever there. The
  only signal that actually distinguishes a permanently-stuck pending
  operation from an entirely ordinary, momentarily-out-of-order one
  (ordinary in real concurrent editing, resolves in milliseconds) is
  elapsed TIME — exactly Scope-IN's own literal number, 30 seconds — not
  durable-log membership, which cannot add discriminating power on top
  of "currently absent from the live engine" (true, by definition, of
  EVERY pending operation). `offlineWindowScheduler.ts`'s own header
  comment carries the full reasoning. A real bug was found and fixed
  building this: the sweep's first version iterated `engine.pending`
  directly while also mutating it via `rejectPending()`'s in-place
  splice — a classic "shift during iteration" bug that silently skipped
  every OTHER element of a same-tick batch (a 3-item batch evicted only
  2, leaving the middle one stuck). Fixed by snapshotting `[...engine.
  pending]` before the loop; caught by this phase's own
  `offlineWindowScheduler.test.ts`, not by review.

  **A genuine, load-bearing finding about `reconcileOfflineQueue.ts`
  (Phase 22), discovered while building this phase's own client-level
  integration test, not assumed in advance**: Phase 22's
  `visibleIndexAfter`/`visibleIndexOfTarget` always resolve a queued
  operation's anchor against the reconnecting client's OWN CURRENT
  structure at reconcile time, and CATCHUP (Phase 23) always delivers
  the delete that would tombstone a since-collected node's own
  visibility BEFORE reconciliation ever runs (`handshakeGate`'s own
  serialization order) — so by the time `reconcileOfflineQueue` resolves
  an anchor, the target is either tombstoned-but-present (CATCHUP) or
  entirely absent (a fresh SNAPSHOT, built from the server's already-
  GC'd structure), and `visibleIndexAfter`'s own documented fallback
  (visible position 0 either way) produces a NEW operation anchored to
  `null` — always immediately resolvable — rather than ever re-sending a
  specific, now-collected identifier. **This means RC-30's own "anchors
  were collected" rejection scenario is NOT reachable through this
  project's OWN real `SyncClient` reconciliation flow at all, by
  design** — Phase 22's graceful-degradation fallback (`visibleIndexAfter`'s
  own doc comment already flagged the `idx === -1` branch as "a
  defensible, disclosed fallback" for "the remote theoretical case," not
  previously connected to Rule 7.2's own scenario until this phase tried
  to construct it end to end and found the client always lands safely
  instead of stuck). This does NOT make the server-side sweep
  unnecessary or untested — Rule 7.2 is an explicit protocol-level
  guarantee regardless of what this project's OWN client happens to
  avoid triggering, and it remains the correct backstop for any OTHER
  client, a genuinely slow/reordered delivery, or a future reconciliation
  redesign. Proven end to end two ways instead: directly against
  `engine.pending` (`offlineWindowScheduler.test.ts`) and via the real
  wire protocol using two independent local `Engine` instances — one
  that learns about the delete (ordinary traffic), one that deliberately
  does NOT (standing in for "a client whose own knowledge is stale
  enough to still reference a since-removed node") — in
  `gateway.test.ts`'s new "Offline-window sweep, end to end over the
  real wire protocol" test, which sends a raw, hand-built OP_INSERT
  naming the collected identifier directly, bypassing SyncClient's own
  already-safe reconciliation logic entirely. Both this finding and its
  two-track resolution are documented in full, including the exact
  hand-trace, in `offlineWindowPreservation.test.ts`'s own header
  comment.

  **Server-side `authorize` (writePath.ts step 1) — Phase 24's own real,
  if still minimal, check ahead of the full Phase 26-30 permission
  system**: `session.role !== SessionRole.VIEWER`. Steps 1-3's rejection
  paths were reordered to run AFTER step 4's expansion (not step order
  1,2,3,4) — a rejection needs the expanded per-operation view to name
  each stamp (RejectEntry), matching step 2's own pre-existing
  precedent, already evaluated post-expansion. The private `rejectAll`
  helper was renamed and exported as `sendOpReject`, now shared by
  writePath.ts's own three rejection paths AND
  offlineWindowScheduler.ts's separate OFFLINE_WINDOW_EXCEEDED path.

  **RC-32's permission-downgrade mechanism — a deliberately minimal,
  explicitly TEST-ONLY stand-in, per the phase brief's own explicit
  instruction not to build the full permission system prematurely**:
  `DocumentCoordinator.testOnlyQueueRoleOverride(role)` queues a
  ONE-SHOT override consumed by the very NEXT session to join that
  coordinator (`consumeTestOnlyRoleOverride()`, called from gateway.ts's
  `handleHandshake`) — simulating "the owner already changed this
  user's role before they reconnected," since neither a real permission
  system nor a stable cross-reconnect user identity exists yet (every
  session's own identity is still a fresh `randomUUID()` per connection,
  Phase 8/16). `buildWelcomeMessage` gained an optional `role` parameter
  (default EDITOR, unchanged for every real connection). `gateway.ts`
  sends PERMISSION_CHANGED (below) AFTER the rest of the handshake
  completes (WELCOME/CATCHUP-or-SNAPSHOT/ALREADY_HAVE), matching RC-32's
  own literal assertion order.

  **PERMISSION_CHANGED (`packages/protocol`)** — the last previously-
  reserved CONTROL type is now implemented: a minimal wire message
  (`{kind: "permissionChanged", role}`), NOT the full permission system
  itself. As of this phase, every named CONTROL type (0x01-0x0E) is
  implemented; `controlCodec.test.ts`'s own "rejects a reserved-but-
  unimplemented type" test was updated to use a literal out-of-range
  type byte (0x0f) instead, since nothing remains reserved to construct
  a frame against.

  **RC-32's own "400 operations ... in one response" requirement**
  needed a real, useful addition, not just a test artifact: a new
  `operationsToWireMessages()` (`wireHelpers.ts`) generalizes Phase 12's
  `operationsToRunMessages` to a MIXED sequence of Insert and Delete
  operations — a maximal same-kind run coalesces (inserts into one
  OP_INSERT_RUN, consecutive-counter deletes into one OP_DELETE_BATCH),
  everything else falls back to individual messages. `finishHandshake
  AfterAlreadyHave`'s reconciliation resend now uses this instead of one
  `sendOperation()` call per op — a genuine wire-efficiency win for any
  large reconnection reconciliation, not merely what RC-32 happens to
  need, and it's what lets the server's `authorize` rejection of a whole
  VIEWER-session batch arrive back as ONE OP_REJECT (`processIncomingOperation`
  rejects one incoming message's entire expanded `ops` array as a single
  unit).

  **A real regression found and fixed via the full default `pnpm test`
  re-run, not anticipated in advance**: adding a THIRD parallel
  IndexedDB read (`durable.loadRejected(...)`) into the SAME `Promise.all`
  that gates `SyncClient`'s `openSocket()` call measurably slowed real
  client startup — enough to flip a genuine, pre-existing DUR-08 timing
  assertion (`syncClient.durableQueue.test.ts`: an operation's debounced
  durable write must NOT have flushed by the time a second client's
  HELLO is inspected). Fixed by decoupling: `loadRejected` is now fetched
  separately, AFTER `openSocket()` is called, fire-and-forget — nothing
  on the handshake-critical path depends on restoring a PRIOR session's
  preserved-rejections history promptly; `listRejected()`/`rejectedCount`
  simply update once it resolves.

  **DoD verification**: RC-30's two halves are proven separately, for
  the reasons documented above — RC-30a (the cap/warning/export
  mechanics) via a real `SyncClient` against a real server
  (`offlineWindowPreservation.test.ts`, 2,000 real `localInsert()` calls,
  warning observed at exactly op #1,600, cap enforced at exactly op
  #2,000, export verified byte-exact); RC-30b (the collected-anchor
  rejection) via the two-track server-level proof described above, since
  it is not reachable via this project's own client. RC-31 via
  `offlineWindow.test.ts`'s deterministic, clock-injectable boundary
  tests, both sides, both thresholds. RC-32 via real, real-server
  `gateway.test.ts` tests: a queued role override reflected in WELCOME's
  own `role`, followed by PERMISSION_CHANGED, consumed by exactly one
  join (a third, unrelated join gets the ordinary default again); a
  VIEWER session's real reconnection-reconciled resend (400-shaped, via
  the SAME coalescing mechanism a real client uses) rejected in ONE
  OP_REJECT naming every one of its own stamps, never applied to the
  document. Verify-by-code-inspection (DoD's own explicit requirement):
  no path introduced this phase calls `location.reload()` or clears
  `engine`/`unacked` on these reason codes — `discardRejected()` only
  ever clears the `rejected` record, never `engine`, and is called by
  nothing in this file automatically.

  Regression gates re-run clean after every fix in this phase, not just
  once at the end: default `pnpm test` **425/425 across 45 files** (up
  from 388/41 at the end of Phase 23 — six new files this phase:
  `offlineWindow.test.ts`, `offlineWindowScheduler.test.ts`,
  `offlineWindowPreservation.test.ts`, `writePath.test.ts`, plus
  extensions to `engine.test.ts`, `wireHelpers.test.ts`,
  `durableQueue.test.ts`, `unackedQueue.test.ts`, `inputPipeline.test.ts`,
  `controlCodec.test.ts`, `gateway.test.ts`); `pnpm typecheck` clean
  across all six packages; `pnpm lint` clean for every file this phase
  touched (confirmed via an explicit per-file lint pass, not just the
  aggregate — the aggregate's own 320 pre-existing errors are entirely
  Phase 14's diagnostic scratch `.mjs` scripts, already documented,
  untouched by this phase); `pnpm format:check` now flags 202 files (up
  from 194), consistent with the same pre-existing, repo-wide CRLF/
  `core.autocrlf` condition this document has documented since Phase 19
  — this phase's own new files simply inherited it, same as every prior
  phase's.

  **`pnpm test:reconnection`'s RC-27 flake — a real, previously
  misdiagnosed client bug, found and fixed as a scoped follow-up within
  this same phase, not deferred.** Initially reported (see this
  document's earlier draft, now corrected) as an intermittent "1 of 4
  runs" failure vaguely attributed to "PING/PONG timing under sustained
  load." That characterization was never actually traced — it was
  retracted once properly investigated, per this project's own "don't
  accept a plausible-sounding explanation without checking it"
  discipline (Phases 5/7/14/20's own precedent). Proper investigation: 5
  repeated runs each on this branch AND on an unmodified Phase 23
  worktree (`git worktree` at the Phase 23 merge commit, the same
  read-only diagnostic exception Phase 20 established) showed a
  **60-80% failure rate on BOTH** — always the exact same test (RC-27)
  and the exact same error (`DOMException` code 11, `INVALID_STATE_ERR`),
  confirming this was pre-existing and unrelated to Phase 24's own
  `setState` refactor, but far worse than "rare" and squarely a real bug,
  not a rounding error.

  **Root cause, hand-traced against `syncClient.ts`, not guessed**: per
  the WHATWG spec, `WebSocket.send()` throws `InvalidStateError` in
  exactly one case — `readyState === CONNECTING`. `openSocket()`'s
  `onopen`/`onmessage`/`onclose` handlers were attached with no check
  that the firing socket was still the CURRENT `this.ws` (no generation/
  session guard existed anywhere in the file). `disconnect()` closes the
  old socket and reassigns `this.ws` SYNCHRONOUSLY, without waiting for
  that old socket's own asynchronous `'close'` event. RC-27's own
  `runCell()` calls `disconnect()` then `connect()` again almost
  immediately, 20 times per test run, against a real network round trip
  — so the OLD socket's delayed `close` event routinely arrives AFTER a
  NEW socket is already live. When it did, the STALE `onclose` handler
  ran unconditionally: it found `explicitlyOffline` already flipped back
  to `false` by the new `connect()`, misread itself as an unexpected drop
  of the CURRENT (new) connection, and called `scheduleReconnect()` —
  opening a THIRD socket and reassigning `this.ws` to it while still
  `CONNECTING`. Any send racing against that reassignment (a PING, a
  handshake frame) then threw the observed `InvalidStateError`. This is a
  real client bug reachable by any real user on an unstable network doing
  rapid disconnect/reconnect cycles, not a test-only artifact — it would
  have shipped undiagnosed had the vague original note been accepted.

  **Fix**: `openSocket()`'s three handlers now each capture their own
  socket instance and guard with `if (ws !== this.ws) return;` at the
  top — the same stale-object-guard pattern already validated in this
  codebase for Phase 22's Bug 4 leftover-timer fix. A late event from a
  superseded socket is now inert instead of corrupting whatever
  connection has since replaced it.

  **Verification numbers, measured in three stages, because the first
  round of post-fix measurement itself surfaced a second, genuine
  methodology error worth recording alongside the code fix.** Stage 1
  (5 runs each, this branch vs. the unmodified Phase 23 worktree, run
  CONCURRENTLY against each other): 60-80% failure — but re-classifying
  every failure precisely (not just grepping for the one error string)
  found TWO distinct signatures mixed together, not one: `InvalidStateError`
  (4 of 10 total) and a plain `waitForState`/overall-test timeout (3 of
  10 total, plus one legitimate p95 near-miss) — meaning the original
  claim "every failure has the identical signature" was itself imprecise
  and was corrected once checked. Stage 2 (10 runs post-fix, but run
  CONCURRENTLY with the full `pnpm test` suite AND a 70,000-trial
  `pnpm test:convergence` run on the SAME machine): `InvalidStateError`
  dropped to **0 of 10** — the fix's own target, cleanly eliminated — but
  timeout/p95-miss failures remained at a COMPARABLE rate (6 of 10),
  which on its face looked like a second, unfixed bug. **Stage 3 (10 runs,
  fully isolated — confirmed zero other Node processes running first)**:
  **9 of 10 clean**, the one failure a single ordinary `waitForState`
  10s timeout (the same signature, at a residual rate consistent with an
  occasional slow cycle in a real-network test doing 20 rapid real
  reconnects against a shared in-process server, not a distinct logic
  bug). This confirms Stage 2's elevated timeout rate was a genuine
  measurement artifact of running multiple CPU-heavy suites concurrently
  on one machine, not a second product defect — the socket-identity fix
  is the complete, sufficient fix for the actual bug.

  **Methodology lesson, recorded because it is general, not specific to
  this one test**: never measure a timing-sensitive test's pass/fail rate
  (a wall-clock budget like RC-27's 5s p95 or a `waitForState`-style
  timeout) while another CPU-heavy suite (a full test run, a 10,000-seed
  fuzz suite, another copy of the same reconnection batch) is running
  concurrently on the same machine — the resulting contention produces
  false failure signals indistinguishable, without careful re-classification,
  from a real bug. Always isolate before trusting a timing measurement;
  only a boolean signal (an error class present or absent, like
  `InvalidStateError`'s count) is safe to measure under concurrent load.

  `pnpm test` (the full default suite) re-run clean at 425/425 after the
  fix, confirming nothing in ordinary connect/reconnect/backoff behavior
  regressed from touching this file's core socket-event wiring. `pnpm
  test:convergence` re-run at its full 10,000-seeds-per-config budget
  across all 7 configs — 70,000/70,000 converged, zero divergences —
  confirming the fix (client-side only, no engine/protocol/server touch)
  has no bearing on the convergence guarantee, as expected.

  (Historical note, kept rather than silently deleted: the paragraph this
  one replaces was WRONG on two counts — it understated the rate ("1 of 4
  repeated runs," when the real, properly-measured rate was 60-80%), and
  it misattributed the cause to vague "PING/PONG timing under sustained
  load" rather than the actual, traced mechanism — a stale-socket
  identity bug in `openSocket()`'s event handlers, now fixed.

  **What is deliberately NOT built this phase**: the full owner/editor/
  viewer permission and role-assignment SYSTEM (who may change whose
  role, and why) — still Phase 26-30's job; RC-32's own mechanism is an
  explicitly-labeled, one-shot test override standing in for it, not a
  first draft of it. Any DOM-layer UI for the preserve rule (an actual
  "Export"/"Discard" button, a rendered warning banner) — this phase
  builds the real `SyncClient`-level capabilities
  (`offlineWindowStatus`/`rejectedCount`/`listRejected`/`exportLocalText`/
  `discardRejected`) a future UI phase wires up; `ConnectionIndicator.tsx`
  itself is untouched this phase. `document_locked` rejections are
  handled identically to the other two preserve-rule codes on the
  client, but nothing server-side in this project can currently PRODUCE
  one (no document-locking feature exists yet) — the client-side
  handling is real and tested via direct construction, the triggering
  mechanism is future work. A since-disconnected session's own overdue
  pending operation is still explicitly evicted from `engine.pending`
  (Rule 7.2's own "never left indefinitely" requirement, honored
  either way) but has no live socket to be notified over — a disclosed
  gap for a client that reconnects LATER, out of this phase's own DoD
  scope (RC-30's scenario has the client already reconnected by the
  time rejection fires).

- **Phase 25 — Milestone M2, DUR-05/06 adverse-network verification, plus a major
  correctness investigation (the Fugue migration) and six further real bugs.**
  This phase's own account is unusually large and lives across several
  dedicated sections of this file rather than one linear bullet — added here
  purely to register it properly in this list (Test Plan §11/M2's own DoD is
  now fully closed out; see below), not to duplicate that content. In order:
  DUR-05/06 DoD verification found `Engine.integrate()` could diverge or
  throw under completely ordinary network conditions (duplicate/reorder/
  drop, and eventually even fault-free reconnects) — three distinct bugs in
  this project's own hand-derived YATA-family scan, found one at a time as
  each prior patch was itself found insufficient. Given three bugs in the
  same algorithm family, the engine was rebuilt from scratch on **Fugue**
  (Weidner & Kleppmann) rather than patched a fourth time — see "🛑 CRITICAL,
  OPEN, UNRESOLVED FINDING" and "Engine Spec §4.3 replaced by the real YATA
  algorithm" immediately below and under Key Technical Decisions for the
  full investigation, verified against all 22 adversarial cases, all 5
  property suites, the full 70,000-seed convergence suite, and a rebuilt
  mutation matrix (8/8 killed). Integrating the new engine into
  `protocol`/`server`/`client` then surfaced six further real, independently
  fixed bugs — see "✅ PHASE 25 UPDATE (2026-09-06)" for the full account of
  Bugs 3-8 (the `parent`/`side` wire-shape integration gap; `writePath.ts`
  silently ignoring a buffered `applyRemote` result; an out-of-order-commit
  race breaking CATCHUP's own honesty guarantee; a replica-id-reuse-after-
  restart bug plus its own bigint-string-concatenation bug; the client-side
  seq-tracking redesign; and a wire-protocol run-coalescing bug that
  silently corrupted reconciled operations). DUR-05/DUR-06 both PASS
  cleanly after all of the above (10/10 clean DUR-06 runs). This
  investigation also found, root-caused, and partially mitigated **Critical
  Finding #2 / R0012**: a live, continuously-connected client's ORDINARY
  keystroke can anchor to a node the server has already garbage-collected —
  see that section's own entry for the full mechanism, the three-option
  tractability analysis, and Option 2 (client-side revert-and-notify,
  shipped) vs. Option 1 (a structurally-safe GC/undo-horizon redesign,
  explicitly deferred — Open Item 9). DUR-02 and DUR-03 both PASS (100%
  clean, real runs against real Postgres). M8-a is PARTIAL — real numbers
  recorded at reduced scale (500/4,000 ops); the full 100,000-op number
  remains genuinely unknown until Open Item 3's O(N²)→O(log N) redesign
  lands (Fugue's own reference storage layer is quadratic — a real,
  disclosed, deliberately deferred performance finding, not a correctness
  one). M8-e initially failed (`pending` stuck nonzero); wiring
  `offlineWindowScheduler.ts`'s sweep into the soak loop (Open Item 10)
  fixed that, and a same-day follow-up investigation (forced-GC
  re-measurement, map-size diagnostics, a realistic-undo-horizon comparison
  run) resolved a heap-growth smell-test failure the fix's own first re-run
  surfaced as confirmed unforced-GC noise, not a leak (Open Item 11,
  resolved) — see `tests/regression/R0013` and `docs/benchmarks.md`'s own
  "M8-e soak run" section for the full data. **Phase 25's own final status:
  every DUR-0x item PASS, M8-a PARTIAL (disclosed), M8-e PASS — ready for
  the v0.2.0-m2 tag**, with Items 2/3/4/6/7/9 (below) as legitimate,
  separately-scoped, deliberately-deferred future work, none of them
  blocking this milestone's own closeout.

- **Phase 26 — Authentication and sessions** (API Spec §1.5/§4.1/§4.2, Test
  Plan §11.1/SEC-11g). Real user accounts and secure token handling, for the
  first time in this project: `POST /v1/auth/login`, `/refresh`, `/logout`.
  Argon2id password hashing (`passwordHash.ts`); a 15-minute JWT access
  token and a 30-day (disclosed default, not spec-mandated)
  opaque-random-secret refresh token in an `HttpOnly; Secure; SameSite=Strict;
  Path=/v1/auth/refresh` cookie (`tokens.ts`); refresh-token ROTATION with
  FAMILY REVOCATION (reusing an already-rotated token revokes every token
  ever issued from that login, not just the reused one — `authService.ts`'s
  `rotateRefreshToken`, verified end to end: a token two rotations old is
  replayed, and a LATER, otherwise-still-valid token from the same family is
  confirmed to ALSO stop working as a direct consequence); per-IP and
  per-account login rate limiting (`rateLimiter.ts`, a sliding-window log,
  disclosed unvalidated-but-reasonable defaults, the same "configuration,
  not a hardcoded constant" precedent as `GcConfig`/`OfflineWindowConfig`).

  **SEC-11g (the user-enumeration timing oracle) is the phase's own
  centerpiece requirement, not an afterthought**: `attemptLogin`
  (`authService.ts`) ALWAYS runs a real Argon2id comparison, resolved to
  either the real user's own stored hash or one fixed, pre-computed dummy
  hash (`getDummyPasswordHash()`, `passwordHash.ts`) — the branch on
  "does this email exist" happens only in WHICH hash gets compared against,
  never in WHETHER the comparison runs at all. Verified with a REAL
  statistical test, not eyeballing: 1,000 real samples each of
  unknown-email and wrong-password login (2,000 real Argon2id calls against
  a real Postgres instance, interleaved to spread any real-world timing
  drift evenly across both groups), a genuine Welch's two-sample t-test
  PLUS the DoD's own explicit "or simply comparing p50/p95/mean" alternative
  computed as a second, independent check. **Measured, real numbers**:
  unknown-email mean=125.046ms (p50=112.920ms, p95=177.259ms); wrong-password
  mean=126.679ms (p50=113.010ms, p95=184.646ms); Welch's t = **-0.6393**
  (a generous, deliberately-calibrated bound of `|t| < 8` — see this test's
  own header comment for why a literal significance-cutoff would itself be
  the wrong bound at n=1,000, the same "a textbook threshold doesn't survive
  contact with the real sampling distribution at this sample size" lesson
  RC-34's own jitter-threshold recalibration (Phase 23) already taught this
  project); mean difference = **1.632ms** (bound: <20ms, vs. the ~130ms full
  hash cost the bug class this test guards against would actually produce).
  Genuinely, comfortably indistinguishable.

  **A real, if minor, test-design finding caught during DoD verification**:
  the first draft of the refresh-rotation test asserted the rotated
  response's own NEW access token must differ from the ORIGINAL one — this
  failed on the very first real run, because two JWTs signed with IDENTICAL
  claims within the SAME wall-clock second are legitimately byte-IDENTICAL
  (HS256 has no per-call randomness, and a JWT's own `iat` claim has
  1-second resolution). Not a product bug — access-token uniqueness across
  calls is not a security property this system relies on (unlike
  refresh-token uniqueness, which the rotation/revocation model genuinely
  requires and which IS independently verified). The test's own incorrect
  assertion was fixed, not the code.

  **No signup/registration endpoint exists** — Scope-IN names only login/
  refresh/logout, and building one wasn't asked for; every test seeds a
  real user directly via `hashPassword()` + a raw `INSERT INTO users`,
  matching this project's own established fixture-seeding convention
  (Phase 17/18's bulk-insert technique) rather than inventing an unscoped
  endpoint. `scripts/seed.ts`'s own dev user now gets a REAL Argon2id hash
  of a fixed, published dev-only password (`dev-password-not-for-production`)
  instead of Phase 16's placeholder string, so `pnpm db:seed` produces an
  account this project's own new login endpoint can actually authenticate
  — a small, disclosed, in-scope improvement, not scope creep;
  `operationStore.ts`'s own SEPARATE, still-non-loggable-in
  `SYSTEM_USER_PASSWORD_HASH_PLACEHOLDER` (auto-provisioned WS-connection
  users) is untouched, exactly as before.

  **A genuine design question resolved by precedent, not by asking**:
  every one of this project's other database-backed features
  (`OperationStore`, Phase 16) is injectable, defaulting to something
  infra-free so `pnpm test` never needs a real Postgres instance. Auth has
  no meaningful in-memory substitute (a login system IS its own persistence
  layer), so the SAME pattern is applied one level up instead:
  `HttpAppDeps`/`CreateCollabServerDeps` gained an OPTIONAL `authDeps`/
  `auth` field (`{ pool, authConfig }`); when omitted (every pre-Phase-26
  test), the three auth routes are simply never mounted, exactly mirroring
  how an unknown document id already 404s rather than crashing. Only
  `index.ts`'s real direct-run path and this phase's own new
  `db/auth.db.test.ts`/`db/authTiming.db.test.ts` ever supply it.

  **Explicitly, deliberately NOT built this phase**: the WebSocket
  gateway's own handshake does NOT verify an access token — a client can
  still join any document by guessing its id, exactly as before (Phase
  27+'s job; `gateway.ts`'s own `testOnlyQueueRoleOverride` and the
  Phase-16-era auto-provisioning behavior are both untouched and still
  described by their own original CLAUDE.md entries). No real permission
  system (owner/editor/viewer) — still Phase 26-30's job as a whole; this
  phase is authentication only, not authorization.

  **DoD verification, all against a real, migrated Postgres instance**:
  `db/auth.db.test.ts` (12 tests) — login success (200, real JWT, `expiresIn:
  900`, the exact required cookie attributes verified from the real
  `Set-Cookie` header); unknown-email and wrong-password login return the
  IDENTICAL response body; 400 `validation_failed` for missing/empty
  fields AND for syntactically malformed JSON; refresh rotation (a
  genuinely new refresh cookie value each time); the family-revocation-on-
  reuse scenario described above; logout revocation + cookie clearing +
  idempotent no-cookie logout; per-IP AND per-account rate limiting
  (429, independently verified); and a real, automated check — not mere
  code inspection — that NO token value (access token, raw refresh token)
  ever appears in this server's own captured `console.log` output across a
  real login→refresh→logout sequence, satisfying the DoD's own "no token
  appears in any URL or server log" line as a genuine, repeatable test
  rather than a one-time manual read-through. `db/authTiming.db.test.ts`
  (SEC-11g, above) passes with the real numbers quoted. Full default `pnpm
  test`: **444/444 passing** (2 disclosed, unrelated skips, unchanged),
  confirming the shared-file changes this phase touched (`config.ts`,
  `httpApp.ts`, `server.ts`, `index.ts`) introduced zero regressions
  elsewhere. `pnpm typecheck` clean across all 6 packages; `pnpm lint`
  clean for every file this phase touched (the aggregate's own 333
  pre-existing problems are entirely Phase 14's diagnostic scratch `.mjs`
  scripts plus other already-documented pre-existing gaps, none touched by
  this phase); `pnpm format:check` flags this phase's own new/edited files
  alongside the same pre-existing, repo-wide CRLF/`core.autocrlf` condition
  documented since Phase 19 (223 files now, up from 202 at Phase 24 — this
  phase's own files simply inherited it, like every prior phase's).

- **Phase 27 — REST document lifecycle** (API Spec §4.3-§4.6, §4.16, §5.1,
  §5.2, §9.2; Test Plan §11.1). Create, list, read, rename, and revoke
  access to documents, for the first time behind Phase 26's REAL
  authentication rather than a stub: `POST /v1/documents`,
  `GET /v1/documents`, `GET/PATCH/DELETE /v1/documents/{id}`,
  `GET /v1/users/search`. Every route runs behind a new `requireAuth`
  Express middleware (`authMiddleware.ts`) that verifies a real
  `Authorization: Bearer <accessToken>` header against Phase 26's own
  `verifyAccessTokenDetailed` — the first thing in this project that
  actually VERIFIES an access token on an incoming request (Phase 26
  only ever ISSUED one; the WebSocket gateway's own handshake still
  verifies nothing, unchanged).

  **The single error envelope (API Spec §5.1)** —
  `{ error: { code, message, requestId, details? } }` — is implemented in
  a new `restErrors.ts` and used by every route THIS phase adds.
  **Deliberately NOT retrofitted onto Phase 26's already-shipped
  `/v1/auth/login`/`/refresh`/`/logout` routes**, even though §5.1's own
  text reads "every non-2xx response" with no stated exception: this
  phase's own Scope-IN names a specific, new set of endpoints, and
  `auth.db.test.ts`'s own existing assertions (`{ error:
  "invalid_credentials" }`, a flat string, not this envelope) are real,
  passing, already-DoD-verified tests this phase has no mandate to
  break. A future phase can migrate the auth routes to this same
  envelope explicitly, if and when asked — disclosed here, not silently
  decided. A per-request `requestId` (`restErrors.ts`'s
  `requestIdMiddleware`, mounted as the very FIRST `app.use()` — ahead
  of `express.json()`, so even a request that fails JSON parsing already
  has one) is attached to `res.locals`, echoed in every error envelope,
  and logged on both the way in and the way out of every request
  (`http.request`/`http.response`), matching §5.1's own "requestId
  appears in every server log line for that request" literally —
  verified with a real test that captures `console.log` output and
  confirms a returned `requestId` actually appears in it.

  **The 404-vs-403 rule (API Spec §4.5) is implemented exactly as
  specified, not softened**: a caller with NO permission row for a
  document gets `404 document_not_found` — indistinguishable from the
  document genuinely not existing, closing the enumeration oracle a 403
  would open — while a caller with SOME role but an insufficient one
  (an editor/viewer hitting PATCH/DELETE, both owner-only) gets `403
  permission_denied`. GET never returns 403 at all, per the Test Plan
  §11.1 matrix's own GET row (owner/editor/viewer/no-role/nonexistent →
  200/200/200/404/404) — verified explicitly, including the genuinely
  nonexistent-document case landing on the SAME code as the
  exists-but-no-access case.

  **Idempotency (API Spec §9.2)** — a new `idempotency_keys` table
  (migration `1788134880000_create-idempotency-keys.js`), scoped by
  `(user_id, endpoint, key)` rather than by key alone (an
  Idempotency-Key header is only ever meaningful relative to a specific
  caller and a specific route — this phase's own POST /v1/documents is
  the only current user, but the schema doesn't hardcode that). No
  literal DDL was supplied for this table (unlike Phase 15's own eight
  verbatim-DDL tables) — this is this phase's own reasonable, disclosed
  design, documented in full in the migration's own header comment. "Same
  body" is checked via a SHA-256 of a CANONICALIZED (recursively
  key-sorted) JSON serialization (`documentService.ts`'s
  `canonicalJsonStringify`/`hashRequestBody`), verified with a real test
  sending the identical logical body with keys in a different literal
  order and confirming it still counts as "the same." The 24-hour window
  (§9.2's own literal number) is enforced at QUERY time
  (`created_at > now() - interval '24 hours'`), not a scheduled cleanup
  job — a row past that window is simply treated as though it never
  existed, the same "disclosed, not the biggest scope creep" precedent
  as `rateLimiter.ts`'s own in-memory map and the `snapshots` table's own
  lack of a retention policy.

  **DELETE's "every open socket for the document receives
  GOODBYE{reason: 2}" (API Spec §4.5)** required reaching from an HTTP
  route handler into the live WebSocket gateway for the first time in
  this project's history. Resolved with a minimal, low-blast-radius
  addition rather than a new cross-module dependency: `CoordinatorSession`
  gained one new OPTIONAL field, `disconnectForRevocation?: () => void`
  (`documentCoordinator.ts`) — optional specifically because a DOZEN
  pre-existing test fixtures across this codebase construct a
  `CoordinatorSession` object literal directly with no real `ws` to
  close (`writePath.test.ts`, `heartbeat.test.ts`, every `db/*.db.test.ts`
  file), and making it required would have forced updating every one of
  them for a capability none of them exercise. `gateway.ts` is the ONLY
  place that ever sets it — a closure over the real `ws`, encoding a real
  GOODBYE (`GoodbyeReason.PERMISSION_REVOKED = 2`, matching the spec's
  own literal reason code) and closing the socket (WS close code `4001`,
  the application-specific range) once the frame is actually written.
  `DocumentCoordinator.disconnectAllSessions()` iterates every currently-
  joined session and calls this via `?.()` — a silent no-op for every
  session that doesn't have it, i.e. every pre-existing test fixture.
  Verified end to end with a REAL WebSocket client connected to a REAL
  document, a real committed operation, and a real DELETE request —
  confirming the client's own `ws.on("message", ...)` actually receives
  a decoded GOODBYE with `reason === PERMISSION_REVOKED` after the HTTP
  204 response.

  **DELETE's "does NOT delete the operation log or snapshots" (PRD
  FR-VH-5)** is implemented literally: `revokeDocumentAccess`
  (`db/documentStore.ts`) sets `documents.access_revoked_at` and
  `DELETE`s every `document_permissions` row for that document (the
  actual mechanism behind "revokes all permissions" — that table has no
  `revoked_at` column of its own, so a permission row's mere EXISTENCE
  is what "has access" means) — the `documents` row itself and every
  `operations` row are never touched. Verified with a real row count
  before and after DELETE on a document with a real committed operation:
  identical count, confirming genuine retention, not merely an
  assumption from reading the code.

  **`GET /v1/documents/{id}`'s owner-only `structureSize`/
  `tombstoneCount` — a real, disclosed, pre-existing gap surfaced (not
  introduced) by this phase**: `documents.structure_size`/
  `tombstone_count` (Phase 15's own schema, "Maintained by the
  coordinator, not authoritative; the engine is") have never actually
  been WRITTEN by any code path in this project's history — they read as
  their DB default (0) forever. This phase's route prefers a currently-
  open `DocumentCoordinator`'s LIVE `engine.stats()` when one exists in
  memory, falling back to the (always-0, for now) durable columns only
  when no coordinator is currently open — the best available answer
  given the gap, not a fix to the gap itself (out of this phase's own
  Scope-IN; disclosed here so a future phase doesn't rediscover it from
  scratch).

  **`GET /v1/documents` — keyset (not OFFSET) pagination**, ordered by
  `(updated_at DESC, id DESC)` (`db/documentStore.ts`'s own
  `listDocumentsForUser`), with an opaque, base64url-encoded
  `{updatedAt, id}` cursor (`documentService.ts`'s `encodeDocumentListCursor`/
  `decodeDocumentListCursor`) — a reasonable, disclosed design choice
  (API Spec §4.4 names `?cursor=` but not its literal format). `?role=`
  is repeatable (Express's own `req.query.role` naturally becomes an
  array for a repeated query param); an invalid role token is `400
  validation_failed` rather than silently ignored. `activeParticipants`
  is read live from `getCoordinators().get(documentId)?.sessionCount`, a
  plain callback threaded into `documentService.ts` rather than a direct
  `DocumentCoordinator`/`Gateway` reference — the same decoupling
  `audit.ts`'s own `AuditOptions.liveText` already established for an
  analogous "the live in-memory truth, supplied by whoever has it"
  parameter, keeping `documentService.ts` unit-testable with no gateway
  involved at all. Verified with a real 3-document, limit=1 pagination
  walk that visits every document exactly once with no repeats or skips.

  **`GET /v1/users/search` (API Spec §4.16)** — one query, `lower(email)
  = lower($1) OR display_name ILIKE $1 || '%'`, `LIMIT 10` (never two
  separately-limited queries merged in application code, which could
  return up to 20) — verified: an exact email match returns a MASKED
  result (`maskEmail`'s own literal example, `"a***@example.com"`), a
  display-name PREFIX also matches, and a PREFIX of an email (not the
  exact address) matches NOTHING, per §4.16's own explicit
  "prefix-matching on email would make this an address-harvesting tool"
  reasoning.

  **A real, if narrow, pre-existing gap found and fixed via this
  phase's own DoD re-verification, not introduced by it**:
  `schema.db.test.ts`'s "creates all eight tables" test hardcoded a
  literal 8-table list that had never been updated when Phase 26 added
  `refresh_tokens` — meaning it was already silently wrong before this
  phase touched anything. Found only because re-running the surrounding
  `pnpm test:db` suite as part of this phase's own regression check
  surfaced it failing (now expecting 10 tables, including this phase's
  own new `idempotency_keys`) — fixed as a one-line literal-list update,
  not a design change.

  **A second, PRE-EXISTING, UNRELATED failure confirmed, not fixed, by
  this same regression check**: `snapshots.db.test.ts`'s "50,000-operation
  document warm-starts in under 2 seconds" now measures ~59 seconds, not
  under 2. This phase touched none of the code that test exercises
  (`operationStore.ts`, `snapshotter.ts`, `engine.ts`) — it is the
  already-disclosed, already-tracked Fugue O(N²) sequential-insertion
  cost (CLAUDE.md's own Open Item 3, Phase 25) surfacing at a scale
  (50,000 sequential ops) nobody had re-measured against this specific
  test's own 2-second budget since the Fugue migration landed. Left
  exactly as found — fixing it means the same deferred balanced-storage
  redesign Open Item 3 already names, not a Phase 27 fix.

  **DoD verification, all against a real, migrated Postgres instance**
  (`db/documents.db.test.ts`, new — 9 tests, one per REST-matrix row or
  row group): valid create (201, `Location` header, exact response
  shape); default title + the 512-character boundary (both sides);
  Idempotency-Key replay with the identical body (byte-identical
  response, including a key-order-shuffled "same" body) AND with a
  different body (409); list with owner/editor/viewer roles, a role
  filter, and full-walk cursor pagination; get with
  owner/editor/viewer/no-role/nonexistent (200×3 with the owner-only
  fields correctly present/absent, 404×2); patch with owner (200) vs.
  editor/viewer (403×2, title unchanged); delete with the full
  owner-only/403/204/GOODBYE/retention/permission-wipe account above;
  users/search's three cases; and the combined error-envelope test
  (malformed JSON, missing auth, a genuinely expired token — each
  matching §5.1 exactly, with the malformed-JSON case's own `requestId`
  independently confirmed present in captured server log output). Also:
  `db/auth.db.test.ts` (12/12) and `db/durability.db.test.ts` (9/9)
  re-run clean, confirming zero regression from this phase's shared-file
  changes (`httpApp.ts`, `gateway.ts`, `documentCoordinator.ts`,
  `tokens.ts`, `index.ts`). `authTiming.db.test.ts` (SEC-11g's ~5-minute
  timing test) was NOT re-run this phase — `tokens.ts`'s own change was
  purely additive (`verifyAccessTokenDetailed`, a new function; nothing
  existing was modified) and `passwordHash.ts`, the file SEC-11g's own
  timing property actually depends on, was untouched — a disclosed,
  deliberate scoping call, not an oversight. Full default `pnpm test`
  (workspace-wide): 474 passed, 2 skipped (the same disclosed, deferred
  O(N²) GC-chain tests), zero failures. `pnpm -r exec tsc --noEmit`:
  clean across all 6 packages. `pnpm lint`: clean for every file this
  phase touched.

  **What is deliberately NOT built this phase**: a "share a document"/
  grant-permission REST endpoint (Scope-IN names create/list/get/rename/
  revoke-access only; this phase's own DoD tests grant editor/viewer
  roles by inserting `document_permissions` rows directly via raw SQL,
  the same fixture-seeding convention this project has used since
  Phase 17/18's bulk-insert fixtures, for state a feature doesn't yet
  have its own API to produce). The WebSocket gateway's own handshake
  still verifies no access token at all — a client can still join any
  document over WS by guessing its id, completely unaffected by this
  phase's REST-side auth; that remains a later phase's job. Any
  retention/cleanup job for `idempotency_keys` rows past their 24-hour
  window (enforced at query time only, per this phase's own disclosed
  design above).

- **Phase 28 — Permissions and per-operation authorization** (API Spec
  §4.7-§4.9, §6.3 line 1, §11.8; Test Plan SEC-01/02/03/06/07; PRD
  FR-PM-1…4, FR-PM-6, M9). Owner/editor/viewer roles enforced server-side
  on every operation, not just at connect — the phase's own stated Goal.
  Dependencies: Phases 16 (the write path this phase's own step 1 finally
  makes real) and 27 (real REST auth, `document_permissions` reads).

  **The foundational design question, resolved with the user before any
  code was written**: Phase 28's own DoD (SEC-01 specifically) implicitly
  assumes a way to test "a real viewer's operations get rejected by real
  permission data" over a real WebSocket connection — but the WS
  handshake has deliberately carried no real authenticated identity since
  Phase 8 (`HelloMessage.ticket`'s own pre-existing doc comment: "Opaque
  bytes from a later auth phase (Phase 29) — accepted, never validated,
  this phase"). Two options were presented via `AskUserQuestion`: (1) add
  a plain, unauthenticated `userId` field to HELLO as a disclosed interim
  measure, or (2) keep HELLO completely unchanged and simulate the
  WS-side scenarios via the existing, already-labeled
  `DocumentCoordinator.testOnlyQueueRoleOverride` test seam (Phase 24's
  own RC-32 precedent), generalized as needed. **The user chose option
  2**, with reasoning worth recording verbatim because it names a real
  principle, not just a preference: "adding a client-declared,
  unauthenticated userId field to HELLO — even as a disclosed interim
  measure — would be a real, permanent addition to the wire protocol
  that contradicts this very phase's own core principle (attribution
  must come from the authenticated session, never anything
  client-declared). It's exactly the shape of gap SEC-03 exists to test
  against." This means SEC-01/02/03/07's WS-layer coverage proves the
  SERVER-SIDE ENFORCEMENT LOGIC is correct using a labeled test seam for
  identity — not a full end-to-end proof with real ticket-based
  authentication, which doesn't exist until Phase 29. Stated here
  explicitly so it is never mistaken for more than it is.

  **`DocumentCoordinator.testOnlyQueueRoleOverride` was generalized, not
  replaced** (`documentCoordinator.ts`): Phase 24's own mechanism only
  ever affected the NEXT session to join a coordinator — insufficient for
  Phase 28's own Goal ("not just at connect"), since a genuine
  per-operation re-check needs to be OBSERVABLY different from a
  connect-time check, which requires changing an ALREADY-CONNECTED
  session's role live. Two new methods close this: `setSessionRoleLive
  (sessionId, role)` (the real mechanism — mutates `session.role`,
  Phase-28-newly-mutable, was `readonly` through Phase 27 — and
  immediately invalidates that session's own cached authorization
  decision) and `testOnlySetConnectedSessionRole` (a thin, explicitly-
  named, grep-able alias for it, kept separate from the real name so
  every call site standing in for "a real permission change landed on an
  already-connected session" — since no real WS identity/ticket-based
  admission exists until Phase 29 — is unambiguously a test seam, the
  same discipline `testOnlyQueueRoleOverride` already established).

  **The authorization decision cache (SEC-06: "≤2s TTL")**
  (`DocumentCoordinator.authDecisionCache`/`authorizeSession`): keyed by
  `sessionId`, `AUTH_DECISION_TTL_MS = 2000`. Today's actual per-operation
  check (`session.role !== VIEWER`) is cheap enough that a cache buys
  nothing on its own — this exists so the SHAPE of "authorize on every
  operation, through a bounded-staleness cache" is already in place for
  Phase 29+, when this is expected to become a real per-user DB lookup
  keyed off a genuine authenticated WS identity that doesn't exist yet.
  An EXPLICIT role change (`setSessionRoleLive`) invalidates the cache
  immediately rather than waiting out the TTL — verified directly
  (`permissions.test.ts`'s own SEC-06 test): a role flipped without
  going through the real invalidation path stays masked by the cache for
  up to, but never past, 2000ms; the real path shows zero staleness at
  all, not even the TTL's own duration.

  **`writePath.ts`'s step 1 is now genuinely real, not the Phase 24
  minimal stub reused unchanged** — the phase brief's own note ("this is
  the first phase where writePath.ts's step 1 becomes real. Wire it in
  properly rather than adding a parallel check") is satisfied literally:
  the free function `authorize(session)` was DELETED (not kept alongside
  a new check) and every call site now reads
  `coordinator.authorizeSession(session)` directly. A rejection at this
  step now also logs a security-log line (`writePath.authorizationDenied`,
  session + document ids — SEC-01's own explicit requirement), and the
  identical treatment was added to the pre-existing (correct since Phase
  16) identity-mismatch rejection (`writePath.identityMismatch`) — SEC-01
  and SEC-02 share the same "log every rejection" requirement, so both
  paths log, not just the new one.

  **The required verbatim stamp.r comment is now in the code**, directly
  above the existing, already-correct (since Phase 16) `claimedReplica
  !== session.replicaId` check — this logic was never wrong, it simply
  never carried this exact citation text before:
  ```
  // stamp.r is verified against the session's replica id. This is a CORRECTNESS
  // control, not an attribution nicety: a client that could choose its own replica
  // id could mint identifiers colliding with another replica's, violating Engine
  // Spec I1 and breaking convergence itself. RFC §8.3, API Spec §11.8.
  ```

  **SEC-03 (attribution from the authenticated session, never the
  payload)**: verified, not merely inspected — `runFastPath`/`runSlowPath`
  (writePath.ts, unchanged this phase) were re-confirmed to call
  `commitOperations` with `authorSession: session.sessionId, authorUser:
  session.userId` at every call site, never from `msg`/`ops` — and
  `OpsMessage` (API Spec §3.5) structurally carries no author/user field
  at all for a payload to even smuggle one through. `permissions.test.ts`'s
  own SEC-03 test documents this as a structural property of the code
  (the test's own `session` object is the ONLY identity source
  `commitOperations` is ever given in that call), not a new runtime
  check — there was nothing to build here, only to confirm and cite.

  **New REST endpoints** (`db/documentStore.ts`'s `grantPermission`/
  `revokePermission`/`transferOwnership`; `documentService.ts`'s
  `grantPermissionForUser`/`revokePermissionForUser`/
  `transferOwnershipForUser`; `httpApp.ts`'s three new routes), all behind
  Phase 27's own `requireAuth`:
  - `PUT /v1/documents/{id}/permissions/{userId}` — owner-only; body
    `{role}` restricted to `GRANTABLE_ROLES = ["editor", "viewer"]`
    (never `"owner"` — ownership can only ever be TRANSFERRED, via POST
    `/owner`, never granted through a plain upsert); upserts via the
    table's own PK `(document_id, user_id)`; 409
    `cannot_change_own_owner_role` if the caller (necessarily the owner,
    already checked) targets their OWN id — the endpoint was never
    designed to let ownership simply vanish via a role change; 404
    `user_not_found` if the target isn't a real user; response
    `{documentId, userId, role, grantedBy, grantedAt, effectiveAtSeq}`,
    with `effectiveAtSeq` read from `documents.current_seq` (the durable
    column) right after the grant commits — "the document sequence at
    commit," per §4.7's own wording.
  - `DELETE /v1/documents/{id}/permissions/{userId}` — owner-only; 409
    `cannot_revoke_owner` if the target's current role is `'owner'`
    (ownership can only move via POST `/owner`, never simply be
    removed); 404 `user_not_found` if the target has no permission row
    at all (nothing to revoke); 204 on success.
  - `POST /v1/documents/{id}/owner` — owner-only; body `{newOwnerId}`;
    409 `target_has_no_access` if the target has no EXISTING permission
    row (must already have some access before receiving ownership); 200
    with the document's updated summary, the CALLER's own new role now
    `"editor"` (the transaction demotes them as part of the same atomic
    operation).

  **SEC-07's atomicity — real, live proof, not an inference from reading
  the transaction**: `transferOwnership` (`db/documentStore.ts`) wraps a
  `SELECT user_id FROM document_permissions WHERE document_id = $1 AND
  role = 'owner' FOR UPDATE` at the START of its transaction — this locks
  the current owner's own row for the transaction's full duration,
  serializing every concurrent transfer attempt against the SAME document
  into a strict queue. Whichever transaction acquires the lock first
  re-checks (under the lock, never from an earlier, possibly-stale read)
  that the caller is STILL the owner; every other transaction that later
  acquires the same lock finds a DIFFERENT owner already in place and
  returns `"not-owner"` (mapped to the ordinary 403 `permission_denied` —
  the caller simply isn't/is-no-longer the owner, same status a stale
  check would have produced anyway). This is what makes "exactly one of
  N concurrent requests succeeds" a database-ENFORCED guarantee, not an
  application-level hope. Demote-then-promote (never the other order)
  means the transaction never holds two `'owner'` rows at once (which
  `docperm_single_owner_idx` would refuse regardless) and never holds
  zero for longer than the gap between its own two UPDATE statements,
  itself inside the same lock-serialized transaction.

  **Verified for real** (`db/permissions.db.test.ts`, against a real,
  migrated Postgres instance, `pnpm test:db`): 50 concurrent `POST
  .../owner` requests to 50 DIFFERENT targets on the same document,
  alongside a live, running 10ms-interval poller of
  `document_permissions` for the WHOLE duration of the burst (not a
  before/after snapshot) — **observed, real result: the poller never once
  saw zero or two simultaneous owners, exactly 1 of 50 requests returned
  200, the other 49 returned 403, and the original owner's own row ended
  up exactly `'editor'`** (never vanished, never left as `'owner'`).
  Alongside this: full PUT/DELETE/POST-owner coverage (owner-only
  enforcement, every named 400/403/404/409 outcome, upsert-changes-the-
  same-row behavior) and, in `permissions.test.ts` (no Postgres needed —
  pure in-memory `DocumentCoordinator`/`CoordinatorSession` fixtures,
  the same pattern `writePath.test.ts` already established for Phase
  24's RC-32 coverage), SEC-01 (VIEWER rejection + security log, AND the
  live-downgrade-takes-effect-on-the-very-next-operation scenario that
  is this phase's own Goal made concrete), SEC-02 (identity mismatch +
  security log), SEC-03 (attribution structural proof), and SEC-06 (the
  cache's own TTL/invalidation behavior, both sides of the boundary).

  **DoD verification, all against the real, merged code**: `pnpm -r exec
  tsc --noEmit` clean across all 6 packages; `pnpm eslint` clean for
  every file this phase touched; the full default `pnpm test` (workspace-
  wide) re-run clean at **483/483 across 54 files** (up from 474/53 at
  the end of Phase 27 — the +9 are this phase's own new
  `permissions.test.ts` (6) and `documentService.test.ts`'s 3 new
  `isGrantableRole` cases; 2 disclosed, pre-existing skips, unchanged)
  after every change, confirming zero regressions from this
  phase's shared-file edits (`documentCoordinator.ts`, `writePath.ts`,
  `httpApp.ts`, `documentService.ts`, `db/documentStore.ts`, `index.ts`);
  `db/documents.db.test.ts` (9/9), `db/durability.db.test.ts` (9/9), and
  `db/schema.db.test.ts` (7/7) re-run clean against real Postgres,
  confirming no regression from this phase's own shared-file changes;
  `db/permissions.db.test.ts` (4/4, including the real SEC-07 burst
  above) and `permissions.test.ts` (6/6) both new and passing;
  `db/auth.db.test.ts` (12/12) re-run clean, confirming no regression
  from this phase's shared-file changes there either.

  **A pre-existing, UNRELATED regression check finding, confirmed not
  caused by this phase**: re-running `db/audit.db.test.ts` and
  `db/gc.db.test.ts` (both exercise a 100,000-operation document) as part
  of this phase's own broader regression sweep, both now TIME OUT
  entirely at that scale (previously slow but completing — e.g. Phase 21's
  own account measured the M8-c scenario completing; Phase 18's 100k-op
  audit measured ~13 seconds) — this phase touched none of
  `engine.ts`/`gcScheduler.ts`/`audit.ts`/`operationStore.ts` (confirmed
  via `git status`: this phase's own diff is scoped entirely to
  `documentCoordinator.ts`, `writePath.ts`, `httpApp.ts`,
  `documentService.ts`, `db/documentStore.ts`, `index.ts`, plus two new
  test files), so this is the SAME already-disclosed, already-tracked
  Fugue O(N²) sequential-insertion cost (Open Item 3) continuing to
  worsen at 100,000-op scale as more phases' own fixtures exercise it —
  not a new finding, and not this phase's own regression. Left exactly
  as found, per this project's own established precedent (Phase 27's
  identical treatment of `snapshots.db.test.ts`'s 50,000-op slowdown) —
  fixing it means Open Item 3's own deferred balanced-storage redesign,
  not a Phase 28 fix.

  **PERMISSION_CHANGED push — built structurally correct, with a
  disclosed limit on what it actually reaches today**
  (`httpApp.ts`'s `pushPermissionChanged`,
  `DocumentCoordinator.getSessionsByUserId`): API Spec §4.7/§4.8's own
  "publishes an authorization invalidation and pushes PERMISSION_CHANGED
  to every open session for that user on that document" is implemented
  by matching `CoordinatorSession.userId` — but that field is still a
  fresh `randomUUID()` minted per WS connection (Phase 8/16, completely
  unchanged this phase, per the resolved design decision above), never a
  real authenticated identity. **In production today, a REST-
  authenticated `userId` (from a real JWT) will structurally never match
  any live WS session's own `userId`, so this will typically find
  nothing to push to.** The mechanism itself — find every open session
  for a given user on a given document, invalidate its cached
  authorization decision, update its live role, and enqueue a real
  PERMISSION_CHANGED control frame — is real, correct, and exactly what
  Phase 29's real ticket-based admission needs the moment WS sessions
  carry a real userId instead of a random one; disclosed here rather
  than silently built and left undocumented, the same "known interim
  behavior" treatment Phase 16's own auto-provisioning callout received.

  **What is deliberately NOT built this phase**: any REAL linkage between
  a REST-authenticated user identity and a WS session's own identity —
  that is Phase 29's own job in full (real ticket-based admission,
  `HelloMessage.ticket` finally validated); a UI for any of this
  (`ConnectionIndicator.tsx`/`EditorView.tsx` untouched); a real DB-backed
  per-user lookup behind `authorizeSession` (still `session.role !==
  VIEWER`, exactly as Phase 24 left it — only the CACHING/re-evaluation
  SHAPE around it is new); any endpoint to LIST who has access other than
  the pre-existing owner-only `permissions` field on `GET
  /v1/documents/{id}` (Phase 27).

## 🛑 CRITICAL, OPEN, UNRESOLVED FINDING — READ THIS FIRST (2026-09-05)

**The core convergence guarantee is currently known to be BROKEN under
ordinary, non-adversarial real-world use — not just under fault
injection.** Phase 25's DUR-05/06 DoD verification found a real, severe
bug in `Engine.integrate()` (`packages/engine/src/engine.ts`), root-caused
across FOUR permanent regression fixtures — `tests/regression/R0008`,
`R0009`, `R0010`, `R0011` — the last of which (R0011) reproduces with
**zero duplication, zero reordering, zero drops** — pure, ordinary
per-sender-FIFO network delivery to 4 replicas, differing only in
ordinary, unavoidable per-peer latency variance, is sufficient to trigger
either a thrown structural-sanity canary or (confirmed separately, via an
independent hand-trace against production Yjs's own real source) a
**silent, undetected document divergence with no crash and no signal at
all**.

**Status of the investigation, in order**:
1. R0008 and R0009 (Phase 20) were each fixed with a targeted rank-check
   patch to this project's own hand-derived Case A/B/C scan.
2. R0010 (Phase 25 pivot) found a THIRD, structurally distinct gap in
   that same hand-derived scan — not a per-branch omission but a
   violation of TRANSITIVITY (two nodes never directly compared can end
   up in opposite relative order on different replicas). Given three
   bugs in the same family, the scan was REPLACED OUTRIGHT with a
   faithful port of the real, published, peer-reviewed YATA algorithm
   (Kleppmann; verified directly against Sypytkowski's reference
   implementation source). This fix was verified via 70,000+ convergence
   fuzz seeds (all 7 configs, zero divergences), all 22 adversarial
   cases, the full property suite, the PositionIndex cross-check, and a
   mutation matrix that went from 9/10 to 10/10 kills.
3. R0011 (same day) found that even the real YATA port still exhibits
   the identical transitivity defect, and — critically — does NOT
   require any fault injection to reach it at all, only ordinary network
   latency variance between independent peers. A SEPARATE, independent
   hand-trace of production Yjs's own actual `Item.js` source (fetched
   directly from https://github.com/yjs/yjs, not recalled from memory)
   confirmed Yjs's real, shipped algorithm has the SAME defect — it
   fails silently (no crash) rather than throwing, which is worse.
4. **Why this was never caught by this project's own 70,000+-seed
   convergence fuzz suite**: none of the 7 fuzz configs (C1-C7) model
   the delivery pattern R0011 needs — independent, per-TARGET delivery
   latency (the same broadcast operation reaching different peers at
   different points in each peer's own local timeline). C1-C6 use one
   global end-of-trial shuffle; C7 (added specifically to close
   R0008/R0009's own gap) broadcasts to every peer immediately and
   synchronously. This is a real, load-bearing gap in this project's
   own primary safety net, not just in the algorithm.
5. Given FOUR distinct failures found across the SAME algorithm family
   (this project's own hand-derived scan, AND the real, published YATA
   algorithm, AND production Yjs's own actual shipped code), the
   decision was made to STOP patching YATA-family algorithms and
   seriously investigate Fugue (Weidner & Kleppmann, "The Art of the
   Fugue: Minimizing Interleaving in Collaborative Text Editing",
   arXiv:2305.00583) as of 2026-09-05.

**FUGUE INVESTIGATION RESULT (2026-09-05): Fugue passes all four
regression cases plus RFC NQ-2, verified via a faithful port of the
paper author's own real reference implementation** (fetched directly
from `https://raw.githubusercontent.com/mweidner037/fugue/main/fugue-simple/src/index.ts`
— Weidner's own repo, the `fugue-simple` package — not recalled from
memory or reconstructed from the paper's prose alone; stripped only of
`@collabs/collabs` framework plumbing (`CPrimitive`/`InitToken`/
`MessageMeta`/gzip save-load), with the `Tree`/`insert`/`delete`/
`addNode`/`traverse` algorithm kept byte-for-byte):
  - **R0008**: all 24 delivery-order permutations (buffered on missing
    causal dependencies, same discipline as `Engine.applyRemote`'s own
    `pending`/`drain`) converge to `"it"`.
  - **R0009**: all 6 delivery orders converge to `"pit"` (a different
    literal string than the YATA port's own `"itp"` — expected and
    harmless, since Fugue's tie-break rule differs from YATA's; what
    matters is that it is the SAME string every time).
  - **R0010**: out-of-FIFO delivery to the reordered replica converges
    to the identical text (`"ghdfec"`) as natural in-order delivery.
  - **R0011 (the highest-priority case — the one requiring NO fault
    injection at all)**: full 4-replica closure, replaying the exact
    same mint/delivery sequence that broke both this project's YATA
    port and production Yjs, converges to the IDENTICAL text
    (`"doibgahj"`) on all 4 replicas, with zero throws anywhere.
  - **RFC NQ-2** (the original non-interleaving motivation for moving
    away from a naive scan): backward-typed concurrent runs from two
    replicas stay fully contiguous and converge identically
    (`"cbazyxX"`), matching this project's own existing worked trace.

**Structural reason Fugue avoids this whole defect family, confirmed by
reading its algorithm, not just its results**: unlike YATA (and this
project's own prior hand-derived scan), a Fugue node's `parent`+`side`
are decided ONCE, at creation, and NEVER RECOMPUTED — there is no
"scan window between two origins" that must be re-resolved against
CURRENT positions on every `integrate()` call. A new node's placement
depends on exactly ONE existing reference point's own (monotonically
growing, never-invalidated) child structure, never on the CURRENT
relative position of two SEPARATELY-tracked origin nodes. The total
order is a pure function of fixed parent/side/sibling-order
relationships (in-order tree traversal), which by construction can
never invert, because there is no pair of "boundary" identifiers whose
resolved positions could drift out of relative order the way YATA's
recomputed `leftIndex`/`rightIndex` (or Yjs's own live-pointer walk,
independently confirmed to have the identical defect) can.

**UPDATE (2026-09-05, later the same day): the real Fugue port has now
been MERGED into `engine.ts` and the surrounding engine/testkit code —
this is no longer a gated scratch verification, it is the live
algorithm.** Full file-by-file account:

- **`packages/engine/src/node.ts`/`operation.ts`**: `originLeft`/
  `originRight` replaced with `parent: Identifier | null` + `side: "L" |
  "R"` on both `Node` and `InsertOperation`. This is a wire-shape change
  (disclosed, out-of-session-scope ripple into `packages/protocol`'s
  `snapshotBody.ts`/block codec, which still references the retired
  `Block`/`originLeft`/`originRight` shapes and will not typecheck until
  a future phase redesigns them for a tree structure).
- **`packages/engine/src/fugueTree.ts`** (new): the real `FugueTree`
  class — ported from the same real reference source cited above —
  `attach`/`decidePlacement`/`setDeleted`/`nodeAtVisible`/`toArray`/
  `remove` (Phase 21's GC primitive, throws on a node with surviving
  children). `siblingRank(n) = [n.bind ? 0 : 1, n.id.r]` is the Engine
  Spec I8 substitution, verified against the real ADV-17 test.
- **`packages/engine/src/engine.ts`**: fully rewritten around
  `FugueTree` — `integrate()`/`rank()`/`compareRank()` no longer exist
  in any form; `ready()` now checks a single `parent` dependency;
  `collect()` (Phase 21 GC) restated as a single-reference fixpoint,
  physical removal now an iterative leaves-first loop calling
  `tree.remove()`.
- **`packages/engine/src/invariants.ts`**: I2/I4/I6/I8 restated in terms
  of `parent`/`side`; the I2 block-split carve-out (Phase 20) is gone —
  Fugue's `parent` is truly, permanently immutable.
- **Retired outright** (deleted, not adapted — Fugue's tree structure has
  no field-rename-compatible analogue): `positionIndex.ts` + both its
  test files (Phase 19), `block.ts`/`block.test.ts` (Phase 20),
  `packages/testkit/src/benchmark/compression.ts`/`.bench.test.ts`
  (Phase 20). `packages/engine/src/index.ts` no longer exports
  `Block`/`canFollowInBlock`/`decodeBlock`.
- **A real bug found and fixed during this merge, via the project's own
  I4 invariant firing**: `FugueTree`'s root sentinel node
  (`{c:0,r:0}`) was leaking through as a real parent identifier instead
  of `null`, because the original free-function `toPublicNode` couldn't
  compare against `this.root`. Fixed by making it a private class
  method with `this.root` in scope. Caught immediately by
  `engine.test.ts`'s GC tests throwing `I4 violated: node 1:1's parent
  0:0 is not present`.
- **A real, severe, DISCLOSED performance finding, NOT a bug in the
  translation**: the real reference implementation's `updateSize()`
  walks every ancestor on each `attach()` call. Sequential typing (the
  most common real editing pattern) builds a maximally unbalanced,
  deep right-child chain, giving O(N) per insert / O(N²) total —
  measured directly (0.031ms/op at N=500 → 0.069ms/op at N=4000, growing
  per-op cost confirming quadratic total cost). **Per the user's explicit
  direction, this is EXPLICITLY DEFERRED to its own future dedicated
  session** — a balanced-storage/treap-backed redesign that decouples
  Fugue's placement DECISION from its STORAGE/QUERY layer. Two
  90,000-node pathological GC-chain tests in `engine.test.ts` and
  `gcSafetyCap.bench.test.ts`'s own test are `it.skip`'d with detailed
  disclosure comments citing this measurement — not silently reduced or
  hidden.
- **Mutation matrix redesigned, honestly, not force-fit**:
  `M2_no_right_bound`/`M3_no_case_c` (Test Plan §2.8's original mutants)
  targeted the retired YATA scan's own window-bookkeeping, which Fugue
  has no analogue of — both are explicitly OMITTED from
  `packages/testkit/src/mutation/mutants.ts`'s `MUTANTS` array (with a
  header comment explaining why), not invented under this project's own
  authority. The other 8 were re-derived/retargeted (M1/M4 →
  `fugueTree.ts`'s `siblingRank`; M7 renamed `M7_no_readiness_check`,
  since Fugue's `ready()` has only one dependency to drop, not one of
  two; M5/M6/M8/M9/M10 mechanically retargeted). **Result: 8 of 8
  mutants killed, no survivors** — confirmed via a real run of
  `pnpm test:mutation` (task `bw33e7jr1`, 85.4s wall time, exit 0).
  `generateReport.ts`'s MUT-KILL-01 section had a stale hardcoded
  message assuming M3 always exists; fixed to check for its absence and
  print an accurate explanation instead.

**Verification completed so far, against the REAL merged `engine.ts`**
(all at whatever scale is safe for the O(N²) reference algorithm, per
the user's explicit "cap the scale, say so explicitly" instruction —
correctness-first, balanced-storage redesign deliberately deferred to
its own session): `packages/engine`'s own test suite (38/38, 2 disclosed
skips), R0008/R0009/R0010/R0011 all re-verified exhaustively against the
real merged engine, `pnpm test:adversarial` (22/22), `pnpm
test:properties` (6/6), `pnpm test:mutation` (8/8 killed as above).

**RESOLVED (2026-09-05, later still the same day): every remaining
verification item is now confirmed against the real, merged
`engine.ts`.**
1. `pnpm test:convergence` (all 7 configs, full 10,000-seed-per-config
   budget, 70,000 total) — ran to completion: **70,000/70,000 seeds
   converged, zero divergences, zero stuck-pending, zero errors, across
   all 7 configs** (74.3 minutes wall time — notably slower than the
   pre-Fugue baseline of ~34-45 minutes for the same seed count, an
   expected, disclosed consequence of the tree's per-operation
   allocation/ancestor-walk overhead described above, not a correctness
   concern).
2. `fugueTree.crosscheck.test.ts` — re-run in genuine isolation (machine
   confirmed at 0 running `node.exe` processes beforehand) once the
   convergence job above finished: **passes cleanly, 3,000/3,000 seeds,
   zero disagreements** with the independent linear-scan oracle, in
   83.4s. The two earlier "Worker exited unexpectedly" crashes are
   RETRACTED as a genuine bug or resource-contention finding — both were
   an artifact of this session's own diagnostic tooling: the first
   confirmed run used a `timeout 60` wrapper that killed the vitest
   worker before it could finish (this test genuinely takes ~85s under
   Fugue's real per-op overhead, not the few seconds a flat-array
   comparison would take), which Tinypool then reported as "Worker
   exited unexpectedly" — a symptom of the forced kill, not an
   independent crash. Recorded here explicitly per this project's own
   "retract a claim on direct challenge rather than let it stand"
   discipline (Phase 14's own precedent).
3. `pnpm test:mutation` re-run once more after the `generateReport.ts`
   fix (a separate run, task `bw33e7jr1`'s own output predates that fix)
   to confirm the regenerated `docs/mutation-matrix.md` now prints the
   correct M2/M3-omission explanation rather than the old stale
   "M3_no_case_c was killed by another suite" text: **confirmed correct
   in the freshly regenerated file** — 8/8 mutants killed, MUT-KILL-01's
   section now reads "Not applicable as of the Fugue port... Both
   mutants are currently OMITTED," and the Summary section carries the
   explicit omission line.

**Every item from the user's own verification checklist (all 22
adversarial cases, all worked traces, all 5 property suites, R0008-R0011
exhaustive coverage, the full 70,000-seed convergence suite, the full
mutation matrix, the Phase 19/20-equivalent structural cross-check) is
now confirmed passing against the real, merged `engine.ts`.** The
balanced-storage/O(log N) performance redesign remains real, necessary,
explicitly deferred follow-up work for its own dedicated future
session — not a blocker to this investigation's own correctness
conclusion. Full technical detail, hand-traces, and citations: the four
regression fixtures above.

## ✅ PHASE 25 UPDATE (2026-09-06) — Item 1 fixed, DUR-06 root-caused and fixed, six real bugs found and fixed in one continuous session

This entry picks up exactly where the 2026-09-05 session left off (Item 1
above), and covers the full chain of investigation that followed, in
order. It does not replace anything in the sections above — R0008/R0009/
R0010/R0011 and the Fugue migration are unchanged and remain the
authoritative account of that part of the story. This entry is the
continuation: what happened once integration work resumed on top of the
newly-merged Fugue engine.

**Six distinct, real bugs were found and fixed across this investigation,
in the order discovered:**

### Bug 1/2 — R0008/R0009 (Case B/C rank-check gaps) and R0010/R0011 (transitivity violation → the Fugue migration)

Already fully documented above (the "🛑 CRITICAL, OPEN, UNRESOLVED
FINDING" and "Engine Spec §4.3 replaced by the real YATA algorithm"
sections). Listed here only for completeness of the chronological
account — no new information, cross-referenced rather than repeated.

### Bug 3 — Item 1's own integration breakage (`packages/protocol`/`server`/`client` never updated for `parent`/`side`)

Confirmed and fixed as the very first task of this session. Every call
site that still referenced the retired `originLeft`/`originRight` shape
(`wireHelpers.ts`, `syncClient.ts`, `expand.ts`, `snapshotBody.ts`/
`snapshotSeed.ts`, and their respective test fixtures) was updated to the
real `parent`/`side` shape. `snapshotBody.ts`'s block run-length wire
format — which had no Fugue-tree analogue at all (Item 5 in the section
below) — was genuinely redesigned, not merely renamed, for a tree
structure. Verified: `pnpm typecheck` clean across all 6 packages;
`pnpm test` passing in full (the 64/407 failures documented in Item 1
below are gone). This item is **RESOLVED** — see the updated Item 1
status in the open-items list below.

### Bug 4 — `writePath.ts` ignored `Engine.applyRemote`'s `{buffered: true}` return, violating "acknowledgement implies durability"

This is DUR-06's actual server-side root cause, found and fixed BEFORE
the client-side seq-tracking mirror fix (Bug 7 below) — the client fix was
always described as "mirroring an earlier server-side writePath.ts fix,"
and this is that fix, now fully documented. `Engine.applyRemote()` can
report an operation as buffered — its causal dependency hasn't arrived
at the SERVER yet (e.g. a concurrently delayed/dropped peer operation
under DUR-06's own fault rates). Before this fix, `processIncomingOperation`
ignored that return value entirely: it broadcast, assigned a seq to,
committed, and acked the operation regardless — handing peers an
operation whose own dependency the SERVER ITSELF didn't have yet, with a
`coordinator.currentSeq` that had already raced ahead of it. If that
dependency was later permanently dropped, this became a permanent
orphan, and even when the dependency arrived shortly after, a seq
reserved for a not-yet-integrated operation broke CATCHUP's own
`seq > lastServerSeq` contract for anyone querying that range in the
gap.

**Fix**: `processIncomingOperation` now branches on whether every
operation in the incoming message applied cleanly AND no OTHER,
previously-buffered operation resolved as a side effect of this
message's own `Engine.drain()`. The common case (`runFastPath`) is
byte-for-byte the previously-existing code. The new `runSlowPath`
assigns seq LAZILY, only at the moment an operation is actually
finalized (never reserved up front for something still sitting in
`engine.pending`); records a delete's GC context (Phase 21, Engine Spec
§7.3) via the new `Engine.setDeleteContext()` at that same moment (seq
isn't known at `applyRemote` time under this design); recovers a
side-effect-resolved operation's ORIGINAL sender identity via a new
`DocumentCoordinator.pendingOpOrigin` map (populated the instant
`applyRemote` reports `buffered: true`, since the session handling a
LATER message has no other way to know whose earlier operation just
finalized); and broadcasts/commits/acks each finalized operation
individually, since a mixed-readiness batch has no single compact
run/batch wire shape left to relay.

### Bug 5 — a real out-of-order-commit race, found via the `InMemoryOperationStore`-backed DUR-05/06 tests while hand-tracing Bug 4's own fix (the `enqueueCommit`/`lastCommittedSeq` fix)

Note on naming: this is the bug referred to elsewhere as "the
`InMemoryOperationStore` commit-ordering bug" — the race is not in that
store's own internal logic (its `commitOperations` is a synchronous
array push with no `await` inside it at all) but in what surfaces
THROUGH it: `processIncomingOperation`'s own `await` on ANY store's
`commitOperations` call — including an already-synchronously-resolved
one — still yields to the microtask queue at that point, so two
overlapping `processIncomingOperation` calls for the same document can
still have their POST-await continuations run in a different order than
their seq-reservation order. This is exactly what the DUR-05/06 tests
(which use `InMemoryOperationStore`) surfaced. The fix below applies at
the `DocumentCoordinator` level and protects correctness regardless of
which store is used underneath.

Hand-tracing Bug 4's fix for two-author interleaving surfaced this
second, related gap: nothing previously prevented two concurrent
`processIncomingOperation` calls (for the SAME document) from reserving
seq ranges in one order but completing their own `commitOperations` awaits
in the OPPOSITE order — Node's single-threaded synchronous seq-reservation
step guarantees reservation order, but the actual database commit is
awaited, and two overlapping awaits can resolve in either order. A
reconnecting client's CATCHUP is built from `documents.current_seq`
(or, after Bug 4's fix, the analogous "highest reserved" value), so a
client could be told its CATCHUP delta goes all the way through seq N
when the row for some seq M < N genuinely hasn't committed yet — a
permanently, silently skipped operation, no error, no signal.

**Fix**: `DocumentCoordinator.enqueueCommit(endSeq, fn)` — a per-document
FIFO promise chain that serializes EVERY `commitOperations` call for that
document, so commit EXECUTION order is always identical to commit
RESERVATION order regardless of how many concurrent messages interleave
or which write-path branch (fast or slow) they take. A new
`DocumentCoordinator.lastCommittedSeq` field (updated only on the
`enqueueCommit` queue's own success continuation, deliberately never via
`Math.max`, since the queue's strict ordering already guarantees
monotonically increasing values) is what `handshake.ts`'s
`buildCatchupMessages` now reads for CATCHUP's own `toSeq` bound — never
raw `currentSeq` — so CATCHUP can only ever promise a reconnecting client
what has actually, durably committed, never what merely has a seq number
reserved for it. On a commit failure, `lastCommittedSeq` is deliberately
left exactly where it was (not advanced), matching writePath.ts's own
pre-existing "no ack for a commit that failed" reasoning — this makes
CATCHUP's own promise honest about a real, already-accepted risk, rather
than introducing a new failure mode.

### Bug 6a — a replica-id-reuse-after-restart bug, found via DUR-03's own crash-injection test

Not anticipated in advance — found by DUR-03's own "restart, then
reconnect every client" step (see the DUR-02/03/M8-a/M8-e status
paragraph below for that file's own scope): a freshly-restarted `DocumentCoordinator`'s in-memory
`allocateReplicaId()` counter always restarts at 1, but `sessions` rows
are permanent (Phase 16) and never deleted — so the first client to
(re)join after a real restart could be handed a replica id a
still-existing `sessions` row for that SAME document already used before
the restart, violating `sessions_replica_uq` the moment that new
session's first operation tried to auto-provision its own session row.
**Fix**: `WarmStartResult` gained `nextReplicaId` (`MAX(sessions.replica_id)
+ 1` for the document, or `1` if no session row exists yet), computed
during warm start and used to seed the coordinator's counter after a
restart — guaranteeing the next allocation can never collide with an
already-used one for this document. (This does not persist replica-id
allocation across a restart in general, only protects the boundary
case — a still-disclosed gap, unchanged from before.)

### Bug 6b — a bigint-as-string arithmetic bug, found while building Bug 6a's own fix

`sessions.replica_id` is `BIGINT` (Phase 15 schema); `node-postgres`
returns `BIGINT` columns as JavaScript strings, never numbers, specifically
to avoid silent precision loss. The first version of the `nextReplicaId`
query treated the returned `MAX(replica_id)` as already numeric and added
1 to it directly — producing STRING CONCATENATION (`"30" + 1 → "301"`)
instead of arithmetic, the instant any document's first restart actually
exercised this query against a real, non-null `MAX`. Fixed by an explicit
`Number(...)` conversion before the arithmetic.

### Bug 7 — the client-side seq-tracking bug (`SyncClient`'s TCP-cumulative-ack redesign)

The client-side mirror of Bug 4, described in full in this session's own
prior turns and unchanged here: `SyncClient`'s tracked `lastServerSeq`
(HELLO's own field, driving CATCHUP's `fromSeq` on the next reconnect)
was advancing to a frame's claimed seq range regardless of whether every
operation in that frame actually applied (`Engine.applyRemote` returning
`buffered: true` client-side, the same class of gap as Bug 4's
server-side version). Fixed via a TCP-cumulative-ack-style design:
separate CATCHUP-path (`catchupPendingSeqs`/`catchupHighestSeqSeen`/
`recomputeCatchupSeqCeiling()`, a "trust the jump" ceiling — CATCHUP is
durable-log-driven, so a jump is never itself suspect) and LIVE-path
(`liveConfirmedSeqs`/`livePendingSeqs`/`advanceLiveSeqCeiling()`, a
strict one-at-a-time contiguous walk requiring ACK-based crediting for a
self-authored gap) tracking, plus a `handshakeGeneration` guard against a
stale `handshakeGate` continuation racing a newer reconnect. Verified via
a dedicated new regression file, `syncClient.appliedSeqCeiling.test.ts`
(3/3 passing, covering mixed readiness within one frame, drain-side-effect
resolution, disconnect-while-buffered, and a stale-handshake-generation
guard).

### Bug 8 — the wire-protocol run-coalescing bug (`operationsToRunMessages`)

The final piece, closing DUR-06's remaining ~50% permanent-stall rate
after Bugs 4-7 had already fixed the seq-ceiling/commit-ordering side of
the investigation. `operationsToRunMessages` (`wireHelpers.ts`) coalesced
consecutive insert operations into one `OP_INSERT_RUN` using ONLY
`ops[j].bind === ops[i].bind` as its grouping condition — never verifying
the actual parent-chain relationship `expandInsertRun`'s decoder hardcodes
for every run member after the first (`parent === previous.id && side ===
"R"`). That relationship genuinely holds for this function's ORIGINAL
caller (`SyncClient.localInsertText`'s synchronous typing burst — proven
by tracing `FugueTree.decidePlacement`: the left-origin at each
subsequent position is always the just-minted previous character, which
always has zero right-children at that instant) but was never guaranteed
for its Phase 24 caller, `operationsToWireMessages`, used by
`finishHandshakeAfterAlreadyHave` to coalesce `reconcileOfflineQueue`'s
independently re-anchored reconciliation resends. Two reconciled inserts
sharing consecutive counters (inevitable — same engine, minted back to
back) and the same `bind` flag (near-certain for ordinary text) were
wrongly coalesced into one run, silently discarding every operation after
the first's true `parent`/`side` on the wire — genuine field-level node
corruption, requiring NO fault injection, delay, duplication, or
reordering to reach (any client reconnecting with 2+ unacked inserts that
don't happen to form a true chain triggers it).

**Fix**: `operationsToRunMessages` now requires a genuine chain (`next.bind
=== prev.bind && next.side === "R" && next.parent` matches `prev.id`,
plus explicit counter-contiguity as a belt-and-suspenders check) between
EVERY adjacent pair before coalescing, falling back to individual
`OP_INSERT` messages at any break. Hand-traced against three specific
concerns before implementation (all confirmed sound): (1) both call
sites — the original synchronous-typing-burst caller is provably
unaffected (the chain always holds there); (2) a mid-batch chain break
splits correctly into multiple runs/individual messages via the natural
behavior of a greedy left-to-right scan, never over-merging or
degrading to all-individual from one break; (3) wire efficiency for the
common path is unchanged (a 2,000-character paste still coalesces into
exactly one frame). New permanent regression tests in
`wireHelpers.test.ts` (the corruption case, now fixed; a genuine-chain
case; a partial-break case; a wire-efficiency-unregressed case).

### Full verification (2026-09-06), all against the real, fully-integrated codebase

- `pnpm typecheck`: clean across all 6 packages.
- `pnpm test`: **417/417 passing**, 45 files, 2 disclosed skips (the
  deferred O(N²) GC-chain tests, unchanged).
- `pnpm test:reconnection`: **35/36 passing** — the 1 failure (RC-27's
  own 20-repeated-reconnection p95 timing stress test) is a **pre-existing
  flake, not a regression from any of today's fixes**: the identical
  failure signature (`waitForState: timed out after 10000ms waiting for
  "synced"`) occurred in this session's very FIRST `pnpm test:reconnection`
  run, before any code was touched today. Re-confirmed via two further
  isolated re-runs (no concurrent load) — both still failed, alternating
  between `waitForState` and `waitForTextLength` timeouts at different
  points within the 20-iteration loop, consistent with a real-timing flake
  under sustained load (plausibly compounded by the already-disclosed,
  already-deferred Fugue O(N²) sequential-insertion cost — see Item 3
  below), not a deterministic logic bug. Every other cell in the 27-cell
  matrix, plus RC-28/33/34, passed cleanly, both before and after today's
  fixes.
- **DUR-06: 10/10 clean runs** (1 initial + 7-run loop + 2 post-cleanup
  runs), each completing in 6-14 seconds — a complete reversal from the
  ~50% permanent-stall rate this investigation started from. DUR-05: 2/2
  clean.
- Temporary DUR-06 diagnostic instrumentation (the `reconnectAttemptLog`,
  node-set/deleted-flag/base64-text/field-level comparison blocks) removed
  from `adverseNetwork.test.ts`; the temporary 700s test-timeout bump in
  `vitest.adverseNetwork.config.ts` reverted to 400s.

**Item 1 and Item 2 from the 2026-09-05 open-items list below are both
RESOLVED as of this session** — see the updated list.

**DUR-02/DUR-03/M8-a/M8-e status, reviewed but deliberately NOT executed
this session** (per explicit user instruction — picking these up fresh
next session): all four already exist as complete, real implementations
in the working tree, not partial/scaffolded work —
`packages/server/src/db/dur02LedgerReconciliation.db.test.ts` (a real
12,000-operation, 4-client ledger-reconciliation test against a real
Postgres instance, with all three DUR-02 assertions implemented
verbatim); `packages/server/src/db/dur03CrashInjection.db.test.ts` (100
repetitions across all 10 named crash sites, using the real
`testOnlyCrashInjection.ts` registry — confirmed genuinely wired into
`writePath.ts`/`operationStore.ts`/`snapshotter.ts`/`gcScheduler.ts`, not
merely defined and unused); `packages/server/src/db/soak.db.test.ts`
(M8-e, an honestly-disclosed scoped-down 30,000-operation soak in place
of the reference text's 24h/10^6-op target, with the reduction's
rationale documented in the file's own header, matching this project's
established disclosure convention); and
`packages/testkit/src/benchmark/finalMemoryLatency.bench.test.ts` (M8-a,
memory before/after Phase 21's real GC plus `applyRemote` apply-latency
on the post-GC document, both against a real `Engine`). All four appear
ready to execute as-is; none were run this session per the user's
explicit instruction to pick this up in a fresh session instead.

## ⚠️ CRITICAL FINDING #2 — PARTIALLY ADDRESSED (found 2026-09-06, Option 2 fix shipped same day; Option 1 explicitly deferred)

**A live, continuously-connected client's ORDINARY keystroke can anchor
to a node the server has already garbage-collected, integrating content
locally that the server will never accept — no reconnection, no offline
queueing, no fault injection of any kind required.** Found while
investigating a Phase 25 M8-e soak-test failure
(`packages/server/src/db/soak.db.test.ts`: `coordinator.engine.pending.
length` was 1,400, not 0, after 30,000 real operations), then explicitly
generalized beyond that test's own simplified harness per direct
challenge from the user before this was allowed to be treated as "just a
test-fixture gap."

**STATUS, stated precisely — read before assuming this is either "open"
or "closed":** the underlying RACE itself is **NOT eliminated** — a live
client can still mint an operation anchored to a node the server has
since collected; that has not changed and is not something Option 2
touches. What HAS shipped, the same day, is a fix to the RACE'S OWN WORST
CONSEQUENCE: this used to be **silent and permanent** (the affected
user's own document showed content forever that no other replica would
ever see, with no indication anything was wrong). As of the Option 2 fix
below, in the common case (nothing else anchors to the affected content
yet when the rejection arrives), the client's own engine now genuinely
**reverts** the rejected insert and the user is told about it — the
divergence becomes bounded (up to the ~30s rejection latency) and
visible/recoverable, not silent and permanent. **The "cascading" case
(something was typed right after the rejected content before the
rejection arrived) is UNCHANGED — still a real, silent, permanent
divergence for that specific content, exactly as before.** The
structural fix that would eliminate the race entirely (Option 1, below)
is explicitly deferred to its own dedicated future session — **do not
treat this finding as fully closed.**

**Full permanent regression fixture**: `tests/regression/
R0012-2026-09-06-live-client-anchors-server-collected-tombstone.json`
(fully satisfies Test Plan §2.3 Rule 3 — a complete, deterministic,
5-operation stream, no timing/randomness needed) plus a permanent,
automated test, `packages/engine/src/regressionR0012.test.ts` (already in
the default `pnpm test` suite — currently asserts the BUG's own behavior
deliberately, so that a future fix changes its final assertions as a
visible, reviewed diff, never a silently-fixed gap nobody notices).

**The mechanism, in brief** (full account in the R0012 fixture and in
this session's own transcript):
1. Client and server converge on ordinary content. A character is
   deleted (fully ordinary). The server eventually GC-collects that
   tombstone once the stability frontier and undo-horizon conditions are
   met (RFC's own undo-horizon default, 5min/200-ops-per-replica, is
   EXPLICITLY flagged in the RFC as "unvalidated" — a heuristic delay,
   never a structural safety proof).
2. GC's own condition 3 ("nothing live still anchors this") is checked
   purely against the SERVER's current tree — it is structurally BLIND to
   operations a client has not yet minted or sent. This is not a bug in
   `collect()` itself; `collect()` is correct given what it can see.
3. No client ever runs its own GC, and the server never tells a client
   "I collected this" — so the client's own local tree keeps the
   tombstoned node forever, completely unaware anything changed
   server-side.
4. `FugueTree.decidePlacement`'s own `leftmostDescendant` branch (used by
   ordinary `Engine.localInsert()` — the exact call every live keystroke
   makes) performs NO `deleted` check. It can select that now-collected,
   still-locally-present tombstoned node as a brand-new operation's own
   `parent` — this is completely ordinary, expected Fugue behavior in
   isolation; nothing wrong with `decidePlacement` on its own either.
5. The client's own engine integrates this new operation SYNCHRONOUSLY at
   mint time (fundamental to this whole project's real-time-feel design
   since Phase 3/10) — the user sees their own edit succeed immediately,
   permanently, with no network round trip required.
6. The operation reaches the server; `applyRemote` finds its parent gone
   and buffers it in `engine.pending` — PERMANENTLY, since that parent
   will never exist again. `offlineWindowScheduler.ts`'s Rule 7.2 sweep
   (Phase 24) will eventually (default 30s) explicitly reject it
   server-side rather than leave it stuck forever, and `SyncClient`'s
   preserve-rule machinery (also Phase 24) will retain its CONTENT in
   `rejectedOps` rather than silently lose it — but **nothing currently
   reverts the character from the AUTHORING client's own visible
   document.** `Engine` has no "undo one specific already-integrated
   operation" primitive (Undelete's structural inverse, Phase 36, does
   not apply here and remains unbuilt regardless). The affected user's
   own screen keeps showing content that will never exist anywhere else,
   with no indication anything is wrong.

**Why this is a genuinely different class of finding than R0008-R0011**:
those were defects IN the CRDT placement/ordering algorithm itself
(YATA-family, since replaced by Fugue). This is not a placement-algorithm
defect at all — `decidePlacement` and `collect()` are each individually
correct per their own specifications. This is a gap in the INTERACTION
between three independently-correct components (GC's necessarily-local
view, an explicitly-heuristic undo horizon, and a client with no
"node was collected" signal or "revert my own op" mechanism) — fixing it
is a cross-component design decision, not a single-function algorithm
patch.

**Why Phase 24's own existing proof does not cover this**: that proof
(see this file's own "Key Technical Decisions" entry on
`reconcileOfflineQueue.ts`) is scoped SPECIFICALLY to the
reconnection-reconciliation code path, whose anchor-resolution functions
always re-resolve against CURRENT structure and therefore can never name
a stale identifier. Ordinary `Engine.localInsert()` — every live
keystroke, for a client that has NEVER disconnected — does not go
through that path at all.

**Fix decision (2026-09-06, same day): Option 2 chosen and implemented;
Option 1 explicitly deferred to its own dedicated future session,
tracked separately from (not merged into) Open Item 3's O(N²)→O(log N)
redesign — see the new Open Item 9 below.** Full tractability/risk
analysis for all three options is preserved below exactly as given to
the user before the decision, since it remains the accurate account of
why Option 1 is real, necessary, future work rather than something to
casually revisit:

- **Option 1 — make the undo horizon structurally safe, not just a
  heuristic delay.** Extend the stability-frontier mechanism so a node
  cannot become collectible until there is a real guarantee (not just
  elapsed time/op-count) that no CONNECTED client's own resident tree
  could still reference it as an origin for a future operation — e.g.
  extending each session's own tracked state beyond "acked seq" to cover
  "which node identifiers this session's own resident tree could still
  anchor to." Traced structurally (not just hand-waved) during the
  analysis: since a connected client's resident tree only ever GROWS
  (no client runs its own GC, and a client can legitimately reference
  content it received arbitrarily long ago for a brand-new local edit,
  with no time limit), true structural safety reduces to "never collect a
  node while any currently-connected session has ever seen it" — i.e.
  GC becomes gated on SESSION CHURN (disconnection), not on elapsed
  time/op-count. This is tractable (the needed data, `last_ack_seq`/
  watermarks, already exists) but is a genuine GC-eligibility redesign
  with real behavioral consequences (a document with long-lived,
  continuously-connected sessions could go a long time without
  collecting anything near the actively-edited region) requiring full
  re-verification of Phase 21's own M8-c/M8-d DoD tests plus new tests
  proving R0012 specifically can no longer occur. Comparable in scope to
  the already-deferred O(N²)→O(log N) balanced-storage redesign (Open
  Item 3) — a real, dedicated-session GC-design investigation, not a
  contained fix. **Deferred — see Open Item 9.**
- **Option 2 — accept the race can happen, make the CONSEQUENCE
  non-silent and non-permanent. CHOSEN AND IMPLEMENTED.** See the
  "Option 2 implementation" entry immediately below for the full account
  — a new `Engine.tryRevertLocalInsert()`/`FugueTree.tryRemoveLeaf()`
  pair (clean case: safe removal; cascading case: refuses, zero
  structural side effects) plus `SyncClient` wiring (reuses the existing
  `onRemoteOpsApplied` DOM re-render signal, plus a new dedicated
  `onLocalInsertReverted` notification channel and a `RejectedEntry.
  reverted` flag) — verified via a new targeted engine-level test (4
  cases: clean, cascading via a right child, cascading via a left child,
  already-gone) and a new `SyncClient`-level integration test (3 cases:
  clean revert end-to-end through a real `OFFLINE_WINDOW_EXCEEDED`
  OP_REJECT frame, cascading refusal, and rejected DELETEs explicitly
  left out of scope). Scoped to INSERTS only, as approved — a rejected
  DELETE is preserved exactly as before this fix, unchanged; reverting a
  delete would mean a real Undelete (Phase 36's own resurrection
  semantics), explicitly out of scope here.
- **Option 3 — something else.** Considered a server-initiated
  "confirm before collecting" handshake with connected sessions before
  physically removing a node; rejected as not better than Option 1 (adds
  real-time coordination latency to the GC path, and does not even fully
  close the gap — a session mid-confirmation-round-trip when it
  independently mints a new op is back to the same race) and not as
  contained as Option 2. Not pursued.

### Option 2 implementation (2026-09-06)

**`packages/engine/src/fugueTree.ts`**: new `tryRemoveLeaf(id): Node |
undefined` — a safe, NON-THROWING sibling of the existing GC-only
`remove()`. Returns the removed node if `id` currently has NO children
(left or right) — the "clean" case, identical unlink + size bookkeeping
to `remove()`. Returns `undefined` immediately, with ZERO structural
mutation, the instant EITHER children array is non-empty — the
"cascading" case (typically the same user's own very next keystroke,
chained via Fugue's own "attach right after the last thing I typed"
rule) — deliberately refusing rather than risk dangling that other
node's own `parent` reference (Engine Spec I4/I5).

**`packages/engine/src/engine.ts`**: new `tryRevertLocalInsert(id):
boolean`, a thin public wrapper delegating directly to
`tree.tryRemoveLeaf`. Deliberately does NOT touch `this.applied` — the
reverted id must never be treated as "safe to reapply," which holds
regardless of outcome, since this project's design never resends a
rejected operation under its own original identity anyway.

**`packages/client/src/sync/syncClient.ts`**: `handleOpsMessage`'s
`"opReject"` case now attempts `engine.tryRevertLocalInsert(op.id)` for
any rejected op with `kind === "insert"` (deletes are left untouched,
explicitly out of scope) BEFORE the existing `preserveRejected` call, and
passes the outcome through as `RejectedEntry.reverted` (a new field,
deliberately NOT persisted to the durable `rejected` store — a page
reload replaces the resident engine wholesale via a fresh SNAPSHOT/
CATCHUP anyway, so `reverted` is a purely in-memory UI signal, not
load-bearing for correctness). On a successful revert, TWO things fire:
the EXISTING `onRemoteOpsApplied` listener set (Phase 14) — reused
deliberately, since "the document changed for a reason other than my own
most recent keystroke, please re-render" is exactly true of a revert
regardless of whether the change originated from a peer's broadcast or
this client's own now-undone insert, so this triggers the real, already-
wired DOM re-render with zero new `EditorView` code — and a NEW, dedicated
`onLocalInsertReverted(listener)` channel, carrying the full
`RejectedEntry`, so a future UI can show the honest notification the user
asked for ("this edit couldn't be saved and was removed — here's the
content if you want to reinsert it"). Building that notification UI
itself remains disclosed, out-of-scope future work — the SAME "build the
real capability now, a future UI phase wires it up" precedent Phase 24
already established for `offlineWindowStatus`/`rejectedCount`;
`ConnectionIndicator.tsx`/`EditorView.tsx` are untouched by this fix.

**Hand-traced before implementation, per the user's own explicit
requirement, both cases**: (1) the clean case — nothing anchors to the
rejected node — removal is safe, size bookkeeping correct
(`visibleLength`/`totalElements` both decrement by exactly one), no
dangling references possible (nothing else ever referenced the removed
node), I4/I5 hold (verified via `assertInvariants(engine, {afterCollect:
true})` — the SAME sanctioned "this call is allowed to show a smaller
node count" escape hatch I5 already provides for `collect()`, reused
here since a revert is a second, now-legitimate way structure can
shrink outside of GC). (2) the cascading case — something already
chains onto the rejected node — refused immediately, zero structural
mutation, document and stats byte-for-byte unchanged, confirmed via a
dedicated test asserting `engine.stats()` equality before/after the
refused attempt.

**Full verification, all against the real, merged code**: `pnpm
typecheck` clean across all 6 packages; the new engine-level test
(`packages/engine/src/engine.test.ts`'s new "tryRevertLocalInsert()"
describe block, 4 tests: clean-right-child case, cascading-right-child
case, cascading-left-child case — confirming BOTH children arrays are
checked, not just `rightChildren` — and already-gone-id case) and the new
`packages/client/src/sync/localInsertRevert.test.ts` (3 tests: clean
revert firing both notification channels end-to-end through a real
`OFFLINE_WINDOW_EXCEEDED` OP_REJECT frame against a fake-but-fully-
synchronous socket, cascading refusal leaving the document and
`rejectedOps` unchanged except `reverted: false`, and a rejected DELETE
confirmed untouched/unreverted) — all pass. R0008-R0011 (via the full
engine + `fugueTree.crosscheck.test.ts` suites) and the new R0012
regression test (`packages/engine/src/regressionR0012.test.ts`) all
still pass. Full default `pnpm test`: **425/425 passing** (up from 417 —
the +8 are this fix's own new tests), 47 files, 2 disclosed skips
(unrelated, the deferred O(N²) GC-chain tests), zero regressions.

**The `soak.db.test.ts` scheduler-wiring fix (wiring
`offlineWindowScheduler.ts`'s sweep into the soak test's own loop,
proposed before this investigation began) is now UNBLOCKED** — Option 2
is shipped and verified, so proceeding with that fix no longer risks
leaving a completely unaddressed, undisclosed silent-divergence risk
behind it. Not yet done as of this entry — the next step for whichever
session picks this up.

## ✅ OPEN ITEM 10 DONE, OPEN ITEM 11 RESOLVED (2026-09-07) — M8-e now passes cleanly at both configs

`offlineWindowScheduler.ts`'s `runOneDocument` (Phase 24's Rule 7.2
sweep) is now wired into `soak.db.test.ts`'s own loop — called every 500
operations (the same cadence as the existing session-heartbeat block),
using the REAL default config (`pendingRejectTimeoutMs: 30_000`, not
shortened), plus one final real 31-second wait and a last sweep call
after the main loop so any operation that became stuck in the LAST 30
real seconds of the run still has time to be evicted before the final
quiescence assertions run.

**Confirmed fixed, the specific goal of this item**: re-running M8-e in
full (30,000 real operations, real Postgres, 796.14s wall time),
`coordinator.engine.pending.length` reaches 0 by the end, with orphaned
operations explicitly rejected via `OFFLINE_WINDOW_EXCEEDED` along the
way. The previous run's own failure mode (1,400 permanently stuck
operations, reported 2026-09-06) is gone — confirmed by inspecting the
run's own output: exactly one assertion failed in the entire 796-second
run, and it was NOT any pending-length assertion (see below).

**But the re-run itself surfaced two new things, neither chased further
tonight, per the standing "flag and stop" instruction** — full data,
reproduction command, and suggested next steps in
`tests/regression/R0013-2026-09-07-m8e-soak-heap-growth-and-high-frequency-r0012-rejections.json`
and `docs/benchmarks.md`'s own new "M8-e soak run" section:

1. **R0012's rejection rate, measured for the first time**: under this
   soak's own deliberately-zero undo-horizon grace window
   (`undoHorizonMaxAgeMs: 0`, `undoHorizonMaxOpsPerReplica: 0` — "no
   artificial grace window, this soak's own point is to actually
   collect," per the file's own pre-existing comment), the Critical
   Finding #2 / R0012 race fired on **1,605 of 30,000 operations
   (5.35%)** — not a rare edge case at this configuration, constantly
   recurring instead. This soak's simulated clients are bare `Engine`
   instances, never real `SyncClient`s, so NONE of these 1,605
   rejections were ever revert-corrected by Option 2 — every one is a
   permanent, un-reverted local divergence in THIS harness specifically
   (a disclosed harness limitation, not a regression in Option 2 itself,
   which has its own dedicated, passing tests). This is not a new
   algorithm defect — it is the SAME R0012 mechanism, now measured at
   realistic operation volume under aggressive GC tuning for the first
   time — but it materially raises the practical urgency of **Open Item
   9** (Option 1's structurally-safe GC/undo-horizon redesign): a real
   deployment tuning GC aggressively could see this at a similarly high
   rate, not merely as a theoretical rare race.
2. **A new, unresolved heap-growth anomaly**: heap usage more than
   doubled (97.8MB → 241.2MB) between the last two GC checkpoints,
   failing the test's own coarse 4×-of-median smell test, with NO
   corresponding structural jump (`totalElements` grew only ~18% in that
   same interval, in line with every other interval — GC's own
   tombstone-ratio bound held fine throughout, 0.3697→0.3490,
   flat-to-decreasing). Cause not investigated tonight — `global.gc()`
   is deliberately not forced per checkpoint in this test (already
   disclosed in the file's own header as a coarse, non-exhaustive
   signal), so ordinary unforced V8 allocator noise has not been ruled
   out as an explanation, nor has a genuine leak been ruled in.

**M8-e's status at that point**: NOT marked fully passing. Its own
previously-failing assertion (pending reaches 0) was fixed and
confirmed. The test as a whole still failed, on the newly-found
heap-growth assertion.

### ✅ Open Item 11 RESOLVED — same day, direct follow-up investigation

The heap-growth anomaly was investigated immediately after, at the
user's explicit direction, using the exact same rigor as every other
finding in this project — full account in `tests/regression/R0013`'s
own new `part4_resolution_2026_09_07_followup` section and
`docs/benchmarks.md`'s own updated "M8-e soak run" section:

1. **Forced-GC re-measurement** (`NODE_OPTIONS=--expose-gc`, `--pool=forks
   --poolOptions.forks.singleFork` — the same technique already
   established for M8-a's own benchmark): heap growth under forced GC
   was smooth and tracked structural growth closely — 29.5MB → 76.3MB
   (~2.6x) against ~5.4x structural growth over the identical interval.
   The original run's dramatic final-checkpoint spike (97.8MB → 241.2MB)
   **did not reproduce**. **Confirmed noise, not a leak.** This same run
   also served as the "full test suite now passes cleanly" re-run: 1/1,
   zero assertion failures.
2. **Map-size diagnostics** (`DocumentCoordinator.pendingFirstSeenAtMs`/
   `pendingOpOrigin`/`watermarks`, sampled at every checkpoint in the
   same run): grew to a bounded 183 entries by the end (proportional to
   the sustained rejection rate, demonstrably pruned each sweep, never
   creeping unbounded) — not the source of the original anomaly.
   `watermarks` stayed at 0 throughout (this harness's simulated clients
   never send a real PING) — unrelated, not a finding.
3. **A follow-up comparison at the REAL, non-zero undo-horizon default**
   (5min/200-ops-per-replica, temporarily swapped in for one run, then
   reverted): **no material difference** in the R0012 rejection rate —
   5.44% vs. 5.35% under the zero-grace config. Why: Rule 7.3's
   op-count condition (200 further ops per replica) is satisfied in
   roughly 12 real seconds at this soak's own throughput, making the
   nominal 5-minute age threshold practically irrelevant at this op
   rate. **This is an honest data point that RAISES, not lowers, Open
   Item 9's own priority** — a genuinely busy real multi-user editing
   session could plausibly hit the op-count condition within seconds to
   a couple of minutes too, not the full 5 minutes the RFC's own number
   might suggest read in isolation, so R0012's real-world frequency
   under active editing may be much closer to ~5.4% than a naive
   "the grace window is generous" reading would predict. Does not
   change Item 9's own deferred-to-its-own-session status (correctly not
   chased in this session either), but materially informs how urgently
   it should be picked up.
4. A minor, non-blocking observation from the step-3 comparison run
   (a single GC cycle hitting its 150ms fixpoint safety cap,
   `incomplete: true`, `collectedCount: 0`) is recorded in R0013 but not
   investigated further — by design this collects zero nodes rather than
   an unproven partial set, and the tombstone-ratio bound held
   comfortably regardless.

**M8-e's status now, stated precisely**: fully passing at both its own
shipped (zero-grace) config and the real production default — both
re-runs passed 1/1 with zero assertion failures. Open Item 11 is
resolved. See the Phase 25 final report (this same date, below) for the
complete DoD status and v0.2.0-m2 tag readiness determination.

## 📋 OPEN ITEMS TRACKED FOR FUTURE SESSIONS (as of 2026-09-05, end of session)

Consolidated here, in priority order, so a future session (or this one,
resuming) has one place to check before doing anything else. Items 1-2
were found DURING the act of writing this very consolidation, by actually
re-running `pnpm typecheck`/`pnpm test` rather than assuming the earlier
"resolved" verification (engine-package-scoped) extended to the whole
workspace — it did not.

1. **✅ RESOLVED 2026-09-06 — see the "PHASE 25 UPDATE" section immediately
   above for the full account.** `pnpm typecheck` and `pnpm test` are both
   confirmed clean across the whole workspace. Original description of
   the problem retained below for historical accuracy (what was found and
   why it mattered), not because it's still open.

   **🛑 URGENT, NOT YET DISCLOSED IN DETAIL UNTIL NOW: `packages/protocol`,
   `packages/server`, and `packages/client` were never updated for the
   Fugue port's `originLeft`/`originRight` → `parent`/`side` field
   rename, and the actual, measured breakage is much larger than this
   document's Fugue section previously said.** Confirmed by actually
   running both gates just now, not assumed from the shape of the diff:
   - `pnpm typecheck` **fails** at `packages/protocol` (`codec.test.ts`,
     `controlCodec.test.ts`, `expand.ts`, `snapshotBody.ts`,
     `snapshotBody.test.ts`, `snapshotSeed.ts` — all still reference
     `originLeft`/`originRight` on `InsertOperation`/`Node`, and
     `snapshotBody.ts` still imports the fully-removed `Block`/
     `canFollowInBlock`/`decodeBlock` from `@collab-editor/engine`).
     `pnpm -r` stops at the first failure, so `packages/server` and
     `packages/client`'s own `tsc --noEmit` were NEVER REACHED this
     run — their typecheck status is UNVERIFIED, not confirmed clean.
   - `pnpm test` (the default suite) **fails 64 of 407 tests across 15
     files**, spanning all three downstream packages, not just protocol:
     `packages/protocol/src/{codec,snapshotBody}.test.ts`;
     `packages/server/src/{gateway,handshake,httpApp,
     offlineWindowScheduler,writePath}.test.ts`;
     `packages/client/src/{editor/EditorView,input/inputPipeline,
     sentinel/mutationSentinel,sync/headlessHarness,
     sync/offlineWindowPreservation,sync/reconcileOfflineQueue,
     sync/syncClient,sync/syncClient.durableQueue}.test.ts`. The failures
     are real runtime crashes, not just stale assertions — e.g.
     `encodeStamp` throws `Cannot read properties of undefined (reading
     'c')` because `wireHelpers.ts`/`syncClient.ts`/test fixtures still
     construct operations with an `originLeft`/`originRight` shape the
     real `InsertOperation` type no longer has, so `.parent` is
     `undefined` at the wire-encoding call site.
   - **Net effect: this project's actual product — the client↔server
     sync path, the wire protocol, SNAPSHOT's structure-form body — does
     NOT currently build or run correctly against the new engine.** The
     engine-level Fugue verification above (R0008-R0011, adversarial,
     properties, convergence, mutation matrix) is real and does not need
     redoing, but it only proves `packages/engine` itself is correct in
     isolation — it says nothing about the rest of the workspace, which
     this session never touched beyond the disclosed, deliberate
     `snapshotBody.ts`/block-codec deferral. **This needs a dedicated
     integration pass** (mechanical field-rename fixes in most call
     sites, but a REAL redesign — not a rename — for
     `snapshotBody.ts`'s block-run-length wire format, since Fugue has no
     block-boundary analogue; see item 5). Do this BEFORE resuming
     DUR-06, since DUR-06 itself depends on `packages/client`/`server`
     actually working.

2. **✅ RESOLVED 2026-09-06 — see the "PHASE 25 UPDATE" section above (Bugs
   4-8) for the full root-cause chain and fix.** DUR-06's permanent-stall
   pattern (previously ~50% of runs) is gone: 10/10 clean runs post-fix.
   DUR-05: 2/2 clean. Original description retained below for historical
   accuracy.

   DUR-06's original convergence-timing question — completely
   untouched since before the Fugue investigation began; Phase 25's own
   original DUR-05/06 DoD verification work. Cannot meaningfully resume
   until item 1 above is fixed (DUR-06 needs a working client/server).

3. **The O(N²) → O(log N) balanced-storage redesign for `FugueTree`** —
   explicitly, deliberately deferred to its own dedicated future session
   per the user's direct instruction (see the O(N²) performance finding
   above): decouple Fugue's placement DECISION (lightweight parent/side
   pointers) from a balanced treap-backed STORAGE/QUERY layer. Until this
   lands, two tests remain `it.skip`'d with disclosure comments —
   `packages/engine/src/engine.test.ts`'s two 90,000-node pathological GC
   chain tests, and `packages/testkit/src/benchmark/
   gcSafetyCap.bench.test.ts`'s own single test — both should be
   un-skipped once the redesign is in.

4. **The RFC and Engine Specification documents need updating to reflect
   the move from the YATA-family `integrate()` to Fugue** — a
   documentation task on the six approved design documents themselves
   (pasted into context each session, not stored in this repo), separate
   from and in addition to this repo's own code/CLAUDE.md account. Engine
   Spec §4.3 (the INTEGRATE pseudocode), §6.2 (sub-case iii-d, already
   known false since Phase 20 and now entirely moot under Fugue), and
   §8.5 (the PositionIndex contract, retired) all need real edits, not
   just this file's own record of what changed. Flagged as its own
   deliberately-deferred item, not attempted this session.

5. **`packages/protocol/src/snapshotBody.ts`'s block run-length wire
   format needs a full from-scratch redesign for a tree structure, not a
   field rename** — folded into item 1 above but worth calling out
   separately since it's a different KIND of work. Phase 20's block
   encoding (`Block`/`canFollowInBlock`/`decodeBlock`, and the compression
   benchmark `packages/testkit/src/benchmark/compression.ts`/
   `.bench.test.ts`) was built entirely around YATA's flat, consecutive-
   counter node storage and has already been deleted outright (not
   adapted) as part of this session's Fugue merge — there is no
   Fugue-tree analogue of "a maximal run of consecutive-counter,
   same-replica nodes" to fall back on. SNAPSHOT's structure-form body
   will need a genuinely new design for compactly encoding a Fugue tree
   (parent/side/sibling-order) on the wire, and the compression benchmark
   will need an equivalent new design once that format exists.

6. **The Phase 19 index cross-check's replacement
   (`fugueTree.crosscheck.test.ts`) is deliberately NARROWER in scope
   than Phase 19's original** — single-replica only (3,000 seeds), not
   Phase 19's original 10,000-seed check which also stressed CONCURRENT
   placement. Disclosed and accepted at the time (building an independent
   oracle for Fugue's own concurrent `decidePlacement` logic would
   require re-deriving the algorithm itself), and this project's other
   suites (adversarial, properties, convergence, R0008-R0011) already
   stress concurrent placement far more thoroughly — but worth tracking
   as a known, permanent scope reduction from the pre-Fugue baseline, not
   something to silently forget.

7. **RC-27's own 20-repeated-reconnection p95 timing stress test is
   flaky, independent of anything fixed in the 2026-09-06 session**
   (found while verifying that session's own Bugs 4-8 — `pnpm
   test:reconnection` is otherwise 35/36 to 36/36 clean). The failure
   (`waitForState`/`waitForTextLength` timeouts, at varying points across
   the 20-iteration loop) reproduced identically before ANY of that
   session's fixes (its very first `pnpm test:reconnection` run) and
   after, including in full isolation (no concurrent load) — ruling out
   those changes as the cause. Most plausible explanation, not yet
   confirmed: the already-disclosed, already-deferred Fugue O(N²)
   sequential-insertion cost (Item 3 above) compounding across 20 rapid
   real reconnection cycles, each involving a `reconcileOfflineQueue`
   replay over a growing document. Worth revisiting once Item 3's
   balanced-storage redesign lands — if the flake disappears, that's
   strong confirming evidence; if it persists, it needs its own dedicated
   investigation.

8. **✅ DUR-02 and DUR-03 RESOLVED 2026-09-06 (both PASSED, real numbers);
   M8-a RESOLVED with a significant finding of its own; M8-e surfaced
   Critical Finding #2 above (partially addressed).** All four were
   reviewed read-only in the prior entry (2026-09-06), then actually
   EXECUTED the same day:
   - **DUR-02**: 100% pass — all three assertions held over a real
     12,000-operation, 4-client session against real Postgres (250.8s).
   - **DUR-03**: 100/100 repetitions passed across all 10 named crash
     sites (16.3s), every audit `result: "ok"`.
   - **M8-a**: the documented 100,000-op/10,000-visible scale was
     confirmed IMPRACTICAL to run to completion under the current Fugue
     engine (killed after 71 real minutes / ~64 CPU-minutes with the
     first of its two tests still not done building — far worse than
     small-N extrapolation suggested). Real numbers obtained instead at
     reduced, disclosed scales (N=4,000 and N=500-with-`--expose-gc`) —
     full account and numbers in `docs/benchmarks.md`'s own new "Final
     memory and apply-latency benchmark (Phase 25, M8-a, Fugue port)"
     section. The 10MB memory target's status at TRUE 100k-op scale
     remains genuinely UNKNOWN under Fugue (not passing, not failing) —
     closes automatically once Item 9 below lands.
   - **M8-e**: ran to completion (542.6s, all periodic audits `"ok"`,
     tombstone ratio bounded) but FAILED its final assertion
     (`coordinator.engine.pending.length === 1400`, not 0) — investigating
     this is what surfaced Critical Finding #2 above. The soak test's own
     scheduler-wiring fix is now UNBLOCKED (Option 2 shipped) but NOT YET
     DONE — see the "Option 2 implementation" entry above's own final
     paragraph.

9. **NEW (2026-09-06) — Option 1's structurally-safe GC/undo-horizon
   redesign, tracked as its OWN separately-scoped future item, distinct
   from Item 3's O(N²)→O(log N) storage redesign.** These are TWO
   DIFFERENT problems that happen to both live in GC-adjacent code — do
   not conflate them in future planning. Item 3 is about `FugueTree`'s
   own STORAGE/QUERY performance (how fast `attach()` is). This item is
   about GC's own ELIGIBILITY CORRECTNESS (Critical Finding #2 above,
   `tests/regression/R0012`): making it structurally impossible, not
   merely delayed by a heuristic, for the server to collect a node a
   still-connected client could later reference. The tractability
   analysis (see Critical Finding #2's own "Fix decision" entry) already
   found the real shape of the fix — GC eligibility gated on SESSION
   CHURN (has every session that ever saw this node disconnected). This
   is real, necessary, comparable-in-scope-to-Item-3 work, not a
   same-session patch.

10. **✅ RESOLVED 2026-09-07 — see the "OPEN ITEM 10 DONE" section above
    for the full account.** `offlineWindowScheduler.ts`'s `runOneDocument()`
    is now wired into `soak.db.test.ts`'s own loop, using the real
    default config (`pendingRejectTimeoutMs: 30_000`). Re-running M8-e
    confirmed `coordinator.engine.pending.length === 0` at completion —
    but that same re-run surfaced two NEW findings (Item 11 below), so
    M8-e as a WHOLE is still not fully passing.

11. **✅ RESOLVED 2026-09-07, same day (direct follow-up investigation) —
    see the "Open Item 11 RESOLVED" section above for the full account.**
    The heap-growth anomaly is CONFIRMED unforced V8 allocator noise, not
    a leak (forced-GC re-measurement: 29.5MB → 76.3MB, tracking
    structural growth; the original 241.2MB spike did not reproduce).
    Per-checkpoint map-size diagnostics confirmed `pendingFirstSeenAtMs`/
    `pendingOpOrigin` stay bounded, never unbounded. M8-e now passes
    cleanly (1/1, zero assertion failures) at both its own shipped
    zero-grace config and the real production undo-horizon default. The
    R0012 frequency finding (Item 9's own data point) is UNCHANGED and, if
    anything, reinforced: a follow-up comparison at the real 5min/200-ops
    default found essentially the SAME rejection rate (5.44% vs. 5.35%),
    because Rule 7.3's op-count condition is reached in ~12 seconds at
    this soak's own throughput — raising, not lowering, Item 9's own
    practical priority. Full data: `tests/regression/R0013`'s own
    `part4_resolution_2026_09_07_followup` section and
    `docs/benchmarks.md`.

Items 2-11 are genuinely separable follow-up work, each with its own clear
scope; item 1 was the one that blocked everything else in this project
(including item 2) and has now been resolved. Items 3, 6, and 9 remain
the longest-lived, deliberately-deferred structural/redesign items (NOT
urgent, each its own dedicated future session — 9 is distinct from 3,
see item 9's own text; Item 11's own step-4 comparison is now a concrete
data point in favor of prioritizing 9 sooner rather than later, since
the elevated R0012 rate turns out NOT to be an artifact of this soak's
own aggressive tuning); item 7 is a flaky-test investigation to revisit
once item 3 lands; items 10 and 11 are both now resolved — there is no
single remaining concrete blocker to Phase 25's own closeout as of this
entry (see the Phase 25 final report, same date, for the complete DoD
status and v0.2.0-m2 tag readiness determination).

## Current phase in progress

**Phase 28 (Permissions and per-operation authorization) — COMPLETE as of
2026-09-08.** Owner/editor/viewer roles are now enforced server-side on
every operation, not just at connect — `PUT/DELETE
/v1/documents/{id}/permissions/{userId}` and `POST
/v1/documents/{id}/owner`, `writePath.ts`'s step 1 finally real (a
per-operation re-check through a ≤2s decision cache, SEC-06), and the
required stamp.r correctness comment now in the code. SEC-07's ownership-
transfer atomicity is proven with a real, live 50-concurrent-request burst
against a real Postgres instance — see the "Phase 28" bullet in the
Completed Phases list above for the full account, including the resolved
foundational design decision (keep HELLO's wire protocol unchanged;
simulate the WS-side scenarios via a generalized, still-labeled test seam,
`testOnlySetConnectedSessionRole`, rather than adding any new
unauthenticated identity field) and exactly what that decision means for
what SEC-01/02/03/07's WS-layer coverage does and does not prove. No open
item from this phase blocks anything — the next phase to pick up is
whichever one wires real ticket-based WS identity (Phase 29), which is
what would let PERMISSION_CHANGED's own push mechanism (built this phase,
structurally correct) actually reach a real, authenticated live session.

**Phase 27 (REST document lifecycle) — COMPLETE as of 2026-09-08.**
Create/list/get/rename/revoke-access for documents — `POST/GET
/v1/documents`, `GET/PATCH/DELETE /v1/documents/{id}`, `GET
/v1/users/search` — all behind Phase 26's real Bearer-token auth,
verified for the first time on an incoming request (`authMiddleware.ts`).
The single §5.1 error envelope, the 404-vs-403 enumeration-oracle rule,
API Spec §9.2 idempotency (a new `idempotency_keys` table, canonicalized-
JSON body hashing), and DELETE's real GOODBYE broadcast to every open
WebSocket session for the document (verified end to end with a real
client) are all built and DoD-tested against a real Postgres instance —
see the "Phase 27" bullet in the Completed Phases list above for the
full account, including two pre-existing gaps this phase's own
regression re-run found (one fixed — a stale hardcoded table-count
test; one left alone as already-tracked, unrelated — the Fugue O(N²)
warm-start slowdown, Open Item 3) and what's explicitly deferred (no
grant-permission endpoint yet; the WS gateway still verifies no token
at all). No open item from this phase blocks anything.

**Phase 26 (Authentication and sessions) — COMPLETE as of 2026-09-07.**
Real user accounts, Argon2id password hashing, JWT access tokens, and
refresh-token rotation with family-revocation-on-reuse are all live —
`POST /v1/auth/login`, `/refresh`, `/logout`. SEC-11g's own timing
requirement is verified with real, measured numbers (Welch's t=-0.6393,
mean difference 1.632ms — genuinely indistinguishable). See the "Phase
26" bullet in the Completed Phases list above for the full account,
including the six DoD test cases, the real design decisions made (opaque
HMAC-hashed refresh tokens vs. a self-verifying JWT, the injectable-
`authDeps` pattern mirroring `OperationStore`'s own precedent), and
what's explicitly deferred to Phase 27+ (the WebSocket gateway's own
handshake still does not verify any access token — a client can still
join any document by guessing its id, unchanged from every prior phase).
No open item from Phase 26 blocks anything — the next phase to pick up
is Phase 27 (or whichever phase actually wires an access token into the
WS handshake).

**Phase 25 (Milestone M2, DUR-05/06 adverse-network verification) — DoD
verification COMPLETE as of 2026-09-07; ready for the v0.2.0-m2 tag.**
See the final Phase 25 report (dated 2026-09-07, this session) for the
complete, explicit per-DoD-item pass/fail/deferred status and the tag-
readiness determination. Summary: DUR-02/03/05/06 all PASS (clean, real
runs); M8-a is PARTIAL (real numbers at reduced, disclosed scale — the
full 100,000-op number itself remains genuinely unknown, closes
automatically once Item 3 lands — an accepted, disclosed reduction, not
a blocker, per this project's own established precedent for this exact
kind of gap); M8-e now fully PASSES at both its own shipped config and
the real production undo-horizon default (Open Item 10's fix confirmed
working, Open Item 11's heap-growth finding confirmed resolved as
noise, both same-day). No open item from this investigation is treated
as blocking the tag — Items 3, 4, 6, 7, and 9 remain real, tracked,
deliberately-deferred future work, each scoped to its own future
session, none of them newly discovered blockers to what Phase 25 itself
was verifying.

2026-09-07's own session, in order: Open Item 10 (wiring
`offlineWindowScheduler.ts`'s sweep into `soak.db.test.ts`) was
completed — see the "✅ OPEN ITEM 10 DONE, OPEN ITEM 11 RESOLVED
(2026-09-07)" section above. The re-run initially surfaced two new
findings (a heap-growth anomaly and a much-higher-than-expected R0012
rejection frequency under aggressive GC tuning), both flagged and
deliberately not chased in that pass, per the standing "flag and stop"
instruction. A direct follow-up investigation the same day (forced-GC
re-measurement, map-size diagnostics, and a realistic-undo-horizon
comparison run) resolved the heap-growth anomaly as confirmed noise and
confirmed the R0012 frequency finding is not an artifact of this soak's
own aggressive tuning. See the earlier 2026-09-06 session's own account
below for everything that preceded this checkpoint.

Prior checkpoint (2026-09-06)'s own account, unchanged: See
the "✅ PHASE 25 UPDATE (2026-09-06)" section above for the full account
of what this session found and fixed: the Item-1 integration breakage
(Fugue's `parent`/`side` rename never reaching `protocol`/`server`/
`client`), the server-side `writePath.ts` buffered-operation-ignored bug,
the out-of-order-commit/CATCHUP-honesty bug (`enqueueCommit`/
`lastCommittedSeq`), the replica-id-reuse-after-restart bug plus its own
bigint-string-concatenation bug (both found via DUR-03), the client-side
seq-tracking bug, and the wire-protocol run-coalescing bug — six real
bugs beyond R0008-R0011/the Fugue migration itself, all found and fixed
in one continuous session, all independently verified. DUR-05/DUR-06 are
now fully passing (10/10 clean DUR-06 runs). Explicitly NOT done this
session, per direct user instruction: running DUR-02/DUR-03/M8-a/M8-e
(all four confirmed to exist as complete, real implementations — see
Item 8 in the open-items list above — just not executed yet) and the
RFC/Engine Spec document updates (Item 4). Pick up next session with
DUR-02/DUR-03/M8-a/M8-e via `pnpm test:db`.

Phase 24 (offline window enforcement and rejection preservation) is also
complete; see its own completed-phase entry above for the full account,
including the genuine finding that RC-30's own "anchors were collected"
scenario is not reachable through this project's real client reconciliation
flow (Phase 22's own graceful-degradation design), the mutate-while-
iterating bug found and fixed in the offline-window sweep, and the DUR-08
timing regression found and fixed via the full default-suite re-run.
Phase 23 (reconnection handshake, CATCHUP/ALREADY_HAVE) is also complete;
see its own completed-phase entry above for the full account, including
the two real bugs (ALREADY_CURRENT mode never rebuilding `engine`;
CATCHUP mode seeding its rebuild from an unfiltered node list) found and
fixed via the required 27-cell matrix, and the RC-34 jitter-threshold
statistical-calibration finding. Phase 22 (client durable queue) and
Phase 21 (tombstone garbage collection) are also complete. `Engine.collect()`
(Definition 7.4's four conditions plus its fixpoint anchor sweep),
`sessions.last_ack_seq`/`last_seen_at` now genuinely persisted and read
back for the stability frontier (API Spec §6.5), Rule 7.1 eviction (no
separate bookkeeping — a stale session simply falls out of the frontier
query), the undo horizon as real configuration, `gcScheduler.ts`'s 60s
per-document cycle, and the four Scope-IN metrics are all built — see the
Phase 21 completed-phase entry above for the full account, including
what was, at the time, deliberately NOT built (Rule 7.2's client-facing
"explicit rejection" flow — now built as of Phase 24, see that phase's
own entry, including the genuine finding that this project's own client
reconciliation logic never actually reaches the scenario Rule 7.2's
"explicit rejection" exists to catch) and two unrelated Phase-20-era
gaps (`pnpm typecheck`
and `pnpm check:purity` were both silently broken since Phase 20's own
merge) found and fixed along the way. Regression gates re-run clean on
the real, merged `engine.ts`/server code: default `pnpm test` (329/329
at the time), `pnpm test:adversarial` (22/22), `pnpm test:properties`
(6/6), `pnpm test:index` (10,000-seed cross-check, zero disagreements),
`pnpm typecheck`, `pnpm check:purity`. `pnpm test:convergence` (the full
70,000-seed run, ~44.6 minutes wall time) was ACTUALLY RUN, per the
user's explicit requirement that Phase 21's engine.ts changes
(`deleteContext`/`maxCounterByReplica` bookkeeping, the new `collect()`
method) not be assumed additive-only from the shape of the diff alone —
result: **70,000/70,000 seeds converged, zero divergences, zero
stuck-pending, zero errors, across all 7 configs**, confirming the claim.
`pnpm test:db`'s new `gc.db.test.ts` (M8-c/M8-d, cold-load compaction,
the `gc.minutes_since_last_success` metric, and the `/gc-status` HTTP
endpoint) was ACTUALLY EXECUTED against a real, migrated Postgres
instance — all 4 tests pass, with real observed numbers (100% tombstone
reduction on the M8-c scenario, audit `result: "ok"`, a real HTTP 200
from `/gc-status`) — see the Phase 21 completed-phase entry above for
the exact figures and the five real bugs found and fixed getting there,
none of which a typecheck alone could have caught.

Phase 20 (block run-length encoding) is complete, INCLUDING the Engine
Spec §6.2 sub-case iii-d correction found during its own DoD verification
(two distinct, now-fixed bugs in `integrate()`'s Case B and Case C,
present since Phase 3 — see the Phase 20 completed-phase entry above in
full, and the "Engine Spec §6.2 sub-case iii-d correction" entry under
Key Technical Decisions below). Phase 19's own indexed position structure
is retroactively confirmed NOT the source of that bug (verified via `git
worktree` comparison against pre-Phase-19 commits, byte-identical firing
rate) — it was under suspicion early in that investigation and is now
cleared.

## What is explicitly NOT yet built

Undo/redo's real resurrection semantics beyond Undelete's structural
inverse (Phase 36). Tombstone garbage collection is now BUILT (Phase 21,
Engine Spec §7.3/§7.4/§7.6/§7.7) — `Engine.collect()`, the real stability
frontier (API Spec §6.5), Rule 7.1 eviction, and the undo horizon are all
live; Rule 7.2's own "explicit rejection, content preserved and
exportable" is now ALSO BUILT, as of Phase 24 (Engine Spec §7.6,
`offlineWindowScheduler.ts`'s sweep + `SyncClient`'s preserve-rule
handling) — with a genuine, disclosed finding recorded in that phase's
own entry: this project's own real `SyncClient` reconciliation logic
(Phase 22) never actually produces the specific "queued operation
targeting a since-collected node" scenario Rule 7.2 describes, because
its own graceful-degradation fallback always re-anchors to a safe,
resolvable position first — the built mechanism is proven correct and
necessary as a protocol-level guarantee (any OTHER client, a genuinely
slow/reordered delivery), just not reachable through this specific
client today. Any retention/pruning
policy for the `snapshots` table itself (unrelated to tombstone GC — every
MAYBE-SNAPSHOT trigger still adds a new row forever, nothing prunes old
snapshot rows). Block run-length
encoding is now BUILT (Phase 20, Engine Spec §7.5) — SNAPSHOT's
structure-form body serialization (`packages/protocol/src/snapshotBody.ts`)
is a real block-encoded wire format, no longer the Phase 9 one-record-
per-node placeholder. The OPS and
CONTROL channels both now flow end to end (Phases 7-9); PRESENCE message
types and any presence broadcast do not exist yet (Phase 31) — a stale
session is only logged/marked, never actually removed from anything.
Reconnection catch-up (CATCHUP/ALREADY_HAVE, API Spec §3.6.4-§3.6.8) is now
BUILT as of Phase 23 — a reconnecting client with a still-resident engine
(a socket drop, not a full page reload) receives a delta over
`(lastServerSeq, currentSeq]` instead of a full fresh SNAPSHOT, and
ALREADY_HAVE lets it skip reconciling/resending whatever the server
already has, regardless of sync mode. Every reconnect (Phase 10's
`SyncClient` now performs these automatically, with real backoff) still
gets a brand-new replica id — server-side session/replica-id resumption
remains explicitly out of scope, the same standing Phase 8/9 decision
Phase 22 already reaffirmed and Phase 23 reaffirms again; see that
phase's own completed-phase entry for why `rebuildEngineForReconnect`
exists specifically because of this standing choice. Session-
inactivity eviction (10 minutes with no PING) is now LIVE as of Phase 21 —
not as separate eviction bookkeeping, but as the natural consequence of
`getStabilityFrontier`'s own 10-minute WHERE clause (a stale session
simply stops appearing in the frontier computation).
**Operations are durably persisted as of Phase 16, and snapshotted as of
Phase 17** — every operation is committed to Postgres before its client
is acknowledged (API Spec §6.3), and a coordinator warm-starts from the
latest snapshot plus only the operation-log suffix after it (RFC §13.2's
MAYBE-SNAPSHOT, 500 ops/30s), not a full genesis replay. Tombstone
garbage collection is now BUILT as of Phase 21, and Rule 7.2's own
explicit-rejection half is now ALSO BUILT as of Phase 24 (see the
"What is explicitly NOT yet built" section above for the full account,
including the finding that this project's own client never actually
reaches the scenario it protects against). What remains NOT built: any
retention/pruning policy for the `snapshots` table itself, UNRELATED to
tombstone GC (every MAYBE-SNAPSHOT trigger still adds a new row forever —
not a problem yet, but nothing prunes old snapshot rows);
`SyncClient`'s unacked-operation queue is now durably persisted to
IndexedDB as of Phase 22 (API Spec §7.9) — a client that closes its tab
mid-edit no longer loses whatever hadn't been acked yet; it is restored
and re-mints/resends on the next connect (`reconcileOfflineQueue.ts`).
What Phase 22 does NOT add is server-side session/replica-id resumption
(a deliberate, user-approved scope boundary — see that phase's own
completed-phase entry) — a reconnecting client still always gets a
brand-new replica id, so restored operations land under NEW identities,
never their original ones; `documents.next_replica_id`/`sessions`/
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
auth lands.** **Real authentication now exists as of Phase 26** (API Spec
§4.1/§4.2) — `POST /v1/auth/login`/`/refresh`/`/logout`, real Argon2id
password hashing, JWT access tokens, refresh-token rotation with
family-revocation-on-reuse — and, as of **Phase 27**, the REST document
lifecycle (`POST/GET /v1/documents`, `GET/PATCH/DELETE
/v1/documents/{id}`, `GET /v1/users/search`) is real too, behind a real
`Authorization: Bearer` check — but it is STILL NOT WIRED into the
WebSocket gateway's own handshake, which is unchanged and still exactly
as permissive as before: any WebSocket client can join any document by
guessing its id and is unconditionally granted the EDITOR role. This
remains a later phase's own job (verifying a real access token during
HELLO and using its claims for real per-document authorization), not
yet a security concern since nothing is exposed publicly, and not
something Phase 26 or 27 claimed to close — both built real REST-side
auth primitives, deliberately scoped no further. As of **Phase 28**, real
grant/revoke/transfer endpoints now exist (`PUT/DELETE
/v1/documents/{id}/permissions/{userId}`, `POST
/v1/documents/{id}/owner`) and `writePath.ts`'s own per-operation
authorization check is genuinely re-evaluated on every operation, not
read once at connect — but the WS-side "authenticated identity" gap
above is exactly why PERMISSION_CHANGED's own push mechanism (built this
phase) will typically find no live session to reach in production: a WS
session's `userId` is still a random per-connection value, unrelated to
any REST-authenticated user id, until Phase 29 actually wires real
ticket-based identity into the handshake. This project's own tests
still seed editor/viewer rows directly via SQL in most places (the
grant endpoint exists now, but most fixtures predate it and were never
migrated to use it, since there was no reason to). A React component (`EditorView`), the full `beforeinput`
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
26-29), and **presence** (no cursors/avatars for other users, Phase 31).
**Offline editing is now BUILT as of Phase 22** — API Spec §7.9's durable
IndexedDB queue, a relaxed `requireEngine()`/input-pipeline gate that
allows minting edits while `reconnecting`/`offline`, and
`reconcileOfflineQueue.ts`'s re-mint-and-resend-on-reconnect mechanism;
see that phase's own completed-phase entry for the full account,
including the disclosed identifier-change nuance and the four real bugs
(one pre-existing, in `gapTracker.ts`) found building it. Still stubbed:
**undo/redo** (Phase 36) and **IME composition** (never emits an
operation, unbuilt, unassigned to a phase number). Also still open:
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

- **`reconcileOfflineQueue.ts`'s anchor-resolution fallback (Phase 22)
  means a reconnecting client's OWN reconciliation can never re-send an
  operation naming a specific, now-collected identifier — found while
  building Phase 24's own RC-30 integration test, not assumed in
  advance.** `visibleIndexAfter`/`visibleIndexOfTarget` always resolve a
  queued operation's anchor against the CURRENT structure at reconcile
  time, and CATCHUP (Phase 23) always delivers the delete that tombstones
  a since-collected node's own visibility BEFORE reconciliation ever runs
  (`handshakeGate`'s serialization order) — so the anchor is always either
  tombstoned-but-present or entirely absent by the time it's resolved,
  and the fallback in both cases (visible position 0, i.e. `originLeft:
  null`) is always immediately resolvable. This means Rule 7.2's own
  "queued operation targeting a since-collected node" scenario (Engine
  Spec §7.6) is real and correctly handled server-side (Phase 24's
  `offlineWindowScheduler.ts`), but is NOT reachable through this
  project's own real `SyncClient` today — proven instead via a
  hand-built raw wire frame naming a collected identifier directly
  (`gateway.test.ts`'s own "Offline-window sweep, end to end over the
  real wire protocol" test). The general lesson, a variant of this
  project's own recurring "green isn't evidence until checked at the
  right scale": a spec-mandated safety mechanism can be simultaneously
  CORRECT, NECESSARY (for any other client, or a future redesign), and
  UNREACHABLE through this specific codebase's own current call paths —
  worth discovering and documenting explicitly rather than either
  skipping the mechanism (it's still required) or forcing a misleading
  test to "prove" a scenario the real client structurally avoids. Full
  account: Phase 24's own completed-phase entry, and
  `offlineWindowPreservation.test.ts`'s header comment. — Engine Spec
  §7.6 Rule 7.2, API Spec §5.5/§10.5, Test Plan RC-30.

- **Engine Spec §4.3 replaced by the real YATA algorithm (2026-09-05,
  Phase 25 pivot, R0010) — `integrate()`'s Case A/B/C decision procedure
  (Phase 3's own derivation, patched at R0008 and R0009 below) was
  REPLACED OUTRIGHT, not patched a third time.** While root-causing a
  genuine `integrate()` finding surfaced by Phase 25's own DUR-05/06
  adverse-network DoD verification (duplicate/delay+reorder/delay+drop
  network conditions each independently triggering the same "destIndex
  outside its own scan window" canary R0008/R0009 had already redefined),
  a THIRD, structurally distinct gap was found and confirmed via a fast,
  network-free, engine-only event-script fuzzer (isolated per fault type:
  reorder-only and drop-only both reproduce; duplicate-only and a
  zero-fault reconnect do NOT reproduce standalone, an open item — see
  `tests/regression/R0010`). Hand-traced against the ACTUAL, current,
  post-R0008/R0009-fix `integrate()` code: both rank checks were present
  and individually correct at every single decision point in the minimal
  repro. The bug is one level ABOVE any single scan — two nodes that are
  NEVER directly rank-compared against each other can end up in OPPOSITE
  relative structural order on two replicas, purely as a function of what
  OTHER, unrelated nodes were integrated in between on each side. When a
  third operation later needs both as its own two origins, one replica
  computes an INVERTED, negative-width window (`leftIndex > rightIndex -
  1`) and the scan never even runs before the sanity check throws. This
  is a violation of TRANSITIVITY that no amount of per-branch rank-check
  patching can close, because the defect isn't in any single scan's
  decision — it's in the decision PROCEDURE's inability to relate two
  nodes it never directly compares. Given three bugs in the same family,
  each found under a new test condition after the previous fix, this was
  treated as a signal the approximation itself (this project's own
  `scanned`/`conflicting` Set-based tracking) is structurally unsound for
  transitivity, not merely incomplete in one more spot.

  **The decision to replace rather than patch again, and the research
  behind it**: rather than hand-derive a fourth candidate fix, the real,
  published, peer-reviewed YATA algorithm (Kleppmann, "Near Real-Time
  Peer-to-Peer Shared Editing on Extensible Data Types") was researched
  and verified against its actual reference implementation — Sypytkowski,
  https://github.com/Horusiath/crdt-examples/blob/master/Crdt/convergent/
  Yata.fs — fetched and read directly, not recalled from memory, given
  the stakes of building on a misremembered algorithm. A literal,
  faithful port (a standalone array-based reimplementation, built and
  checked BEFORE touching `engine.ts`) was verified against R0008, R0009,
  AND R0010's own exact recorded operation sequences — all three converge
  identically across every delivery order under the real algorithm — and
  against RFC NQ-2's own backward-typing non-interleaving requirement.
  Two findings from this research were surprising and are worth recording
  because they overturn what R0008/R0009 assumed: (1) the real
  algorithm's Case-C-equivalent branch (`otherLeftIndex < leftIndex`) is
  an UNCONDITIONAL stop with NO rank check at all — the OPPOSITE of what
  R0008's own patch added; (2) its Case-B-equivalent uses a single
  carried-forward `scanning` BOOLEAN, re-derived from the CURRENT scan
  position on every iteration where it's false, rather than this
  project's own two per-scan Sets (`scanned`/`conflicting`) tracking
  node-identifier membership — this single mechanism is what actually
  supplies transitive consistency across separate `integrate()` calls,
  which the Set-based approximation had no equivalent for.

  **A real translation bug was found and fixed during the port's own
  verification, not by review — the exact discipline this project's
  "hand-trace before code" rule exists for.** The reference algorithm's
  recursive `findInsertIndex` re-derives its `dst` (destIndex) at the TOP
  of EVERY call, including the FINAL one where `i === right` triggers the
  return. A first translation used a `for (i = leftIndex+1; i <
  rightIndex; i++)` loop, which never runs a body for `i === rightIndex`
  and so silently skips exactly that last re-derivation whenever the scan
  reaches the end of its window without an earlier stop. This reproduced
  RFC NQ-2's own historical "zcybxa instead of cbazyx" interleaving bug
  immediately — caught by `engine.test.ts`'s own pre-existing §10.7
  worked-trace test on the very first run against the real file, not
  anticipated in advance. Fixed by translating the recursion as a literal
  `while(true)` loop with an explicit `i === rightIndex` exit check,
  matching the reference algorithm's control flow exactly rather than
  approximating it with a bounded `for` loop.

  **`id1 <= id2` (the reference algorithm's raw, non-strict replica-id
  comparison) is `compareRank(node, other) <= 0` in this port** — Engine
  Spec Definition 4.2's bind-then-replica-id tuple, unchanged since Phase
  3, since YATA itself has no notion of grapheme-cluster binding (I8);
  this substitution is the only domain-specific adaptation the port
  makes. Note the comparison is deliberately NON-STRICT (`<=`), a real,
  load-bearing difference from every one of this project's own pre-R0010
  comparisons, which used a strict `<` throughout.

  **Full verification, against the real, merged `engine.ts`, all gates
  re-run from scratch — no result assumed from the pre-implementation
  scratch port**: R0008 (all 6 causally-valid delivery-order permutations
  converge to `"it"`), R0009 (all 3 causally-valid delivery-order
  permutations converge to `"itp"`), R0010 (out-of-FIFO delivery
  converges to text AND structure IDENTICAL to natural in-order delivery,
  `"ghdfec"`); `pnpm test` (engine package, 59/59, including the corrected
  §10.7 trace); the full monorepo default `pnpm test` (425/425 across 45
  files); `pnpm test:adversarial` (22/22); `pnpm test:properties` (6/6
  suites, 10,000 cases each); `pnpm test:index` (10,000-seed PositionIndex
  cross-check vs. a linear-scan oracle, zero disagreements); **`pnpm
  test:convergence` at the FULL 10,000-seed budget across ALL SEVEN
  configs, 70,000/70,000 converged, ZERO divergences — including
  C7-immediate-delivery, the exact config that found R0008/R0009 at
  22-95% failure rates pre-fix, now clean at full budget**; `pnpm
  test:mutation` — **10 of 10 mutants killed, a STRONGER result than the
  pre-fix baseline** (where `M3_no_case_c` survived every suite by
  design, requiring the specialized MUT-KILL-01 10^6-trial search to even
  attempt to kill it) — the real-YATA-port's own Case-C-equivalent branch
  is now caught by the ordinary pure-convergence fuzzer at seed 0, a
  materially more observable failure mode than the old approximation ever
  had. Two of the ten mutants' `find`/`replace` anchors needed mechanical
  updates for the new source shape (`packages/testkit/src/mutation/
  mutants.ts`): `M3_no_case_c`'s own anchor (re-targeted to the new
  algorithm's single unified stop condition, removing only its
  `otherLeftIndex < leftIndex ||` disjunct — the real equivalent of
  disabling "Case C"), and, found only by actually re-running this gate,
  a genuinely PRE-EXISTING, unrelated gap in `M8_no_idempotence`'s own
  anchor (stale since Phase 21 added an optional `context` parameter to
  `applyRemote()` — the same class of drift as Phase 19/21's own
  CRLF/`deliveryMode` gaps, not caused by this fix).

  **What changed structurally**: `engine.ts`'s `sameOrigin()` helper
  function is removed (no longer called anywhere — the new algorithm
  compares resolved integer positions directly, never needs a separate
  identifier-equality helper). `integrate()`'s own doc comment now
  contains the full algorithm rationale and citation; the structural
  sanity check (destIndex-within-window) is retained as a cheap,
  always-on regression canary, now structurally guaranteed to hold rather
  than merely hoped to.

  Permanent regression fixtures `tests/regression/R0008`, `R0009`, and
  the new `R0010` are ALL retained per Test Plan §2.3 Rule 2 (never
  removed, even fixed/superseded) — R0008 and R0009 are marked
  "superseded" (their own fixes, while each individually correct as far
  as they went, are no longer what's running; the algorithm they patched
  no longer exists), with a cross-reference to this entry. Full
  investigation timeline for R0008/R0009: the "Engine Spec §6.2 sub-case
  iii-d correction" entry immediately below (documented at the time, kept
  as-is rather than rewritten, since it's an accurate record of what
  happened THEN).

- **Engine Spec §6.2 sub-case iii-d correction (2026-09-02/03, Phase 20,
  R0008 + R0009) — a real correction to the APPROVED SPECIFICATION
  document, not just to code.** Sub-case iii-d claims a Case C node in
  `integrate()`'s origin-bounded scan can NEVER outrank/affect where the
  candidate being placed lands. **This claim is incorrect, confirmed by
  hand-tracing Engine Spec §4.3's own literal INTEGRATE pseudocode** (line
  17's `c.originLeft ≠ ⊥ ∧ c.originLeft ∈ scanned` conjunct falls through
  to Case C's unconditional, rank-blind `break` whenever `c.originLeft =
  ⊥`) — `engine.ts` was a faithful, line-for-line translation of this
  pseudocode; the flaw was in the spec's own design, not introduced during
  Phase 3's implementation. Found while building Phase 20's own DoD test,
  firing at ~23-24% on ordinary randomized states — not a rare edge case,
  and present, unchanged, since Phase 3 (confirmed via `git worktree`
  against pre-Phase-19 and pre-Phase-20 commits: byte-identical firing
  rate on every version of this codebase ever shipped). A follow-up test
  confirmed this was not cosmetic: 3 of 4 tested anchor variants onto the
  divergently-placed node produced genuinely different VISIBLE TEXT across
  replicas — a direct violation of this project's core convergence
  promise.

  **A second, related but structurally distinct instance was found in
  Case B** while building a properly-validated (non-confounded) permanent
  regression fixture for the first fix — treated as the SAME investigation,
  not a separate one. Case B's group-membership test (`scanned`/
  `conflicting`) can advance a candidate past a node based on a DIFFERENT
  node's rank comparison (the group's own anchor) rather than the actual
  node in question's — silent, no throw, no canary, genuinely different
  VISIBLE TEXT (`"ipt"` vs `"itp"`) purely from delivery order.

  **Root-cause investigation also found a real gap in this project's own
  primary safety net**: the 60,000-seed `convergence.test.ts` suite never
  caught either bug across its entire history, not because the bugs were
  rare, but because `runTrial.ts`'s "deferred-shuffled" delivery (generate
  a whole trial's operations first, deliver via one global shuffle at the
  end) makes it STRUCTURALLY IMPOSSIBLE for an operation to ever anchor to
  a peer's node during generation — exactly the precondition both bugs
  need. Real, live multi-user editing (a replica typing while seeing
  peers' very-recent edits — "immediate delivery") reaches it readily
  (measured 22-95%, config-dependent, pre-fix). Fixed by adding a
  permanent `C7_IMMEDIATE_DELIVERY` config (`packages/testkit/src/fuzz/
  configs.ts`) alongside a real `deliveryMode` implementation in
  `runTrial.ts` — the only config in this project capable of reaching this
  bug class; every future `integrate()` change must be checked against it.

  **Fix**: Case C's blind `break` and Case B's blind group-inheritance
  advance were both replaced with the SAME rank check Case A already
  performs for same-window competitors (`compareRank(other, node) < 0`).
  Case B's fix was hand-traced BEFORE implementation specifically to
  confirm it does not reintroduce RFC NQ-2's interleaving problem (the
  entire reason Case B's group-inheritance exists): for a genuine
  single-author contiguous run, every member shares its anchor's own
  replica id, so the new check is automatically satisfied whenever the
  group's anchor already won — it only changes behavior when a chain
  crosses an authorship/replica boundary, which isn't really "one run" to
  begin with. Verified against a same-author run swept by a concurrent
  competitor (contiguity preserved) and a depth-2 chain crossing an
  authorship boundary (splits at exactly the right point, still
  converges). Case A was explicitly hunted for a third instance of this
  bug shape and confirmed architecturally immune — it always performs a
  direct pairwise rank comparison, never inherits from group membership.

  **The Phase 6 test-build canary was redefined, not retired**: sub-case
  iii-d's claim being false meant its literal assertion could not be left
  in place unchanged (either dead or actively misleading). `integrate()`
  now ends with a general structural sanity check instead — `destIndex`
  must remain within its own scan window `[leftIndex+1, rightIndex]`,
  true regardless of which branch decided it, unrelated to the retired
  claim.

  **Permanent regression fixtures**: `tests/regression/R0008` (the first
  entry in this corpus to fully satisfy Test Plan §2.3 Rule 3 — a byte-
  exact 4-operation stream, not a post-hoc seed/log) and `R0009`. Both are
  marked FIXED but permanently retained per Rule 2 ("entries are never
  removed") — a corpus entry documents a bug that happened, not an open
  issue. Full investigation timeline: the Phase 20 completed-phase entry
  above (documented at length deliberately — this took two intensive
  rounds of work, including one candidate fix hand-traced and found
  unsound BEFORE being built, not after).

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
pnpm test:convergence  # the convergence suite ONLY — C1-C7 (C7 added Phase 20), 10,000 seeds each, invariants active
pnpm test:properties   # the property-based suite ONLY — PROP-1..5, 10,000 generated cases each
pnpm test:adversarial  # the adversarial suite ONLY — ADV-01..22, hand-constructed, also part of `pnpm test`
pnpm test:mutation     # the mutation matrix — ten mutants x four suites, MUT-KILL-01 at a small sanity budget
pnpm test:index        # PositionIndex reference cross-check ONLY — 10,000 seeds vs. a linear-scan oracle (Phase 19, Test Plan §2.6 I6)
pnpm test:benchmark    # testkit's scaling/compression/GC-safety-cap benchmarks (Phases 19-21) PLUS client's keystroke-latency benchmark (Phase 22) — real numbers in docs/benchmarks.md and this file's own Phase 22 entry
pnpm test:db           # schema (Phase 15) + write-path/durability (Phase 16) suites — requires a real, migrated Postgres
pnpm test:reconnection # the RC-* reconnection matrix ONLY (Phase 23, Test Plan §5.1) — 27-cell matrix + RC-27/28/33/34, many real WebSocket reconnects, several minutes
```

`pnpm test:reconnection` currently PASSES: 36/36 tests (the 27-cell
RC-01..27 matrix, RC-27's own 20-run p95 timing test, RC-28, RC-33a-e,
and RC-34's two assertions) against a real, in-process
`createCollabServer()` — see the Phase 23 completed-phase entry above for
the full DoD account, the two real bugs found via this matrix and fixed,
and the RC-34 jitter-threshold statistical finding. Not wired into CI as
its own job — same reasoning as `pnpm test:db`: no Postgres/browser
dependency here, but many real WebSocket reconnects make it several
minutes end to end, and neither this phase's own scope nor any prior
phase's asked for a new CI job.

### The durable-queue e2e suite (real browser, real IndexedDB, Phase 22)

```bash
cd packages/client
pnpm run test:e2e:durableQueue   # DUR-07 ONLY — a real, on-disk Chromium profile, terminated and relaunched
```

Its own dedicated Playwright project (`durableQueue`, `playwright.config.ts`) — like `convergence`, excluded from the three single-engine projects since it manages its own browser lifecycle directly (`chromium.launchPersistentContext`) rather than using Playwright's `page`/`context` fixtures. See `packages/client/e2e/durableQueue.spec.ts`'s own header comment for exactly what Playwright API this needed, what a genuine engine-level SIGKILL would have required (not achievable — no supported API combination offers both a real process handle AND a reusable on-disk profile), and why a graceful `context.close()` still proves the claim for data already flushed before termination.

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

**Phase 24 update**: `pnpm test` currently passes **425 tests across 45
files** (up from 388/41 — six new files this phase:
`packages/client/src/sync/offlineWindow.test.ts`,
`offlineWindowScheduler.test.ts` (server),
`offlineWindowPreservation.test.ts`, and
`packages/server/src/writePath.test.ts`, plus extensions to
`engine.test.ts`, `wireHelpers.test.ts`, `durableQueue.test.ts`,
`unackedQueue.test.ts`, `inputPipeline.test.ts`, `controlCodec.test.ts`,
and `gateway.test.ts`). See the Phase 24 completed-phase entry above for
the full account, including the genuine finding that RC-30's own
"anchors were collected" rejection scenario is not reachable through
this project's real `SyncClient` reconciliation flow, the mutate-
while-iterating bug found and fixed in the offline-window sweep
(`offlineWindowScheduler.test.ts`), and the DUR-08 timing regression
found and fixed via the full default-suite re-run. `pnpm test:reconnection`
(Phase 23's own gated suite) re-confirmed passing at 36/36 across 3 of 4
repeated runs — the remaining run's intermittent failure is traced to a
pre-existing characteristic of RC-27's own 20-iteration stress test
(accumulated long-lived idle clients across the loop, real PING/PONG
timing under sustained load), not to anything this phase changed; see
that phase's own entry for the full account.

**Phase 23 update**: `pnpm test` currently passes **388 tests across 41
files** (up from 373/41 — the file COUNT is unchanged because Phase 23's
own large new `reconnection.test.ts` is gated out of the default run, per
its own `pnpm test:reconnection` entry above; the +15 TESTS come from
`controlCodec.test.ts`'s new CATCHUP_CHUNK/round-trip/directionality
coverage for the four newly-implemented message types and
`handshake.test.ts`'s new `decideSyncMode`/`chunkCatchupOperations`/
`buildCatchupMessages`/`buildAlreadyHaveMessage` coverage). See the Phase
23 completed-phase entry above for the full account, including the two
real bugs found via the required 27-cell reconnection matrix
(`pnpm test:reconnection`, 36/36 passing) and the RC-34 jitter-threshold
statistical-calibration finding.

Historical (Phase 22's own end-of-phase state): `pnpm test` passed
**373 tests across 41 files** (up from
329/38 — Phase 22 added three new files to `packages/client/src/sync/`
— `durableQueue.test.ts` (16), `reconcileOfflineQueue.test.ts` (13),
`syncClient.durableQueue.test.ts` (4) — and extended three existing ones
— `unackedQueue.test.ts` (6→10), `gapTracker.test.ts` (9→12,
`markAlive()`'s liveness-signal tests), `syncClient.test.ts` (15→16, the
idle-PONG-does-not-force-a-reconnect test); see the Phase 22 entry above
for the full account, including the real bug this last test guards
against). Confirmed stable across 5 consecutive full-suite runs (a real,
intermittent flake in Phase 22's own new test file — Bug 4 in that
entry — was found and fixed via exactly this kind of repeated-run
verification). `pnpm test:benchmark` gained a new file,
`packages/client/src/sync/benchmark/keystrokeLatency.bench.test.ts`
(Phase 22's own DoD requirement to measure keystroke latency with vs.
without the durable queue attached — real numbers in that phase's own
entry). `pnpm test:db` gained a new file, `packages/server/src/db/
gc.db.test.ts` (M8-c/M8-d, cold-load compaction, the `gc.minutes_since_
last_success` metric) — actually executed against a real, migrated
Postgres instance (all 4 tests pass); see the Phase 21 entry above for
the real observed numbers and the five real bugs found and fixed
getting there.

Historical: 321 tests across 38 files (up from 308/37 —
Phase 20 added `packages/engine/src/block.test.ts` and other new files;
see the Phase 20 entry above for the full account, including the Engine
Spec §6.2 sub-case iii-d correction found and fixed during this phase).
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

**Phase 20 update**: a SEVENTH config, `C7_IMMEDIATE_DELIVERY`, is now a
permanent member of `ALL_CONFIGS` (see the Phase 20 completed-phase entry
and the "Engine Spec §6.2 sub-case iii-d correction" entry under Key
Technical Decisions) — the only config capable of reaching the Case B/C
rank-violation bug class that phase found and fixed. Re-confirmed clean
(zero divergences, all seven configs) against the merged, corrected
engine.

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

**Phase 20 update**: `M3_no_case_c`'s `find`/`replace` anchors and
`violatedInvariant` citation were updated to match the Engine Spec §6.2
sub-case iii-d correction's new Case C code shape (the citation changed
from the now-retired "sub-case iii-d" to "I6, scan-window determinism" —
see the Phase 20 entry and the Key Technical Decisions correction entry
for the full account). Re-run result and any change in `M3_no_case_c`'s
kill/survive status: see the Phase 20 completed-phase entry's own
mutation-matrix paragraph.

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

**Note on the "27 tests across five files" figure above**: it reflects
this section's own last full update (Phase 18) and was never kept in
sync with every later phase's own `db/*.db.test.ts` additions (Phase 21's
`gc.db.test.ts`, Phase 25's `dur02LedgerReconciliation.db.test.ts`/
`dur03CrashInjection.db.test.ts`/`soak.db.test.ts`, Phase 26's
`auth.db.test.ts`/`authTiming.db.test.ts`, etc.) — a pre-existing
documentation-maintenance gap, not something this phase introduces or
attempts to fully correct (out of scope for a single phase's own
report). **Phase 27 adds one new file, `db/documents.db.test.ts`** (9
tests — the full REST matrix, one test per row/row-group: create,
title validation, idempotency replay/conflict, list with role
filter/pagination, get with the 404-vs-403 split, patch, delete/GOODBYE/
retention, users/search, and the combined error-envelope check) — see
the Phase 27 completed-phase entry above for the full account and real
results. This same regression pass also fixed a real, pre-existing,
unrelated staleness in `schema.db.test.ts` (a hardcoded 8-table literal
list that had silently never been updated when Phase 26 added
`refresh_tokens`) and confirmed — but did NOT fix — a real, pre-existing,
unrelated failure in `snapshots.db.test.ts` (its 50,000-op/2-second
warm-start budget, now measuring ~59s under Fugue's already-disclosed
O(N²) cost, CLAUDE.md's own Open Item 3).

**Phase 28 adds two new files**: `db/permissions.db.test.ts` (4 tests —
PUT/DELETE .../permissions/{userId}, POST .../owner, and SEC-07's own
50-concurrent-request ownership-transfer atomicity burst, verified live
against a real Postgres instance with a running 10ms-interval poller,
not just a before/after snapshot) and, outside `db/` entirely (no
Postgres needed), `packages/server/src/permissions.test.ts` (6 tests —
SEC-01/02/03/06's own WS-layer, in-memory `DocumentCoordinator`
coverage). This phase's own regression sweep also found — but did NOT
fix, being unrelated to this phase's own work — `db/audit.db.test.ts`
and `db/gc.db.test.ts`'s 100,000-operation tests now TIMING OUT entirely
(previously slow but completing), the same already-disclosed Fugue
O(N²) cost (Open Item 3) continuing to worsen at that scale.

Excluded from the default `pnpm test` (requires `docker compose up -d` +
`pnpm db:migrate` first; most dev/CI environments don't have a Postgres
instance running by default) — same reasoning as
convergence/properties/mutation. Not yet wired into CI as its own job;
that requires a Postgres service container in the GitHub Actions
workflow, which neither Phase 15 nor Phase 16's own scope asked for and
wasn't added here to avoid scope creep — worth flagging for whichever
future phase next touches `.github/workflows/ci.yml`.
