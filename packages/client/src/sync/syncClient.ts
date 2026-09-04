import {
  Engine,
  serializeId,
  type DeleteOperation,
  type Identifier,
  type InsertOperation,
  type Operation,
} from "@collab-editor/engine";
import {
  Channel,
  CLIENT_CAP_ACCEPTS_OP_INSERT_RUN,
  CLIENT_CAP_ACCEPTS_STRUCTURE_SNAPSHOT,
  CLIENT_CAP_HAS_RESIDENT_ENGINE,
  RejectReason,
  SessionRole,
  SnapshotForm,
  SyncMode,
  decodeControlFrame,
  decodeFrame,
  decodeStructureSnapshotBody,
  encodeControlFrame,
  encodeFrame,
  peekChannel,
  replaySnapshotNodesInto,
  seedEngineFromSnapshot,
  type ControlMessage,
  type OpsMessage,
} from "@collab-editor/protocol";
import { Backoff, BACKOFF_RESET_AFTER_MS } from "./backoff.js";
import { ObservableValue, type ConnectionState, type Observable } from "./connectionState.js";
import { openDurableQueue, type DurableQueue, type RejectedRecord } from "./durableQueue.js";
import { SequenceGapTracker } from "./gapTracker.js";
import {
  OfflineWindowExceededError,
  OfflineWindowTracker,
  type OfflineWindowStatus,
} from "./offlineWindow.js";
import { buildCleanCatchupBase, reconcileOfflineQueue } from "./reconcileOfflineQueue.js";
import { UnackedQueue } from "./unackedQueue.js";
import {
  operationsToRunMessages,
  operationsToWireMessages,
  operationToOpsMessage,
  toOperations,
} from "./wireHelpers.js";

export { OfflineWindowExceededError, type OfflineWindowStatus } from "./offlineWindow.js";

/** One rejected-and-preserved operation (API Spec §5.5 step 1 — "move to the rejected store, do not delete"). Returned by {@link SyncClient.listRejected}. */
export interface RejectedEntry {
  readonly op: Operation;
  readonly reason: RejectReason;
  readonly detail: string;
  readonly rejectedAt: number;
}

/** API Spec §1.2/§3: WebSocket path and subprotocol — restated here (not imported from `@collab-editor/server`, which a client must never depend on). */
export const WS_PATH = "/v1/rt";
export const WS_SUBPROTOCOL = "obseq.v1";

/** API Spec §3.6.11: client PING cadence. */
export const PING_INTERVAL_MS = 3_000;

/**
 * The subset of the DOM `WebSocket` API SyncClient needs, as an interface
 * rather than the concrete global class — so a test can supply a fully
 * synchronous, fake-timer-friendly fake instead of a real socket (real
 * network I/O and `vi.useFakeTimers()` don't mix reliably). The real
 * global `WebSocket` (browser or Node's built-in implementation) already
 * satisfies this shape; `SyncClient`'s default `createSocket` uses it
 * directly.
 *
 * `any` below is deliberate, not lazy: DOM's WebSocket event-handler
 * properties carry `MessageEvent`/`CloseEvent`, far more than SyncClient
 * reads; typing these narrowly (e.g. `{ data: unknown }`) makes the real
 * global `WebSocket` fail structural assignment to this interface, and
 * typing them as the real DOM event types would force a test fake to
 * construct full `MessageEvent`/`CloseEvent` instances it doesn't need.
 */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((ev: any) => void) | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  onmessage: ((ev: any) => void) | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  onclose: ((ev: any) => void) | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  onerror: ((ev: any) => void) | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

function defaultCreateSocket(url: string, protocol: string): WebSocketLike {
  const ws = new WebSocket(url, protocol);
  ws.binaryType = "arraybuffer";
  return ws as unknown as WebSocketLike;
}

/**
 * A real MACROTASK yield (`setTimeout`, not a bare Promise/microtask) —
 * Scope-IN's own wording for CATCHUP_CHUNK processing: "the client yields
 * to the event loop between chunks so the UI stays responsive." A
 * microtask alone (`Promise.resolve().then(...)`) never actually returns
 * control to the event loop's timer/render queue; only a macrotask
 * boundary does.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface SyncClientOptions {
  /** Full WebSocket URL up to and including `/v1/rt` (matches `.env.example`'s `VITE_WS_URL` shape) — SyncClient does not append {@link WS_PATH} itself. */
  readonly url: string;
  readonly documentId: string;
  /** Test-only injection point — see {@link WebSocketLike}. Defaults to the real global `WebSocket`. */
  readonly createSocket?: (url: string, protocol: string) => WebSocketLike;
  /** Test-only observability hook: called with the exact delay just scheduled, right before the reconnect timer is armed. */
  readonly onReconnectScheduled?: (delayMs: number) => void;
  /**
   * Test-only injection point for Phase 22's durable queue (API Spec §7.9)
   * — mirrors {@link createSocket}. Defaults to {@link openDurableQueue}
   * using the real global `indexedDB`. A test supplies a stub that
   * rejects/returns `null` to exercise DUR-09 (IndexedDB unavailable)
   * without needing a real private-browsing browser context (Test Plan
   * §3.6 DUR-09's own suggested approach), or one backed by
   * `fake-indexeddb` to exercise DUR-07/08's persistence-across-restart
   * behavior without a real browser crash.
   *
   * May return either a value directly OR a `Promise` — see
   * `beginConnect`'s own comment for why this dual shape exists (it is
   * what lets `connect()` stay perfectly synchronous, exactly matching
   * every pre-Phase-22 test's timing assumptions, whenever there is
   * genuinely no IndexedDB to restore from).
   */
  readonly openDurableQueue?: () => DurableQueue | null | Promise<DurableQueue | null>;
  /**
   * Test Plan RC-33e's own required negative control, per the phase brief's
   * explicit instruction: "build a variant that advances lastServerSeq per
   * chunk. This test must FAIL against it. Keep it permanently behind an
   * env flag." A browser-bundled class has no meaningful `process.env` of
   * its own, so this project's established DUR-04 pattern (an env var read
   * inside the shipped module, `writePath.ts`) is adapted to this file's
   * OWN existing test-injection convention instead (`createSocket`,
   * `openDurableQueue`) — same principle (the module that actually ships
   * is what gets toggled, never a parallel copy), different mechanism,
   * because THIS module runs in real browsers where an env var doesn't
   * exist to read. NEVER set outside `reconnection.test.ts`'s own RC-33e
   * case. See `handleCatchupChunk`'s doc comment for exactly what this
   * breaks and why.
   */
  readonly mutateAdvanceSeqPerChunk?: boolean;
}

/**
 * Browser-side connection manager (Scope-IN): owns the socket lifecycle,
 * the HELLO/WELCOME/SNAPSHOT/SYNC_COMPLETE handshake, the heartbeat, the
 * unacked-operation queue, sequence-gap detection (API Spec §3.7.5), and
 * reconnection backoff (§3.10). No UI, no DOM binding — `engine` is the
 * one public surface a future editor-binding phase reads from and mints
 * operations against via {@link localInsert}/{@link localDelete}.
 */
export class SyncClient {
  readonly documentId: string;

  /** Non-null once a handshake has completed at least once (fresh connect or reconnect) — reconstructed from scratch on every SNAPSHOT, never mutated in place. */
  engine: Engine | null = null;
  replicaId: number | null = null;
  sessionId: string | null = null;

