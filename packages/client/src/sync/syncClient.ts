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
import { SequenceGapTracker } from "./gapTracker.js";
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

  private ws: WebSocketLike | null = null;
  private everSynced = false;
  private explicitlyOffline = true; // true until the first connect() call

  private readonly stateValue = new ObservableValue<ConnectionState>("offline");
  get state(): Observable<ConnectionState> {
    return this.stateValue;
  }

  private readonly backoff = new Backoff();
  private survivedTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  private readonly gapTracker = new SequenceGapTracker();

  private readonly unacked = new UnackedQueue();
  /** The seq PING reports — the highest seq this client has ever applied, NOT the gap tracker's contiguous value (§3.7.5's "apply anyway" means these can legitimately differ while a gap is open). */
  private highestAppliedSeq = 0;

  constructor(opts: SyncClientOptions) {
    this.serverUrl = opts.url;
    this.documentId = opts.documentId;
    this.createSocket = opts.createSocket ?? defaultCreateSocket;
    this.onReconnectScheduled = opts.onReconnectScheduled;
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

  /** Opens (or re-opens) the connection. Safe to call once; automatic reconnection after a drop does not need it called again. */
  connect(): void {
    this.explicitlyOffline = false;
    this.stateValue.set(this.everSynced ? "reconnecting" : "connecting");
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
    for (const msg of operationsToRunMessages(ops)) {
      this.sendFrame(encodeFrame(msg));
    }
    for (const op of ops) {
      this.unacked.add(op);
    }
    return ops;
  }

  /** Number of locally-sent operations not yet acknowledged (API Spec §7.9) — exposed for tests/observability. */
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
   * Requires BOTH a non-null engine AND `state.value === "synced"` — Phase
   * 14 correction: `engine` is deliberately preserved (never nulled) across
   * a disconnect (see `onClose`'s own comment), so checking for null alone
   * does not catch the "reconnecting" window between an old connection
   * dropping and a fresh SNAPSHOT replacing `engine` wholesale. A local
   * edit minted against the OLD (soon-to-be-discarded) engine reference
   * during that window would apply locally, attempt to send over a socket
   * that's already gone, and then be silently ORPHANED the instant the new
   * snapshot replaces `engine` — a real, confirmed data-loss path, found
   * only by running a real multi-client session long enough to reconnect
   * mid-edit (Test Plan §2.7's own E2E-CONV-01/-02). Throwing here instead
   * of silently operating on a doomed reference is the same "throws if not
   * currently synced" contract `localInsert`'s own doc comment already
   * promised — this closes the gap between that promise and what the code
   * actually checked. `EditorView`'s input pipeline (inputPipeline.ts)
   * checks `state.value === "synced"` BEFORE ever reaching this call, so a
   * real user typing during a reconnect never actually hits this throw —
   * it's a backstop for direct/programmatic callers.
   */
  private requireEngine(): Engine {
    if (!this.engine || this.stateValue.value !== "synced") {
      throw new Error("SyncClient: not synced yet — call after state becomes 'synced'");
    }
    return this.engine;
  }

  private sendOperation(op: Operation): void {
    this.unacked.add(op);
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
      case "goodbye":
      case "error":
        break; // no RTT tracking, no special GOODBYE/ERROR handling this phase — 'close' drives reconnection either way
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
    this.unacked.clear(); // whatever this client sent under a PRIOR connection is already reflected in this fresh snapshot (or lost with that connection) — nothing to resend against a brand-new replica identity
    this.gapTracker.reset(seq);
    this.highestAppliedSeq = seq;

    this.sendControl({ kind: "syncComplete", lastServerSeq: seq, resentCount: 0 });

    this.everSynced = true;
    this.stateValue.set("synced");
    this.startPingTimer();
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
        break;
      case "opReject":
        // No retry/error-surface logic this phase — a rejected operation is simply given up on.
        for (const rejected of msg.rejects) {
          this.unacked.ack(rejected.rejectedId);
        }
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
