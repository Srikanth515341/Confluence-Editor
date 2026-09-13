/**
 * The M7 load harness (Phase 38, Test Plan §4.4 PERF-M7, §4.2 PERF-M4). Drives synthetic
 * editor and viewer clients against a REAL `createCollabServer()` over REAL WebSocket
 * connections — mirroring the `SimulatedClient` pattern established in Phase 18/21's
 * `audit.db.test.ts`/`gc.db.test.ts` (raw `Engine` instances, no `SyncClient`), but over
 * the real wire protocol rather than a captured in-process callback, so this harness also
 * exercises the real send-queue/broadcast/wire-encoding path M7's own egress/fanout
 * metrics require.
 *
 * Operation-store choice, disclosed per the phase brief's own requirement: this harness
 * always uses `InMemoryOperationStore` (`createCollabServer()`'s own default), never
 * `PostgresOperationStore`. This is deliberate, not an oversight — it isolates ENGINE and
 * FANOUT cost from database commit latency, which is exactly what the phase brief's own
 * "on multi-node fanout" section requires before any multi-node work could even be
 * considered: if the single-node curve breaks down, this isolation is what lets a later
 * investigation tell whether the cause is fanout/network-layer (DB-independent either way)
 * or engine-apply cost (Fugue's own O(N²) sequential-insertion characteristic, CLAUDE.md's
 * Open Item 3) — a real Postgres round trip would be a THIRD, confounding variable neither
 * of those two failure modes needs to reproduce.
 *
 * Baseline document construction: built via REAL `Engine.localInsert()` calls against the
 * coordinator's own live engine (the exact same production method any real client's own
 * keystroke invokes), never the fast DB `unnest(...)`-style bulk-insert technique this
 * project uses for FIXTURE-only setup in `*.db.test.ts` files. That technique exists
 * specifically to keep fixture SETUP speed from being confused with what a test is actually
 * measuring — but this phase's own explicit point is the opposite: building a 50,000-
 * character document via literal sequential insertion IS exactly the scenario the phase
 * brief warns intersects with Fugue's disclosed O(N^2) cost, so bypassing it here would
 * hide the very characteristic PERF-M7 exists to measure.
 */

import { once } from "node:events";
import WebSocket, { type RawData } from "ws";
import { Engine } from "@collab-editor/engine";
import { createCollabServer, WS_PATH, WS_SUBPROTOCOL, type CollabServer } from "@collab-editor/server";
import {
  Channel,
  decodeControlFrame,
  decodeFrame,
  decodeStructureSnapshotBody,
  encodeControlFrame,
  encodeFrame,
  opInsertToOperation,
  operationToOpInsert,
  peekChannel,
  seedEngineFromSnapshot,
  SnapshotForm,
  type ControlMessage,
} from "@collab-editor/protocol";
import { ClockOffsetTracker, type ClockOffsetEstimate } from "./clockOffset.js";

function toUint8Array(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return new Uint8Array(data);
}

/** Buffers frames arriving before a waiter is registered, then switches to a live push
 * handler once the caller no longer needs pull-based reads (the same "IncomingFrames"
 * shape `gateway.test.ts` has used since Phase 9 for exactly this handshake-timing race). */
function createFrameReader(ws: WebSocket): {
  next(): Promise<Uint8Array>;
  setLiveHandler(handler: (frame: Uint8Array) => void): void;
} {
  const queue: Uint8Array[] = [];
  let waiter: ((frame: Uint8Array) => void) | null = null;
  let liveHandler: ((frame: Uint8Array) => void) | null = null;
  ws.on("message", (data: RawData) => {
    const bytes = toUint8Array(data);
    if (liveHandler) {
      liveHandler(bytes);
      return;
    }
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(bytes);
      return;
    }
    queue.push(bytes);
  });
  return {
    next(): Promise<Uint8Array> {
      const buffered = queue.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    setLiveHandler(handler: (frame: Uint8Array) => void): void {
      let buffered = queue.shift();
      while (buffered !== undefined) {
        handler(buffered);
        buffered = queue.shift();
      }
      liveHandler = handler;
    },
  };
}