  private readonly serverUrl: string;
  private readonly createSocket: (url: string, protocol: string) => WebSocketLike;
  private readonly onReconnectScheduled: ((delayMs: number) => void) | undefined;
  private readonly openDurableQueueFn: () => DurableQueue | null | Promise<DurableQueue | null>;

  private ws: WebSocketLike | null = null;
  private everSynced = false;
  private explicitlyOffline = true; // true until the first connect() call

  private readonly stateValue = new ObservableValue<ConnectionState>("offline");
  get state(): Observable<ConnectionState> {
    return this.stateValue;
  }

  /** PRD FR-OF-3: "connection state + unsynced-edit count" as UI-observable values, the same shape as {@link state} above. `unackedCount` (below) remains the plain, non-reactive snapshot every existing test already uses; this is the same number, exposed reactively for a real UI to subscribe to without polling. */
  private readonly unsyncedCountValue = new ObservableValue<number>(0);
  get unsyncedCount(): Observable<number> {
    return this.unsyncedCountValue;
  }
  private syncUnsyncedCountObservable(): void {
    this.unsyncedCountValue.set(this.unacked.size);
  }

  /** API Spec §3.6.2/§5.4: this session's own role, set from WELCOME and updated by PERMISSION_CHANGED (Phase 24, RC-32). `null` before the first WELCOME ever arrives. */
  private readonly roleValue = new ObservableValue<SessionRole | null>(null);
  get role(): Observable<SessionRole | null> {
    return this.roleValue;
  }

  /** Phase 24, API Spec §5.5/§10.5: how long/how many local ops since this client last left `synced` — see offlineWindow.ts. */
  private readonly offlineWindow = new OfflineWindowTracker();
  private readonly offlineWindowStatusValue = new ObservableValue<OfflineWindowStatus>({
    level: "none",
    elapsedMs: 0,
    opsCount: 0,
  });
  get offlineWindowStatus(): Observable<OfflineWindowStatus> {
    return this.offlineWindowStatusValue;
  }
  private refreshOfflineWindowStatus(): void {
    this.offlineWindowStatusValue.set(this.offlineWindow.status(Date.now()));
  }
  /**
   * Every operation this client has ever SENT, bounded (see below) — NOT the same as
   * `unacked` (which drops an entry the moment it's acked). Phase 24: a LATE OP_REJECT
   * (the offline-window sweep, `OFFLINE_WINDOW_EXCEEDED`) can arrive well after the SAME
   * operation was already acked — API Spec §6.3's ack-implies-durability design (Phase 16)
   * acks an operation the instant it's durably COMMITTED, independent of whether it ever
   * actually integrates into the live structure; an operation anchored to a node this server
   * has since garbage-collected (Phase 21) gets acked almost immediately (genuinely durable,
   * just permanently un-integratable) and only learns its true fate ~30s later, via this
   * sweep. Without this second, longer-lived memory, `handleOpsMessage`'s "opReject" case
   * would have nothing left to preserve for an already-acked stamp. Bounded (not unbounded) to
   * avoid a real memory leak over a long-running session — 10,000 entries comfortably covers
   * this phase's own DoD scenarios (RC-30's 2,100 operations, RC-32's 400) with headroom; a
   * bound this size, not exhaustively tuned, is a disclosed, reasonable choice, the same
   * latitude this project has taken for other not-fully-measured constants.
   */
  private readonly recentlySentOps = new Map<string, Operation>();
  private static readonly RECENTLY_SENT_CAP = 10_000;
  private rememberSentOp(op: Operation): void {
    const key = serializeId(op.id);
    this.recentlySentOps.set(key, op);
    if (this.recentlySentOps.size > SyncClient.RECENTLY_SENT_CAP) {
      const oldestKey = this.recentlySentOps.keys().next().value;
      if (oldestKey !== undefined) {
        this.recentlySentOps.delete(oldestKey);
      }
    }
  }

  /**
   * Every currently-preserved rejection (API Spec §5.5 step 1 — "move to the rejected store,
   * do not delete"). Populated ONLY via a genuine OP_REJECT (`handleOpsMessage`'s "opReject"
   * case) or restored from the durable `rejected` store at startup; cleared ONLY by
   * {@link discardRejected}'s own explicit call — nothing else in this file ever clears it.
   */
  private readonly rejectedOps = new Map<string, RejectedEntry>();
  private readonly rejectedCountValue = new ObservableValue<number>(0);
  /** PRD FR-PM-8: "states unambiguously which operations were saved and which were not" — the count half of that signal (`unsyncedCount` above is the "not yet known either way" half). */
  get rejectedCount(): Observable<number> {
    return this.rejectedCountValue;
  }

  private readonly backoff = new Backoff();
  private survivedTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  private readonly gapTracker = new SequenceGapTracker();

  private readonly unacked = new UnackedQueue();
  /** The seq PING reports — the highest seq this client has ever applied, NOT the gap tracker's contiguous value (§3.7.5's "apply anyway" means these can legitimately differ while a gap is open). */
  private highestAppliedSeq = 0;

  private durableQueue: DurableQueue | null = null;
  private durableInitStarted = false;
  /** PRD A-11: true once we've confirmed IndexedDB is unavailable (open failed/rejected, or the global doesn't exist at all) and this client has degraded to in-memory-only queueing. Never resets back to false — the degradation is for the lifetime of this page load, matching `openDurableQueueFn` only ever being attempted once (see `initDurableQueue`). */
  private durableQueueUnavailableValue = false;

  private readonly mutateAdvanceSeqPerChunk: boolean;

  /**
   * Serializes SNAPSHOT's/CATCHUP's tail work — chunk application (each
   * yielding to the event loop, Scope-IN) and ALREADY_HAVE reconciliation —
   * onto one promise chain, regardless of which state-sync mode this
   * handshake used. Reset to a trivially-resolved promise at the start of
   * every handshake (`onOpen`); SNAPSHOT touches it not at all (nothing to
   * serialize), so ALREADY_HAVE still runs correctly — one microtask later,
   * never racing anything. CATCHUP's `catchupChunk`/`catchupEnd` handlers
   * chain their own work onto it; `alreadyHave`'s handler chains onto
   * WHATEVER is currently at the tail, guaranteeing it only runs after
   * every chunk received so far (and its own yield) has actually finished
   * applying — never racing an async chunk-drain still in flight.
   */
  private handshakeGate: Promise<void> = Promise.resolve();
  /** The exact unacked stamps reported in THIS handshake's own HELLO — captured at send time (`onOpen`), consumed once by `handleAlreadyHave`. A local edit minted after HELLO but before ALREADY_HAVE arrives is NOT part of this set; see `onOpen`'s own comment for why that's an accepted, pre-existing edge case, not a Phase 23 regression. */
  private helloUnackedIds: readonly Identifier[] = [];
  /** CATCHUP progress bookkeeping (API Spec §3.6.4-§3.6.6) — diagnostic only, not consulted by any correctness logic (`handshakeGate`'s own promise chain is what actually serializes chunk application). */
  private catchupTotalOps = 0;
  private catchupReceivedOps = 0;

  constructor(opts: SyncClientOptions) {
    this.serverUrl = opts.url;
    this.documentId = opts.documentId;
    this.createSocket = opts.createSocket ?? defaultCreateSocket;
    this.onReconnectScheduled = opts.onReconnectScheduled;
    this.openDurableQueueFn = opts.openDurableQueue ?? openDurableQueue;
    this.mutateAdvanceSeqPerChunk = opts.mutateAdvanceSeqPerChunk ?? false;
  }

