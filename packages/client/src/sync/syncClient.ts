import {
  Engine,
  type DeleteOperation,
  type InsertOperation,
  type Operation,
} from "@collab-editor/engine";
import {
  Channel,
  CLIENT_CAP_ACCEPTS_OP_INSERT_RUN,
  CLIENT_CAP_ACCEPTS_STRUCTURE_SNAPSHOT,
  SnapshotForm,
  decodeControlFrame,
  decodeFrame,
  decodeStructureSnapshotBody,
  encodeControlFrame,
  encodeFrame,
  peekChannel,
  seedEngineFromSnapshot,
  type ControlMessage,
  type OpsMessage,
} from "@collab-editor/protocol";
import { Backoff, BACKOFF_RESET_AFTER_MS } from "./backoff.js";
import { ObservableValue, type ConnectionState, type Observable } from "./connectionState.js";
import { openDurableQueue, type DurableQueue } from "./durableQueue.js";
import { SequenceGapTracker } from "./gapTracker.js";
import { reconcileOfflineQueue } from "./reconcileOfflineQueue.js";
import { UnackedQueue } from "./unackedQueue.js";
import { operationsToRunMessages, operationToOpsMessage, toOperations } from "./wireHelpers.js";

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

  constructor(opts: SyncClientOptions) {
    this.serverUrl = opts.url;
    this.documentId = opts.documentId;
    this.createSocket = opts.createSocket ?? defaultCreateSocket;
    this.onReconnectScheduled = opts.onReconnectScheduled;
    this.openDurableQueueFn = opts.openDurableQueue ?? openDurableQueue;
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
    this.stateValue.set("synced");
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
    this.stateValue.set(this.everSynced ? "reconnecting" : "connecting");
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
    this.stateValue.set("offline");
    this.ws?.close();
    this.ws = null;
  }

  /** Mints and sends a local insert, exactly mirroring `Engine.localInsert`'s signature. Throws if not currently synced — there is no offline queue-and-replay in this phase (Phase 22's IndexedDB queue is what that becomes). */
  localInsert(visibleIndex: number, value: number, bind?: boolean): InsertOperation {
    const engine = this.requireEngine();
    const op =
      bind === undefined
        ? engine.localInsert(visibleIndex, value)
        : engine.localInsert(visibleIndex, value, bind);
    this.sendOperation(op);
    return op;
  }

  /** Mints and sends local deletes, mirroring `Engine.localDelete`. */
  localDelete(visibleIndex: number, count: number): readonly DeleteOperation[] {
    const engine = this.requireEngine();
    const ops = engine.localDelete(visibleIndex, count);
    for (const op of ops) {
      this.sendOperation(op);
    }
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
   */
  localInsertText(visibleIndex: number, text: string): readonly InsertOperation[] {
    const engine = this.requireEngine();
    const ops: InsertOperation[] = [];
    let at = visibleIndex;
    for (const ch of text) {
      // `for...of` iterates a string by code point, not UTF-16 code unit — required for
      // correct surrogate-pair handling (see unicodeOffsets.ts's own doc comment).
      const codePoint = ch.codePointAt(0)!;
      ops.push(engine.localInsert(at, codePoint));
      at += 1;
    }
    // API Spec §7.9: "written in applyLocal before or concurrently with transmission, never
    // after" — the durable-queue add (via unacked.add, which schedules the IndexedDB write)
    // must happen BEFORE sendFrame below, not after. A crash between these two loops (in the
    // old order) would have transmitted content the durable store never actually recorded —
    // exactly the inconsistency this ordering rule exists to prevent.
    for (const op of ops) {
      this.unacked.add(op);
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
    ws.onopen = () => this.onOpen();
    ws.onmessage = (ev: { data: unknown }) => this.onMessage(ev);
    ws.onclose = (ev: { code: number; reason: string }) => this.onClose(ev);
    ws.onerror = () => {}; // 'close' always follows for WebSocket; nothing separate to do
  }

  private onOpen(): void {
    this.armSurvivedTimer();
    this.sendControl({
      kind: "hello",
      documentId: this.documentId,
      ticket: new Uint8Array(), // no auth yet (Phase 29) — "accept any bytes" server-side
      lastServerSeq: this.gapTracker.value,
      unacked: this.unacked.ids(),
      clientCapabilities: CLIENT_CAP_ACCEPTS_OP_INSERT_RUN | CLIENT_CAP_ACCEPTS_STRUCTURE_SNAPSHOT,
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
        break;
      case "snapshot":
        this.handleSnapshot(msg.seq, msg.form, msg.body);
        break;
      case "pong":
        // Phase 22 fix (found by this phase's own DUR-07 e2e test, unrelated to the durable
        // queue itself): a PONG proves the connection is alive even when nothing has been
        // edited — see gapTracker.ts's `markAlive()` doc comment for the full account of the
        // false-positive "stalled" reconnect this closes.
        this.gapTracker.markAlive();
        break;
      case "goodbye":
      case "error":
        break; // no special GOODBYE/ERROR handling this phase — 'close' drives reconnection either way
      default:
        break; // hello/syncComplete/ping/leave are client-origin only; decodeControlFrame already enforces this
    }
  }

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
    // Phase 22: a fresh SNAPSHOT means a BRAND-NEW replica id (this project's server never
    // resumes a session — see reconcileOfflineQueue.ts's own header comment) — so whatever this
    // client had queued as unacked (from a prior connection this page session, OR restored from
    // IndexedDB after a crash) can never be resent AS-IS; its stamps belong to a replica id the
    // server will now reject as an identity mismatch. Instead: capture the queued operations,
    // un-queue them (both memory and durable — they're about to be superseded, not acked),
    // reconcile each one's INTENT against the freshly-seeded engine (producing brand-new
    // operations under the new replica id), and send those. This is what makes offline editing
    // during a "reconnecting" window (Scope-IN) actually reach the document, not just sit
    // durably inert forever.
    const queued = this.unacked.values();
    for (const op of queued) {
      this.unacked.ack(op.id);
    }
    this.syncUnsyncedCountObservable(); // covers the (rare) case resent.length === 0 below, where no later sendOperation call would otherwise refresh this
    const resent = reconcileOfflineQueue(this.engine, queued);
    for (const op of resent) {
      this.sendOperation(op);
    }

    this.gapTracker.reset(seq);
    this.highestAppliedSeq = seq;
    this.persistMeta();

    this.sendControl({ kind: "syncComplete", lastServerSeq: seq, resentCount: resent.length });

    this.everSynced = true;
    this.stateValue.set("synced");
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
   * message has a `.seq`. No live server sends either yet (Phase 16), so
   * this path is exercised by unit tests with synthetic frames this phase.
   */
  private handleOpsMessage(msg: OpsMessage): void {
    switch (msg.kind) {
      case "opAck":
        for (const ack of msg.acks) {
          this.unacked.ack(ack.ackedId);
        }
        this.syncUnsyncedCountObservable();
        break;
      case "opReject":
        // No retry/error-surface logic this phase — a rejected operation is simply given up on
        // (unchanged since Phase 10). Phase 22 adds durable PRESERVATION (API Spec §7.9's
        // `rejected` store, "preservation of rejected operations") — the op is no longer
        // silently discarded, just no longer actively retried.
        for (const rejected of msg.rejects) {
          const op = this.unacked.get(rejected.rejectedId);
          this.unacked.ack(rejected.rejectedId);
          if (op && this.durableQueue) {
            this.durableQueue.scheduleWriteRejected({
              documentId: this.documentId,
              op,
              reason: rejected.reason,
              detail: msg.detail,
              rejectedAt: Date.now(),
            });
          }
        }
        this.syncUnsyncedCountObservable();
        break;
      default:
        this.handleOps(msg.seq, toOperations(msg));
        break;
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
      this.stateValue.set("offline");
      return;
    }
    this.stateValue.set("reconnecting");
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