export type ClientRole = "editor" | "viewer";

/** Shared, in-process correlation state for M4's own mint-to-visible latency measurement —
 * legitimate ONLY because this harness runs every synthetic client in the SAME Node
 * process; a real cross-machine load generator would need to carry this over the wire
 * instead. Keyed by `"${id.r}:${id.c}"`. */
export interface CorrelationState {
  readonly mintServerClockMs: Map<string, number>;
  readonly latenciesMs: number[];
}

export function createCorrelationState(): CorrelationState {
  return { mintServerClockMs: new Map(), latenciesMs: [] };
}

export interface ClientMetrics {
  opsSent: number;
  opsReceived: number;
  bytesReceived: number;
  connectStartedAtMs: number;
  syncedAtMs: number | null;
}

export interface SyntheticClient {
  readonly ws: WebSocket;
  readonly engine: Engine;
  readonly role: ClientRole;
  readonly replicaId: number;
  readonly offsetTracker: ClockOffsetTracker;
  readonly metrics: ClientMetrics;
  stop(): void;
}

function idKey(id: { readonly r: number; readonly c: number }): string {
  return `${id.r}:${id.c}`;
}

async function connectAndHandshake(
  serverUrl: string,
  documentId: string,
  role: ClientRole,
): Promise<{ client: SyntheticClient; reader: ReturnType<typeof createFrameReader> }> {
  const metrics: ClientMetrics = {
    opsSent: 0,
    opsReceived: 0,
    bytesReceived: 0,
    connectStartedAtMs: Date.now(),
    syncedAtMs: null,
  };
  const ws = new WebSocket(`${serverUrl}${WS_PATH}`, WS_SUBPROTOCOL);
  await once(ws, "open");
  const reader = createFrameReader(ws);

  ws.send(
    encodeControlFrame({
      kind: "hello",
      documentId,
      ticket: new Uint8Array(0), // no `auth` deps configured on this harness's server (see module doc comment)
      lastServerSeq: 0,
      unacked: [],
      clientCapabilities: 0, // every synthetic client is a brand-new join — always resolves to SNAPSHOT
    }),
    { binary: true },
  );

  let replicaId = -1;
  let engine: Engine | null = null;
  let handshakeDone = false;
  while (!handshakeDone) {
    const frame = await reader.next();
    if (peekChannel(frame) === Channel.PRESENCE) continue; // PRESENCE_ROSTER — not needed here
    const msg: ControlMessage = decodeControlFrame(frame, { direction: "serverOrigin" });
    switch (msg.kind) {
      case "welcome":
        replicaId = msg.replicaId;
        break;
      case "snapshot": {
        if (msg.form !== SnapshotForm.STRUCTURE) {
          throw new Error("load harness only handles structure-form SNAPSHOT");
        }
        const nodes = decodeStructureSnapshotBody(msg.body);
        engine = seedEngineFromSnapshot(replicaId, nodes);
        break;
      }
      case "alreadyHave":
        // Every synthetic client is a fresh join with an empty unacked queue, so
        // ALREADY_HAVE always carries nothing meaningful — its arrival just marks the
        // handshake's own completion point (it is always sent last on CONTROL, Phase 23).
        if (engine === null) engine = new Engine(replicaId); // an empty document's own SNAPSHOT decodes to zero nodes
        handshakeDone = true;
        break;
      default:
        break; // catchupBegin/Chunk/End, permissionChanged: not reachable for a fresh join
    }
  }
  metrics.syncedAtMs = Date.now();

  const offsetTracker = new ClockOffsetTracker();
  const client: SyntheticClient = {
    ws,
    engine: engine!,
    role,
    replicaId,
    offsetTracker,
    metrics,
    stop(): void {
      ws.removeAllListeners();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
    },
  };
  return { client, reader };
}

/** Wires up ongoing frame handling (PONG for clock-offset sampling, OPS broadcasts for M4
 * latency correlation) — called once handshake completes and the caller is ready for the
 * client to run for the rest of the level's duration. */