  /**
   * TEST-ONLY: seeds `engine` directly and marks this client `synced`,
   * bypassing a real handshake entirely — never called by production code.
   * This project's own test suites and e2e harnesses use it throughout to
   * exercise the input pipeline/sentinel/editor against a real `Engine`
   * without a real network (`sendFrame` already no-ops when `ws` is null,
   * which it stays here). Exists as a named, documented method — not a
   * bare `sync.engine = ...` assignment scattered across call sites —
   * specifically so it also flips `state` to `"synced"`: since Phase 14's
   * `requireEngine()` correction checks `state.value === "synced"`, not
   * just `engine !== null` (see that method's own doc comment for why),
   * a bare engine assignment alone no longer satisfies `localInsertText`/
   * `localDelete`/`localInsert`'s precondition.
   */
  seedForTesting(engine: Engine): void {
    this.engine = engine;
    this.setState("synced");
  }

  /**
   * Every `stateValue.set(...)` call in this class goes through here (Phase 24), rather than
   * directly, so the offline-window tracker's arm/disarm exactly mirrors "am I currently
   * synced" (offlineWindow.ts's own `noteSynced`/`noteNotSynced` are idempotent, so a
   * transition between two non-synced states, e.g. one failed reconnect attempt followed by
   * another, correctly does NOT reset the window).
   *
   * Deliberately NO periodic timer keeps `offlineWindowStatus` ticking over purely from wall-
   * clock time while idle (offline, but not typing) — it is refreshed here (every state
   * transition) and after every accepted local mint (`assertOfflineWindowNotExceeded`'s own
   * call site). A genuinely idle offline client (armed, never typing) will not see the
   * REACTIVE value cross the 8/10-minute marks until its NEXT edit attempt or state change —
   * an accepted, disclosed simplification, not an oversight: every DoD scenario this phase
   * builds against (RC-30) involves CONTINUOUS operations, so a mint-triggered refresh alone
   * is always sufficient there, and a `setInterval` that lives for as long as "not synced" (an
   * UNBOUNDED span — `offline` has no automatic path back) is exactly the shape of leaked-timer
   * bug this project has been burned by twice before (Phase 9's `Gateway.close()`, Phase 22's
   * Bug 4) — not worth the risk for a purely cosmetic idle-tick.
   */
  private setState(next: ConnectionState): void {
    this.stateValue.set(next);
    if (next === "synced") {
      this.offlineWindow.noteSynced();
    } else {
      this.offlineWindow.noteNotSynced(Date.now());
    }
    this.refreshOfflineWindowStatus();
  }

  /**
   * Opens (or re-opens) the connection. Safe to call once; automatic
   * reconnection after a drop does not need it called again.
   *
   * As of Phase 22, the FIRST call also kicks off the durable-queue init
   * (open IndexedDB, restore any operations a prior page load never got to
   * send — API Spec §7.9: "on document open, read before connecting so
   * HELLO.unacked is complete"). `openSocket()` is not called until that
   * settles (success OR fallback), so the very first HELLO this client
   * ever sends already reflects a complete restored unacked set. Every
   * SUBSEQUENT call (a real reconnect) skips straight to `openSocket()` —
   * the durable queue, once attached, stays attached for this page's whole
   * lifetime; there is nothing to restore again mid-session.
   */
  connect(): void {
    this.explicitlyOffline = false;
    this.setState(this.everSynced ? "reconnecting" : "connecting");
    this.beginConnect();
  }

  /**
   * Deliberately NOT an `async` method. `openDurableQueueFn()` may return
   * either a value directly or a genuine `Promise` (see its own doc
   * comment) — branching on `instanceof Promise` here, rather than always
   * `await`-ing, is what lets this whole method (and therefore
   * `openSocket()`) run perfectly SYNCHRONOUSLY whenever there is
   * genuinely no IndexedDB to restore from (this project's own
   * Vitest/jsdom test suite, and any environment without the global at
   * all): `await` on ANY value — even an already-resolved one — always
   * defers by at least one microtask in JavaScript, which would silently
   * break every pre-Phase-22 test's assumption that `connect()` opens the
   * socket immediately, synchronously, within the same call. Only when a
   * real (or injected) IndexedDB factory is actually present does this
   * method defer `openSocket()` behind the genuinely-async restore.
   */
  private beginConnect(): void {
    if (this.durableInitStarted) {
      this.openSocket(); // a real reconnect — the durable queue (or its absence) is already settled
      return;
    }
    this.durableInitStarted = true;
    const result = this.openDurableQueueFn();
    if (!(result instanceof Promise)) {
      this.applyDurableQueueSync(result);
      this.openSocket();
      return;
    }
    void this.finishAsyncDurableInit(result);
  }

  private applyDurableQueueSync(durable: DurableQueue | null): void {
    if (durable === null) {
      this.durableQueueUnavailableValue = true; // PRD A-11 — degrade to in-memory, warn
      return;
    }
    // A synchronously-available DurableQueue with nothing left to restore is not a shape any
    // real implementation produces today (loadUnacked/loadMeta are always genuinely async, so a
    // real open only ever reaches this method's OTHER (Promise) branch) — handled here for the
    // injection point's own interface completeness, not exercised by any current caller.
    this.unacked.attachDurable(durable, this.documentId);
    this.durableQueue = durable;
  }

  private async finishAsyncDurableInit(pending: Promise<DurableQueue | null>): Promise<void> {
    let durable: DurableQueue | null;
    try {
      durable = await pending;
    } catch {
      durable = null;
    }
    if (durable === null) {
      this.durableQueueUnavailableValue = true; // PRD A-11 — degrade to in-memory, warn
    } else {
      try {
        // Deliberately just these TWO reads, gating `openSocket()` below — both directly
        // determine what THIS handshake's own HELLO must say (API Spec §7.9: "read before
        // connecting so HELLO.unacked is complete"). `loadRejected` (Phase 24) is fetched
        // SEPARATELY, below, and does NOT gate the socket open: nothing on the handshake path
        // depends on it, and folding a THIRD real IndexedDB transaction into this same
        // Promise.all measurably slowed real startup enough to flip a genuine DUR-08 timing
        // race in this project's own test suite (a debounced flush that must NOT fire before
        // the next client's HELLO is inspected) — found by that suite, not anticipated.
        const [restoredOps, meta] = await Promise.all([
          durable.loadUnacked(this.documentId),
          durable.loadMeta(this.documentId),
        ]);
        this.unacked.restoreEntries(restoredOps);
        this.unacked.attachDurable(durable, this.documentId);
        this.durableQueue = durable;
        if (meta) {
          // Seeds HELLO's lastServerSeq from the last confirmed value BEFORE any real traffic
          // this session (API Spec §7.9: meta's fields are "what HELLO needs to reconnect
          // correctly").
          this.gapTracker.reset(meta.lastServerSeq);
          this.highestAppliedSeq = meta.lastServerSeq;
        }
        // Fire-and-forget: a page reload's preserved-rejections history (Rule 7.2's own
        // "preserved" requirement, not a handshake-critical value) can arrive a little later
        // without consequence — `listRejected()`/`rejectedCount` simply update once it resolves.
        durable
          .loadRejected(this.documentId)
          .then((restoredRejected) => this.restoreRejected(restoredRejected))
          .catch(() => {});
      } catch {
        // A read failure after a successful open degrades the same way an open failure would —
        // there is no partial-durability story worth building for this phase (DUR-09 is about
        // upfront unavailability, not a mid-init read error on an otherwise-working database).
        this.durableQueueUnavailableValue = true;
      }
    }
    this.openSocket();
  }

  /** Deliberately ends the session — no further automatic reconnection until {@link connect} is called again (API Spec §3.10 has no "give up" state of its own; this is that state, application-initiated). */
  disconnect(): void {
    this.explicitlyOffline = true;
    this.clearAllTimers();
    this.setState("offline");
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Scope-IN (Phase 24): "stops accepting new edits into the durable queue at the bound"
   * (10 minutes OR 2,000 operations since this client last left `synced`, whichever comes
   * first — Test Plan RC-30/RC-31, offlineWindow.ts). Checked and THROWN before `engine` is
   * ever touched, not after minting: minting first and only refusing to send/queue afterward
   * would leave the LOCAL engine (and anything rendering from it, e.g. a live `EditorView`)
   * reflecting content that was never durably captured — strictly worse for the user than a
   * clearly-signaled refusal up front, and it would leave `engine` and the durable queue
   * mutually inconsistent. `inputPipeline.ts` catches this specific error and no-ops (same
   * shape as its pre-existing "no engine yet" guard) rather than letting it escape a DOM event
   * handler uncaught.
   */
  private assertOfflineWindowNotExceeded(): void {
    if (!this.offlineWindow.canAccept(Date.now())) {
      throw new OfflineWindowExceededError();
    }
  }

  /** Mints and sends a local insert, exactly mirroring `Engine.localInsert`'s signature. Throws if not currently synced — there is no offline queue-and-replay in this phase (Phase 22's IndexedDB queue is what that becomes) — or if the offline window has been exceeded (Phase 24, see `assertOfflineWindowNotExceeded`). */
  localInsert(visibleIndex: number, value: number, bind?: boolean): InsertOperation {
    const engine = this.requireEngine();
    this.assertOfflineWindowNotExceeded();
    const op =
      bind === undefined
        ? engine.localInsert(visibleIndex, value)
        : engine.localInsert(visibleIndex, value, bind);
    this.offlineWindow.noteOperationAccepted();
    this.refreshOfflineWindowStatus();
    this.sendOperation(op);
    return op;
  }

  /** Mints and sends local deletes, mirroring `Engine.localDelete`. Same offline-window gate as {@link localInsert} — see `assertOfflineWindowNotExceeded`. */
  localDelete(visibleIndex: number, count: number): readonly DeleteOperation[] {
    const engine = this.requireEngine();
    this.assertOfflineWindowNotExceeded();
    const ops = engine.localDelete(visibleIndex, count);
    for (const op of ops) {
      this.offlineWindow.noteOperationAccepted();
      this.sendOperation(op);
    }
    this.refreshOfflineWindowStatus();
    return ops;
  }

  /**
   * Mints one local insert per scalar in `text` (in ascending position
   * order, starting at `visibleIndex`), then sends the RESULT as the
   * fewest possible OPS frames rather than one frame per character (Phase
   * 12, API Spec §3.5.2) — see {@link operationsToRunMessages} for the
   * coalescing rule this relies on. Each underlying character is still a
   * genuinely separate `Engine.localInsert()` call, producing exactly the
   * chained-`originLeft`/shared-`originRight` node shape Phase 7's own
   * 2,000-character equivalence test already verified `expandInsertRun`
   * reconstructs correctly on the receiving side — only the WIRE
   * representation is batched here, not the engine's own integration.
   *
   * Same offline-window gate as {@link localInsert}/{@link localDelete} — Phase 24, see
   * `assertOfflineWindowNotExceeded`. Checked ONCE, before minting anything: a large paste
   * that would straddle the cap boundary is refused IN FULL, never partially applied — a
   * simpler, disclosed rule than splitting one call across the boundary, and consistent with
   * "the client stops accepting new edits AT the bound" reading the cap as gating whole edits,
   * not partial ones.
   */
  localInsertText(visibleIndex: number, text: string): readonly InsertOperation[] {
    const engine = this.requireEngine();
    this.assertOfflineWindowNotExceeded();
    const ops: InsertOperation[] = [];
    let at = visibleIndex;
    for (const ch of text) {
      // `for...of` iterates a string by code point, not UTF-16 code unit — required for
      // correct surrogate-pair handling (see unicodeOffsets.ts's own doc comment).
      const codePoint = ch.codePointAt(0)!;
      ops.push(engine.localInsert(at, codePoint));
      at += 1;
      this.offlineWindow.noteOperationAccepted();
    }
    this.refreshOfflineWindowStatus();
    // API Spec §7.9: "written in applyLocal before or concurrently with transmission, never
    // after" — the durable-queue add (via unacked.add, which schedules the IndexedDB write)
    // must happen BEFORE sendFrame below, not after. A crash between these two loops (in the
    // old order) would have transmitted content the durable store never actually recorded —
    // exactly the inconsistency this ordering rule exists to prevent.
    for (const op of ops) {
      this.unacked.add(op);
      this.rememberSentOp(op);
    }
    this.syncUnsyncedCountObservable();
    for (const msg of operationsToRunMessages(ops)) {
      this.sendFrame(encodeFrame(msg));
    }
    return ops;
  }

  /**
   * Number of locally-sent operations not yet acknowledged (API Spec
   * §7.9) — this IS the "unsynced-edit count" PRD FR-OF-3/Scope-IN asks
   * the UI to display. Backed by `UnackedQueue`'s in-memory map, which is
   * kept exactly consistent with what's durable: `ack()` schedules the
   * durable removal BEFORE deleting in-memory (see unackedQueue.ts's own
   * comment), so this count never overstates what has actually survived a
   * crash up to this point — Test Plan DUR-08's own stated failure
   * condition is a count that DOES overstate, not data loss itself.
   */
  get unackedCount(): number {
    return this.unacked.size;
  }

  get hasSequenceGap(): boolean {
    return this.gapTracker.hasGap;
  }

  /** How many reconnect attempts have been made since the backoff counter last reset (API Spec §3.10) — real observability (a UI can show "reconnecting, attempt 3..."), not only a test hook. */
  get reconnectAttemptCount(): number {
    return this.backoff.attemptCount;
  }

  /**
   * Requires a non-null engine. Phase 14 originally ALSO required
   * `state.value === "synced"`, specifically to block editing during the
   * "reconnecting" window between an old connection dropping and a fresh
   * SNAPSHOT replacing `engine` wholesale — otherwise a local edit would
   * apply to the OLD (soon-to-be-discarded) engine reference, attempt to
   * send over an already-dead socket, and then be silently ORPHANED the
   * instant the new snapshot replaced `engine` (a real, confirmed
   * data-loss path from that phase's own DoD verification).
   *
   * Phase 22 REMOVES that state check, deliberately: it is exactly the gap
   * this phase's durable queue + `reconcileOfflineQueue` close, not a
   * regression of Phase 14's fix. An edit minted while `reconnecting` (or
   * `offline`) now: (a) applies to the CURRENT `engine` reference — still
   * correct, since `engine` is only ever replaced by `handleSnapshot`, not
   * mutated out from under a caller mid-call; (b) is durably queued via
   * `sendOperation`/`UnackedQueue.add` (API Spec §7.9), surviving even a
   * full browser crash; (c) is silently no-op'd on the wire by
   * `sendFrame`'s existing `this.ws?.send(...)` guard while no socket
   * exists; and (d) is reconciled against the NEXT fresh SNAPSHOT's engine
   * by `handleSnapshot` — see `reconcileOfflineQueue.ts`. Nothing is
   * orphaned anymore; the old bug's fix was "block editing," the new fix
   * is "make editing during that window actually safe."
   */
  private requireEngine(): Engine {
    if (!this.engine) {
      throw new Error("SyncClient: no engine yet — call after the first SNAPSHOT has been received");
    }
    return this.engine;
  }

  /** PRD A-11: true once IndexedDB has been confirmed unavailable (open failed/rejected, or the global doesn't exist) and this client has degraded to in-memory-only queueing for the rest of this page load. The caller (ConnectionIndicator/App) is expected to surface this explicitly — silent degradation of a durability promise is the failure condition Test Plan DUR-09 exists to catch. */
  get durableQueueUnavailable(): boolean {
    return this.durableQueueUnavailableValue;
  }

  private sendOperation(op: Operation): void {
    this.unacked.add(op);
    this.rememberSentOp(op);
    this.syncUnsyncedCountObservable();
    this.sendFrame(encodeFrame(operationToOpsMessage(op)));
  }

  private sendControl(msg: ControlMessage): void {
    this.sendFrame(encodeControlFrame(msg));
  }

  private sendFrame(bytes: Uint8Array): void {
    // No priority-queue layer client-side this phase (unlike the server's ConnectionSendQueues,
    // Phase 8) — Scope-IN for this phase lists only connect/handshake/send/receive/disconnect,
    // and nothing in the DoD exercises client-side send prioritization.
    this.ws?.send(bytes);
  }

  private openSocket(): void {
    const ws = this.createSocket(`${this.serverUrl}`, WS_SUBPROTOCOL);
    this.ws = ws;
    // Stale-socket guard (same pattern as the Phase 22 Bug 4 leftover-timer fix): `disconnect()`
    // closes the old socket and reassigns `this.ws` SYNCHRONOUSLY, without waiting for that old
    // socket's own asynchronous 'close' event — so a real reconnect (a fresh `connect()` right
    // after) can already be on a NEW socket by the time the OLD socket's delayed open/message/
    // close event actually fires. Without this `ws !== this.ws` check, that late event still ran
    // unconditionally against whatever `this.ws` CURRENTLY is: a stale `onclose` in particular
    // would find `explicitlyOffline` already flipped back to `false` by the new `connect()`,
    // misread itself as an unexpected drop of the CURRENT connection, and call
    // `scheduleReconnect()` — opening a THIRD socket and reassigning `this.ws` to it while it's
    // still CONNECTING. Any send racing against that reassignment then throws a real
    // InvalidStateError (readyState CONNECTING is the ONLY state `WebSocket.send()` throws for,
    // per the WHATWG spec — CLOSING/CLOSED are silent no-ops). This was the actual, previously
    // undiagnosed mechanism behind `reconnection.test.ts`'s RC-27 flake (measured 60-80% under
    // its own rapid repeated disconnect/reconnect cycling, on both this branch and unmodified
    // Phase 23 — confirmed pre-existing, not a regression) that CLAUDE.md had previously
    // (incorrectly) attributed to vague "PING/PONG timing under load."
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.onOpen();
    };
    ws.onmessage = (ev: { data: unknown }) => {
      if (ws !== this.ws) return;
      this.onMessage(ev);
    };
    ws.onclose = (ev: { code: number; reason: string }) => {
      if (ws !== this.ws) return;
      this.onClose(ev);
    };
    ws.onerror = () => {}; // 'close' always follows for WebSocket; nothing separate to do
  }