function attachLiveHandling(
  client: SyntheticClient,
  reader: ReturnType<typeof createFrameReader>,
  correlation: CorrelationState,
): void {
  reader.setLiveHandler((frame) => {
    client.metrics.bytesReceived += frame.byteLength;
    const localReceivedAtMs = Date.now();
    const channel = peekChannel(frame);
    if (channel === Channel.CONTROL) {
      const msg = decodeControlFrame(frame, { direction: "serverOrigin" });
      if (msg.kind === "pong") {
        client.offsetTracker.recordRoundTrip({
          t0: msg.clientTimeMs,
          t1: msg.serverTimeMs,
          t2: msg.serverTimeMs,
          t3: localReceivedAtMs,
        });
      }
      return;
    }
    if (channel === Channel.OPS) {
      const ops = decodeFrame(frame, { direction: "serverOrigin" });
      if (ops.kind !== "opInsert") return; // this harness's editors only ever mint inserts
      client.engine.applyRemote(opInsertToOperation(ops));
      client.metrics.opsReceived += 1;
      const mintAt = correlation.mintServerClockMs.get(idKey(ops.id));
      if (mintAt !== undefined) {
        const estimate = client.offsetTracker.estimate;
        const localServerClockMs = localReceivedAtMs + (estimate?.offsetMs ?? 0);
        correlation.latenciesMs.push(localServerClockMs - mintAt);
      }
    }
  });
}

/** Starts a 3-second PING cadence (§3.6.11), the real client behavior every `SyncClient`
 * follows — needed here purely to keep this harness's own `ClockOffsetTracker` samples
 * flowing throughout a level's run, per Test Plan §4.2's "every 30s thereafter" re-
 * evaluation (this harness re-evaluates continuously rather than only every 30s, which is
 * strictly more data, not a deviation from the required methodology). */
function startPingLoop(client: SyntheticClient): () => void {
  function sendPing(): void {
    if (client.ws.readyState !== client.ws.OPEN) return;
    client.ws.send(
      encodeControlFrame({
        kind: "ping",
        clientTimeMs: Date.now(),
        lastAppliedSeq: 0, // this harness never reads acks; a fixed value is harmless (only used server-side for its own watermark bookkeeping, irrelevant to load metrics)
      }),
      { binary: true },
    );
  }
  // Send one immediately (so even a short reduced-pass run gets at least one real NTP
  // sample right away) in addition to the ordinary 3-second cadence thereafter.
  sendPing();
  const timer = setInterval(sendPing, 3000);
  return () => clearInterval(timer);
}

/** Starts an editor's own ~5 chars/sec typing loop, appending at the document's own current
 * end — Test Plan §4.4's own load profile ("synthetic clients typing... into a 50,000-
 * character document"), not scattered edits (that shape is SEC-08's own attack workload,
 * Phase 30 — a deliberately distinct scenario). */
function startTypingLoop(
  client: SyntheticClient,
  charsPerSecond: number,
  correlation: CorrelationState,
): () => void {
  const intervalMs = 1000 / charsPerSecond;
  const LOWERCASE_A = 0x61;
  let i = 0;
  const timer = setInterval(() => {
    if (client.ws.readyState !== client.ws.OPEN) return;
    const value = LOWERCASE_A + (i % 26);
    i += 1;
    const visibleIndex = client.engine.stats().visibleLength;
    const op = client.engine.localInsert(visibleIndex, value);
    client.metrics.opsSent += 1;
    const estimate = client.offsetTracker.estimate;
    const mintLocalMs = Date.now();
    correlation.mintServerClockMs.set(idKey(op.id), mintLocalMs + (estimate?.offsetMs ?? 0));
    client.ws.send(encodeFrame(operationToOpInsert(op, 0)), { binary: true });
  }, intervalMs);
  return () => clearInterval(timer);
}