  private onOpen(): void {
    this.armSurvivedTimer();
    this.handshakeGate = Promise.resolve(); // fresh handshake — see this field's own doc comment
    // Captured HERE, not read fresh later, because `this.unacked` can legitimately gain entries
    // AFTER this HELLO is sent but BEFORE ALREADY_HAVE arrives — Phase 22's relaxed
    // requireEngine() allows minting during "reconnecting". Those later entries are simply not
    // part of what THIS handshake's ALREADY_HAVE/reconcile step reasons about; they are handled
    // the ordinary way (sendOperation transmits them directly once the socket is actually open)
    // and get their own chance to reconcile on the NEXT handshake if this one doesn't reach them.
    this.helloUnackedIds = this.unacked.ids();
    const hasResidentEngine = this.engine !== null;
    this.sendControl({
      kind: "hello",
      documentId: this.documentId,
      ticket: new Uint8Array(), // no auth yet (Phase 29) — "accept any bytes" server-side
      lastServerSeq: this.gapTracker.value,
      unacked: this.helloUnackedIds,
      clientCapabilities:
        CLIENT_CAP_ACCEPTS_OP_INSERT_RUN |
        CLIENT_CAP_ACCEPTS_STRUCTURE_SNAPSHOT |
        (hasResidentEngine ? CLIENT_CAP_HAS_RESIDENT_ENGINE : 0),
    });
  }

  private onMessage(ev: { data: unknown }): void {
    const bytes = new Uint8Array(ev.data as ArrayBuffer);
    const channel = peekChannel(bytes);
    if (channel === Channel.OPS) {
      let msg: OpsMessage;
      try {
        msg = decodeFrame(bytes, { direction: "serverOrigin" });
      } catch {
        return; // a malformed frame from a trusted server is ignored, not fatal, this phase
      }
      this.handleOpsMessage(msg);
    } else if (channel === Channel.CONTROL) {
      let msg: ControlMessage;
      try {
        msg = decodeControlFrame(bytes, { direction: "serverOrigin" });
      } catch {
        return; // a malformed frame from a trusted server is ignored, not fatal, this phase
      }
      this.handleControl(msg);
    }
  }

  private handleControl(msg: ControlMessage): void {
    switch (msg.kind) {
      case "welcome":
        this.replicaId = msg.replicaId;
        this.sessionId = msg.sessionId;
        this.roleValue.set(msg.role);
        // ALREADY_CURRENT sends no further state-sync payload (no snapshot, no catchupBegin) —
        // but this client's engine STILL needs rebuilding under the new replica id, from a
        // clean base (see rebuildEngineForReconnect's own doc comment for why skipping this
        // was a real, confirmed bug: reconciling offline edits against the OLD engine object
        // mints them under the OLD, now-invalid replica id, which the server's write path
        // silently rejects as IDENTITY_MISMATCH). SNAPSHOT/CATCHUP handle their own rebuild
        // in handleSnapshot/handleCatchupBegin once their own payload arrives.
        if (msg.syncMode === SyncMode.ALREADY_CURRENT) {
          this.rebuildEngineForReconnect();
        }
        break;
      case "snapshot":
        this.handleSnapshot(msg.seq, msg.form, msg.body);
        break;
      case "catchupBegin":
        this.handleCatchupBegin(msg.totalOps);
        break;
      case "catchupChunk":
        this.handleCatchupChunk(msg.throughSeq, msg.ops);
        break;
      case "catchupEnd":
        this.handleCatchupEnd(msg.toSeq);
        break;
      case "alreadyHave":
        this.handleAlreadyHave(msg.alreadyHave);
        break;
      case "pong":
        // Phase 22 fix (found by this phase's own DUR-07 e2e test, unrelated to the durable
        // queue itself): a PONG proves the connection is alive even when nothing has been
        // edited — see gapTracker.ts's `markAlive()` doc comment for the full account of the
        // false-positive "stalled" reconnect this closes.
        this.gapTracker.markAlive();
        break;
      case "permissionChanged":
        // API Spec §5.4/§5.5, Phase 24 (RC-32) — a real, if minimal, notification: this
        // session's role has changed. Deliberately does NOT itself reject/discard anything
        // client-side — the server's own write path (writePath.ts's `authorize` step) is what
        // actually rejects any operation this session sends while its role disallows mutation;
        // this only keeps `role` accurate for a UI (or a future client-side pre-check) to read.
        this.roleValue.set(msg.role);
        break;
      case "goodbye":
      case "error":
        break; // no special GOODBYE/ERROR handling this phase — 'close' drives reconnection either way
      default:
        break; // hello/syncComplete/ping/leave are client-origin only; decodeControlFrame already enforces this
    }
  }

  /**
   * SNAPSHOT (API Spec §3.6.3): builds a BRAND-NEW engine from the
   * server's own full structure. As of Phase 23, this method's job stops
   * at building/seeding the engine and advancing sequence tracking —
   * reconciling this client's own unacked queue against it now happens
   * uniformly for every sync mode (SNAPSHOT/CATCHUP/ALREADY_CURRENT) once
   * ALREADY_HAVE arrives, via `handshakeGate` — see
   * `finishHandshakeAfterAlreadyHave`. Before Phase 23, this method
   * unconditionally reconciled/resent EVERY unacked operation the instant
   * SNAPSHOT arrived; that was a genuine duplication risk this phase
   * closes (RC-33d/RC-28's own race: an operation that reached the server
   * and is ALREADY reflected in this very SNAPSHOT would have been
   * blindly re-minted and resent as a SECOND copy) — see
   * AlreadyHaveMessage's own doc comment.
   */
  private handleSnapshot(seq: number, form: SnapshotForm, body: Uint8Array): void {
    if (this.replicaId === null) {
      return; // SNAPSHOT before WELCOME would be a protocol violation from the server — ignore defensively rather than throw
    }
    // form is always STRUCTURE from this project's server (every session is hardcoded EDITOR,
    // API Spec §3.6.3 forbids form:0 for editor/owner) — but decode plain text too, defensively,
    // rather than assume the server can never legally send it.
    if (form === SnapshotForm.STRUCTURE) {
      this.engine = seedEngineFromSnapshot(this.replicaId, decodeStructureSnapshotBody(body));
    } else {
      this.engine = new Engine(this.replicaId);
    }
    this.gapTracker.reset(seq);
    this.highestAppliedSeq = seq;
    this.persistMeta();
    // handshakeGate is left exactly as onOpen() set it (trivially resolved) — SNAPSHOT does no
    // async chunked work, so ALREADY_HAVE's own handler (chained onto handshakeGate) runs
    // correctly the moment it arrives, one microtask later.
  }

  /**
   * Rebuilds `engine` for a CATCHUP or ALREADY_CURRENT reconnect — a new
   * replica id always means a new `Engine` instance (`Engine.replicaId` is
   * fixed at construction) — seeded from THIS CLIENT'S OWN currently-
   * resident engine (`replaySnapshotNodesInto`, the same function the
   * server's own warm start and this client's SNAPSHOT path both already
   * use), never from a server-sent structure payload: the whole point of
   * CATCHUP/ALREADY_CURRENT is that the server does NOT need to
   * re-transmit content this client already has.
   *
   * The seed is `buildCleanCatchupBase`-filtered, NOT `this.engine.nodes`
   * verbatim — see that function's own doc comment for the real,
   * RC-*-matrix-confirmed bug this closes: this client's OWN currently-
   * resident engine may already contain operations minted OFFLINE that
   * were never acknowledged (`Engine.localInsert`/`localDelete` mutate
   * synchronously at mint time, regardless of transmission). Seeding the
   * fresh engine from that UNFILTERED list, then separately reconciling
   * the SAME queued operations later (`finishHandshakeAfterAlreadyHave`),
   * would mint a duplicate anchored to a node that was never transmitted
   * and can never resolve on any other replica — a silently, permanently
   * orphaned operation on every peer.
   */
  private rebuildEngineForReconnect(): void {
    if (this.replicaId === null) {
      return; // WELCOME hasn't arrived yet — unreachable in practice, since only WELCOME's own handler and handleCatchupBegin (itself gated on replicaId) call this
    }
    const fresh = new Engine(this.replicaId);
    if (this.engine) {
      const unackedIds = new Set(this.unacked.values().map((op) => serializeId(op.id)));
      replaySnapshotNodesInto(fresh, buildCleanCatchupBase(this.engine.nodes, unackedIds));
    }
    this.engine = fresh;
  }

  /**
   * CATCHUP_BEGIN (API Spec §3.6.4): a delta sync is starting. Rebuilds
   * `engine` (see {@link rebuildEngineForReconnect}), then `catchupChunk`/
   * `catchupEnd` apply the missed delta on top.
   *
   * The server is only ever expected to offer CATCHUP to a client that
   * advertised `CLIENT_CAP_HAS_RESIDENT_ENGINE` in HELLO (`decideSyncMode`,
   * packages/server/src/handshake.ts) — `rebuildEngineForReconnect`'s own
   * `this.engine === null` branch is unreachable in practice there, kept
   * only as a defensive fallback rather than a silent crash if that
   * contract is ever violated.
   */
  private handleCatchupBegin(totalOps: number): void {
    if (this.replicaId === null) {
      return; // CATCHUP_BEGIN before WELCOME would be a protocol violation from the server — ignore defensively
    }
    this.rebuildEngineForReconnect();
    this.catchupTotalOps = totalOps;
    this.catchupReceivedOps = 0;
    this.handshakeGate = Promise.resolve(); // this handshake's own chunk-drain chain starts here
  }

  /**
   * CATCHUP_CHUNK (API Spec §3.6.5). Chains this chunk's application onto
   * `handshakeGate` — applying every operation via `engine.applyRemote()`
   * (idempotent/causally-buffered regardless of arrival order, same as any
   * live OPS frame), THEN a real macrotask yield (Scope-IN: "the client
   * yields to the event loop between chunks so the UI stays responsive"),
   * before the chain becomes available to the NEXT chunk or to CATCHUP_END/
   * ALREADY_HAVE's own chained work.
   *
   * // lastServerSeq advances only here, at CATCHUP_END — never per chunk. A client
   * // that advances per chunk and then loses the socket mid-catch-up requests the
   * // wrong range on reconnect and SILENTLY SKIPS operations. API Spec §11.5.
   *
   * `mutateAdvanceSeqPerChunk` (Test Plan RC-33e, permanently gated,
   * production NEVER sets it) is the deliberately-broken alternative the
   * comment above warns about: it advances tracked progress the INSTANT a
   * chunk is RECEIVED — synchronously, in this method, before the chunk's
   * own operations have actually finished applying via the (necessarily
   * async, yield-including) chain above. If the socket dies in the window
   * between "this chunk's progress was optimistically recorded" and "this
   * chunk's operations actually finished applying" (fully realistic: chunks
   * can arrive back-to-back in one network read, well before the first
   * one's own yield resolves), a reconnect's HELLO reports a
   * `lastServerSeq` further ahead than what this engine actually has —
   * the server computes the retry's delta range starting AFTER that point,
   * so this chunk's own operations are never sent again. RC-33e's own job
   * is to prove this is a REAL, reachable bug, not a hypothetical one.
   */
  private handleCatchupChunk(throughSeq: number, ops: readonly Operation[]): void {
    if (this.mutateAdvanceSeqPerChunk) {
      this.gapTracker.observe(throughSeq);
      this.highestAppliedSeq = Math.max(this.highestAppliedSeq, throughSeq);
      this.persistMeta();
    }
    this.handshakeGate = this.handshakeGate
      .then(() => {
        const engine = this.engine;
        if (!engine) {
          return;
        }
        for (const op of ops) {
          engine.applyRemote(op);
        }
        this.catchupReceivedOps += ops.length;
      })
      .then(() => yieldToEventLoop());
  }