export interface LoadLevelConfig {
  readonly editorCount: number;
  readonly viewerCount: number;
  readonly durationMs: number;
  readonly charsPerSecondPerEditor: number;
}

export interface LoadLevelResult {
  readonly editorCount: number;
  readonly viewerCount: number;
  readonly durationMs: number;
  /** M4 p50/p95/p99, mint-to-visible, NTP-corrected across the in-process correlation map. */
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly latencyP99Ms: number;
  readonly latencySampleCount: number;
  /** Whole-harness-PROCESS CPU delta over the run (server + all synthetic clients combined —
   * see this module's own doc comment for why isolating just the server's share was not
   * attempted). */
  readonly processCpuUserMs: number;
  readonly processCpuSystemMs: number;
  readonly heapUsedDeltaBytes: number;
  /** The established project-wide memory proxy (Phase 20/21): node count, not raw bytes. */
  readonly documentTotalElements: number;
  readonly documentTombstones: number;
  readonly opsBroadcastPerSecond: number;
  readonly egressBytesPerSecond: number;
  /** Time from each client's own connect() call to handshake completion — the real cost of
   * replaying a (possibly 50,000-character) structure-form SNAPSHOT via
   * `seedEngineFromSnapshot`, per synthetic client. Reported because at high concurrency
   * against a large baseline document this can itself become the dominant cost — exactly
   * the Fugue-intersection risk the phase brief names. */
  readonly timeToSyncedP50Ms: number;
  readonly timeToSyncedMaxMs: number;
  /** Disclosed as unmeasurable for synthetic, non-browser Node clients — see the phase's own
   * end-of-run report for the full disclosure; always this fixed note, never a real number. */
  readonly clientMainThreadUtilizationNote: string;
  readonly bindingReconciliationNote: string;
  readonly clockOffsetEstimate: ClockOffsetEstimate | null;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)]!;
}

export interface LoadHarnessHandle {
  readonly server: CollabServer;
  readonly serverUrl: string;
  readonly documentId: string;
  /** Builds the baseline document via real, sequential `Engine.localInsert()` calls against
   * the coordinator's own live engine — see this module's own doc comment for why this is
   * deliberately NOT the fast DB bulk-insert technique. Returns the real elapsed time, since
   * this itself is a genuine measurement (Fugue's own O(N^2) cost applies here too). Requires
   * at least one client to have already joined (the coordinator is created lazily on first
   * HELLO) — call `ensureCoordinator()` first if no real client has connected yet.
   */
  buildBaselineDocument(charCount: number): { elapsedMs: number };
  /** Joins one throwaway client, just to force the coordinator into existence, then
   * disconnects it — needed before `buildBaselineDocument` on a brand-new document. */
  ensureCoordinator(): Promise<void>;
  runLevel(config: LoadLevelConfig): Promise<LoadLevelResult>;
  close(): Promise<void>;
}

/** Starts a real, in-process `createCollabServer()` (InMemoryOperationStore, no auth/rate-
 * limit deps — see this module's own doc comment) on an ephemeral port, ready for the load
 * harness's own synthetic clients to join `documentId`. */