  /**
   * CATCHUP_END (API Spec §3.6.6) — see `handleCatchupChunk`'s own doc
   * comment for the required, load-bearing comment this implements and
   * why. Chained onto `handshakeGate` so it only runs once every chunk
   * received so far has genuinely finished applying, never racing an
   * in-flight chunk.
   */
  private handleCatchupEnd(toSeq: number): void {
    this.handshakeGate = this.handshakeGate.then(() => {
      // lastServerSeq advances only here, at CATCHUP_END — never per chunk. A client
      // that advances per chunk and then loses the socket mid-catch-up requests the
      // wrong range on reconnect and SILENTLY SKIPS operations. API Spec §11.5.
      this.gapTracker.observe(toSeq);
      this.highestAppliedSeq = Math.max(this.highestAppliedSeq, toSeq);
      this.persistMeta();
    });
  }

  /**
   * ALREADY_HAVE (API Spec §3.6.7) — the tail shared by every sync mode.
   * Chains onto `handshakeGate` so it runs strictly after SNAPSHOT (trivial,
   * already resolved) or every CATCHUP chunk received so far (including
   * CATCHUP_END's own final advance) has completed.
   */
  private handleAlreadyHave(alreadyHave: readonly Identifier[]): void {
    void this.handshakeGate.then(() => this.finishHandshakeAfterAlreadyHave(alreadyHave));
  }

  /**
   * Splits THIS handshake's own reported unacked stamps (`helloUnackedIds`)
   * into two groups against `alreadyHave`: stamps the server already has
   * durably committed are acknowledged LOCALLY (never reconciled/resent —
   * their content is already reflected in whatever engine state this
   * handshake just built); every other stamp still present in `unacked` is
   * the genuine remainder, reconciled via `reconcileOfflineQueue` exactly
   * as every sync mode has always done. Then sends SYNC_COMPLETE and
   * transitions to `synced` — the single tail every sync mode converges on.
   */
  private finishHandshakeAfterAlreadyHave(alreadyHave: readonly Identifier[]): void {
    const engine = this.engine;
    if (!engine) {
      return; // defensive — unreachable in practice, since every path that reaches here already set engine
    }
    const alreadyHaveSet = new Set(alreadyHave.map((id) => serializeId(id)));
    const toReconcile: Operation[] = [];
    for (const id of this.helloUnackedIds) {
      const op = this.unacked.get(id);
      if (!op) {
        continue; // already acked/removed some other way since HELLO was sent
      }
      this.unacked.ack(id); // either already-committed (server confirms it via ALREADY_HAVE) or about to be superseded by a freshly-reconciled resend — either way, this exact stamp is done
      if (!alreadyHaveSet.has(serializeId(id))) {
        toReconcile.push(op);
      }
    }
    this.syncUnsyncedCountObservable();
    const resent = reconcileOfflineQueue(engine, toReconcile);
    // Coalesced (Phase 24), not one sendOperation() per op: a reconnection reconciliation can
    // be large (Test Plan RC-32: 400 operations), and this is what lets the server's own
    // rejection of the whole batch (e.g. PERMISSION_DENIED) arrive back as ONE OP_REJECT — see
    // operationsToWireMessages's own doc comment. Each op is still tracked INDIVIDUALLY in
    // `unacked`/`recentlySentOps`, exactly as sendOperation would — only the WIRE representation
    // is batched, matching localInsertText's own established add-then-coalesced-send split.
    for (const op of resent) {
      this.unacked.add(op);
      this.rememberSentOp(op);
    }
    this.syncUnsyncedCountObservable();
    for (const msg of operationsToWireMessages(resent)) {
      this.sendFrame(encodeFrame(msg));
    }

    this.sendControl({
      kind: "syncComplete",
      lastServerSeq: this.highestAppliedSeq,
      resentCount: resent.length,
    });

    this.everSynced = true;
    this.setState("synced");
    this.startPingTimer();
  }

  /** Batches a `meta` row write (API Spec §7.9's exact three fields) whenever `replicaId`/`highestAppliedSeq` change — a no-op if the durable queue isn't attached (in-memory-only degradation, PRD A-11). */
  private persistMeta(): void {
    if (!this.durableQueue || this.replicaId === null) {
      return;
    }
    this.durableQueue.scheduleWriteMeta({
      documentId: this.documentId,
      lastServerSeq: this.highestAppliedSeq,
      replicaId: this.replicaId,
      updatedAt: Date.now(),
    });
  }

  /**
   * OP_ACK/OP_REJECT (S→C only, API Spec §3.5.7/§3.5.8) carry no `seq` of
   * their own — they are batch acknowledgment/rejection frames, not
   * operations to apply — so they are handled separately from the five
   * bidirectional OPS types here, before any code assumes every OPS
   * message has a `.seq`. The server has sent real OP_REJECTs since Phase
   * 16 (IDENTITY_MISMATCH/RATE_LIMITED) and, as of Phase 24, also
   * PERMISSION_DENIED (writePath.ts's real `authorize` check) and
   * OFFLINE_WINDOW_EXCEEDED (the server's own offline-window sweep,
   * offlineWindowScheduler.ts).
   */
  private handleOpsMessage(msg: OpsMessage): void {
    switch (msg.kind) {
      case "opAck":
        for (const ack of msg.acks) {
          this.unacked.ack(ack.ackedId);
        }
        this.syncUnsyncedCountObservable();
        break;
      case "opReject": {
        // Preserve, never destroy. PRD §2.1: one destroyed paragraph costs more than a
        // hundred smooth sessions earn, and a user who cannot retrieve their text will
        // not trust the product again. API Spec §5.5.
        //
        // No retry/error-surface logic this phase — a rejected operation is simply given up on
        // (unchanged since Phase 10) — but as of Phase 22/24 it is never silently discarded
        // either: `preserveRejected` below moves it into the `rejected` store (durable AND
        // in-memory), reachable afterward via `listRejected()`/`exportLocalText()`, and cleared
        // only by an explicit `discardRejected()` call this file never makes on its own.
        //
        // `this.unacked.get(...)` alone is not always enough to recover the operation's own
        // content: API Spec §6.3's ack-implies-durability design (Phase 16) can ack an
        // operation the instant it's durably committed, well BEFORE a LATE rejection (Phase
        // 24's offline-window sweep, ~30s later) ever arrives — by then `unacked` has already
        // deleted it. `recentlySentOps` (see its own doc comment) is the fallback that still
        // has it.
        for (const rejected of msg.rejects) {
          const op =
            this.unacked.get(rejected.rejectedId) ??
            this.recentlySentOps.get(serializeId(rejected.rejectedId));
          this.unacked.ack(rejected.rejectedId); // harmless no-op if this stamp was never (or is no longer) in `unacked`
          if (op) {
            this.preserveRejected(op, rejected.reason, msg.detail);
          }
        }
        this.syncUnsyncedCountObservable();
        break;
      }
      default:
        this.handleOps(msg.seq, toOperations(msg));
        break;
    }
  }

  /** Populates `rejectedOps` from a durable restore (a prior page load's preserved rejections, read back before this client even opens a socket) — a page reload is exactly the scenario Rule 7.2's "preserved" requirement exists for, not only a same-session late OP_REJECT. */
  private restoreRejected(records: readonly RejectedRecord[]): void {
    for (const record of records) {
      this.rejectedOps.set(serializeId(record.op.id), {
        op: record.op,
        reason: record.reason,
        detail: record.detail,
        rejectedAt: record.rejectedAt,
      });
    }
    this.rejectedCountValue.set(this.rejectedOps.size);
  }

  /** API Spec §5.5 step 1 ("move to the rejected store, do not delete") + step 3 ("show which operations saved and which did not") — the shared tail every `opReject` entry goes through, regardless of reason code. */
  private preserveRejected(op: Operation, reason: RejectReason, detail: string): void {
    const key = serializeId(op.id);
    this.rejectedOps.set(key, { op, reason, detail, rejectedAt: Date.now() });
    this.rejectedCountValue.set(this.rejectedOps.size);
    if (this.durableQueue) {
      this.durableQueue.scheduleWriteRejected({
        documentId: this.documentId,
        op,
        reason,
        detail,
        rejectedAt: Date.now(),
      });
    }
  }

  /** Every rejected operation currently preserved (API Spec §5.5 step 1/3). Never populated except via a genuine OP_REJECT (or restored from the durable store at startup); never cleared except by {@link discardRejected}'s own explicit call. */
  listRejected(): RejectedEntry[] {
    return Array.from(this.rejectedOps.values());
  }

  /** API Spec §5.5 step 4 — "Offer Export unsaved changes: a plain-text download of engine.materialize()." A plain-text snapshot of this client's OWN current local document state. Never throws — an empty string before the first SNAPSHOT is a valid, if uninteresting, export. */
  exportLocalText(): string {
    return this.engine?.text() ?? "";
  }

  /**
   * API Spec §5.5 step 5 — "discard local-only state only after an explicit user action."
   * Clears the preserved-rejected record, in-memory AND durable. Nothing in this file EVER
   * calls this on its own — it exists solely to be called in direct response to a caller's own
   * explicit request (e.g. a real "Discard" button click, wired by a future UI phase). Does
   * NOT touch `engine`/`unacked` — discarding a REJECTION record is not the same as discarding
   * the document itself, which this method never does.
   */
  discardRejected(): void {
    this.rejectedOps.clear();
    this.rejectedCountValue.set(0);
    if (this.durableQueue) {
      void this.durableQueue.clearRejected(this.documentId).catch(() => {});
    }
  }

  private handleOps(seq: number, ops: Operation[]): void {
    const engine = this.engine;
    if (!engine) {
      return; // an OPS frame before handshake completes would be a server protocol violation — ignore
    }
    // "Client MUST: apply the operation anyway" (§3.7.5) — applying happens unconditionally,
    // BEFORE any gap bookkeeping below, regardless of whether seq is contiguous.
    for (const op of ops) {
      engine.applyRemote(op);
    }
    // As of Phase 16, `seq` is the STARTING seq of the range this frame occupies — a run/batch
    // of N operations consumes seq..seq+N-1 (documentCoordinator.ts's own doc comment explains
    // why operations.seq had to become per-operation, not per-frame). The highest seq this
    // frame actually covers is therefore the END of that range, not `seq` itself — using `seq`
    // alone here would make the gap tracker see every multi-operation frame as leaving a
    // "gap" of its own operations, which are not actually missing.
    const endSeq = ops.length > 0 ? seq + ops.length - 1 : seq;
    this.highestAppliedSeq = Math.max(this.highestAppliedSeq, endSeq);
    this.gapTracker.observe(endSeq);
    this.persistMeta(); // batched (durableQueue.ts's 200ms trailing edge) — keeps meta.lastServerSeq reasonably fresh for a LATER crash, not just immediately post-snapshot
    // Reconnection off a stalled `gapTracker` is checked on the ping cadence (`startPingTimer`),
    // not armed here — see gapTracker.ts's own doc comment for why a per-call timer keyed off
    // "any single missing seq number" was the actual bug this phase found and fixed.
    if (ops.length > 0) {
      this.notifyRemoteOpsApplied();
    }
  }

  private readonly remoteOpsListeners = new Set<() => void>();

  /**
   * Subscribes to "one or more REMOTE operations were just applied to
   * `engine`" (Phase 14 — this client's own local edits do NOT fire this;
   * `EditorView` already updates the DOM for those directly via
   * `DomWriter`). Without this, nothing tells the DOM layer a peer's edit
   * landed at all — `engine.text()` converges correctly on its own, but a
   * live `EditorView` would keep showing only this session's own edits
   * forever, discovered by actually running the two-window manual demo
   * this milestone exists to prove, not predicted in advance. Returns an
   * unsubscribe function.
   */
  onRemoteOpsApplied(listener: () => void): () => void {
    this.remoteOpsListeners.add(listener);
    return () => {
      this.remoteOpsListeners.delete(listener);
    };
  }

  private notifyRemoteOpsApplied(): void {
    for (const listener of this.remoteOpsListeners) {
      listener();
    }
  }

  private onClose(_ev: { code: number; reason: string }): void {
    this.clearPerConnectionTimers();
    this.ws = null;
    // `engine` is intentionally left as-is (last known state) rather than nulled — a future
    // reconnect fully replaces it via a new SNAPSHOT; there's no reason to blank out readable
    // state in between for a caller (or future UI) that only wants to keep displaying it.
    if (this.explicitlyOffline) {
      this.setState("offline");
      return;
    }
    this.setState("reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delayMs = this.backoff.nextDelayMs();
    this.onReconnectScheduled?.(delayMs);
    this.reconnectTimer = setTimeout(() => this.openSocket(), delayMs);
  }

  /** API Spec §3.10: "a socket survives 60 seconds" — timed from the socket's own `open`, not from full handshake completion (a socket that opens but never completes a handshake has, per that literal wording, still "survived"; this project's real server always completes the handshake near-instantly in practice, so the distinction is untested territory rather than a live concern). */
  private armSurvivedTimer(): void {
    this.survivedTimer = setTimeout(() => this.backoff.reset(), BACKOFF_RESET_AFTER_MS);
  }

  /**
   * Sends PING on every tick UNLESS `gapTracker.hasStalled()` — reusing the
   * existing ping cadence to periodically re-check for a genuine stall,
   * rather than a separate one-shot timer armed the instant any single gap
   * opens (Phase 14's own correction — see gapTracker.ts's doc comment).
   * The tradeoff: a real stall is detected somewhere between 5s and
   * `5s + PING_INTERVAL_MS` after it begins, not at exactly 5s — acceptable
   * for a resilience heuristic, and far simpler than maintaining a second,
   * independently-armed/cleared timer.
   */
  private startPingTimer(): void {
    this.pingTimer = setInterval(() => {
      if (this.gapTracker.hasStalled()) {
        this.ws?.close();
        return; // don't also send a PING on a socket we just decided to close
      }
      this.sendControl({
        kind: "ping",
        clientTimeMs: Date.now(),
        lastAppliedSeq: this.highestAppliedSeq,
      });
    }, PING_INTERVAL_MS);
  }

  /** Timers tied to ONE connection's lifetime — always cleared on close, whether that close leads to a reconnect or to `offline`. */
  private clearPerConnectionTimers(): void {
    if (this.survivedTimer !== undefined) {
      clearTimeout(this.survivedTimer);
      this.survivedTimer = undefined;
    }
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private clearAllTimers(): void {
    this.clearPerConnectionTimers();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