export async function startLoadHarness(documentId: string): Promise<LoadHarnessHandle> {
  const server = createCollabServer();
  const port = await server.listen(0);
  const serverUrl = `ws://127.0.0.1:${port}`;

  return {
    server,
    serverUrl,
    documentId,

    async ensureCoordinator(): Promise<void> {
      const { client } = await connectAndHandshake(serverUrl, documentId, "viewer");
      client.stop();
    },

    buildBaselineDocument(charCount: number): { elapsedMs: number } {
      const coordinator = server.gateway.coordinators.get(documentId);
      if (!coordinator) {
        throw new Error(
          "buildBaselineDocument requires a coordinator to already exist — call " +
            "ensureCoordinator() first",
        );
      }
      const LOWERCASE_A = 0x61;
      const startedAtMs = Date.now();
      for (let i = 0; i < charCount; i++) {
        coordinator.engine.localInsert(i, LOWERCASE_A + (i % 26));
      }
      return { elapsedMs: Date.now() - startedAtMs };
    },

    async runLevel(config: LoadLevelConfig): Promise<LoadLevelResult> {
      const correlation = createCorrelationState();
      const clients: SyntheticClient[] = [];
      const stopFns: Array<() => void> = [];

      async function spawn(role: ClientRole): Promise<void> {
        const { client, reader } = await connectAndHandshake(serverUrl, documentId, role);
        clients.push(client);
        attachLiveHandling(client, reader, correlation);
        stopFns.push(startPingLoop(client));
        if (role === "editor") {
          stopFns.push(startTypingLoop(client, config.charsPerSecondPerEditor, correlation));
        }
      }

      for (let i = 0; i < config.editorCount; i++) await spawn("editor");
      for (let i = 0; i < config.viewerCount; i++) await spawn("viewer");

      const cpuBefore = process.cpuUsage();
      const heapBefore = process.memoryUsage().heapUsed;
      const runStartedAtMs = Date.now();

      await new Promise((resolve) => setTimeout(resolve, config.durationMs));

      const cpuAfter = process.cpuUsage(cpuBefore);
      const heapAfter = process.memoryUsage().heapUsed;
      const elapsedMs = Date.now() - runStartedAtMs;

      for (const stop of stopFns) stop();
      for (const client of clients) client.stop();

      const sortedLatencies = [...correlation.latenciesMs].sort((a, b) => a - b);
      const timesToSynced = clients
        .map((c) => (c.metrics.syncedAtMs ?? 0) - c.metrics.connectStartedAtMs)
        .sort((a, b) => a - b);

      const coordinator = server.gateway.coordinators.get(documentId)!;
      const stats = coordinator.engine.stats();

      const totalOpsReceived = clients.reduce((sum, c) => sum + c.metrics.opsReceived, 0);
      const totalBytesReceived = clients.reduce((sum, c) => sum + c.metrics.bytesReceived, 0);

      let combinedEstimate: ClockOffsetEstimate | null = null;
      const allEstimates = clients.flatMap((c) =>
        c.offsetTracker.estimate ? [c.offsetTracker.estimate] : [],
      );
      if (allEstimates.length > 0) {
        // Report the WORST (largest) residual uncertainty across all clients — a single
        // combined offset value would be meaningless (each client has its own clock, even
        // though in this same-process harness every "clock" is really the same OS clock).
        combinedEstimate = allEstimates.reduce((worst, e) =>
          e.residualUncertaintyMs > worst.residualUncertaintyMs ? e : worst,
        );
      }

      return {
        editorCount: config.editorCount,
        viewerCount: config.viewerCount,
        durationMs: elapsedMs,
        latencyP50Ms: percentile(sortedLatencies, 50),
        latencyP95Ms: percentile(sortedLatencies, 95),
        latencyP99Ms: percentile(sortedLatencies, 99),
        latencySampleCount: sortedLatencies.length,
        processCpuUserMs: cpuAfter.user / 1000,
        processCpuSystemMs: cpuAfter.system / 1000,
        heapUsedDeltaBytes: heapAfter - heapBefore,
        documentTotalElements: stats.totalElements,
        documentTombstones: stats.tombstones,
        opsBroadcastPerSecond: totalOpsReceived / (elapsedMs / 1000),
        egressBytesPerSecond: totalBytesReceived / (elapsedMs / 1000),
        timeToSyncedP50Ms: percentile(timesToSynced, 50),
        timeToSyncedMaxMs: timesToSynced[timesToSynced.length - 1] ?? NaN,
        clientMainThreadUtilizationNote:
          "unmeasurable for synthetic Node clients — no real DOM/render loop exists to measure against; a real browser-based load generator would be needed for this metric",
        bindingReconciliationNote:
          "structurally 0 — synthetic clients have no MutationSentinel/DOM at all, so binding.reconciliation cannot fire",
        clockOffsetEstimate: combinedEstimate,
      };
    },

    async close(): Promise<void> {
      await server.close();
    },
  };
}
