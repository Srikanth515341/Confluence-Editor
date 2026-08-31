// A lightweight in-process WebSocket delay relay, substituted for toxiproxy
// for Phase 14's E2E-CONV suite (Test Plan §2.7). Per this phase's own
// infrastructure guidance: a full toxiproxy instance (a separate binary/
// Docker container) is disproportionate for this phase's actual goal —
// injecting ~150ms of round-trip latency so E2E-CONV-01's 60-second
// concurrent-typing scenario exercises genuine network delay, not just
// loopback-speed delivery. This relay buffers each frame and forwards it
// after `delayMs`, in BOTH directions, in the EXACT order it arrived.
//
// THIS IS NOT RFC §8.8-GRADE FAULT INJECTION. It only delays; it never
// duplicates, reorders, or drops frames — that is Test Plan §3.5/DUR-05's
// job, in a much later phase. Documented here and in CLAUDE.md's Phase 14
// entry so this substitution is never mistaken for the real thing.
//
// FOUR real bugs were found and fixed here ONLY by actually running
// E2E-CONV-01 under real load (three browsers × ~5 chars/s), not by
// review — see CLAUDE.md's Phase 14 entry for the full account of all
// three:
//
// 1. The first version scheduled each frame's forwarding with its OWN
//    independent `setTimeout(..., delayMs)` and held a direct reference to
//    `ws`'s own message buffer across that delay. Under real load this
//    corrupted forwarded bytes often enough to trip the SERVER's own
//    engine-level canary (Engine Spec §6.2 sub-case iii-d, Phase 6) —
//    proof some delivered operation was structurally impossible for any
//    correct client to have produced. Fixed by copying into a fresh
//    `Buffer` (`copyRawData`) the INSTANT a frame is received, never
//    holding a reference to whatever `ws` gave us across the delay.
// 2. Even after that fix, independent per-message timers do not
//    STRUCTURALLY guarantee delivery in arrival order — under real load,
//    two timers armed microseconds apart CAN fire out of relative order.
//    Fixed by replacing "one timer per message" with one explicit,
//    strictly-ordered FIFO queue per direction per connection, drained by
//    a single timer that is only ever armed for the queue's OWN head.
// 3. Even after both of the above, the FIRST version of the queue's drain
//    logic checked `upstream.readyState === WebSocket.OPEN` and, if not
//    open yet, SILENTLY DISCARDED that frame and moved on to the next —
//    a genuine data-loss bug: the upstream `WebSocket` (a brand-new
//    connection to the real server, started the instant a browser's own
//    connection to this relay is accepted) has its own handshake latency,
//    and a downstream frame arriving before that handshake completes could
//    have its delay timer fire before `upstream` reaches OPEN. Every
//    dropped frame is a permanently un-satisfiable causal dependency for
//    whatever the client mints next — reproduced as engine-level
//    divergence AND a non-zero `pendingCount()` that never drains, exactly
//    Invariant I9's failure shape. Fixed: the queue NEVER discards an item
//    for not being ready — it holds the head in place and retries shortly
//    until the socket is actually open (or the connection is torn down).
// 4. Even after all three of the above, a REAL client-initiated reconnect
//    mid-run (SyncClient's own backoff/reconnect logic — observed in this
//    project's own tests to happen periodically regardless of this relay)
//    still lost data: the relay's `close` handlers tore a connection's
//    queues down immediately, silently abandoning whatever operations
//    were still sitting inside their `delayMs` window at that exact
//    moment — the real server never received them. Fixed: `flush()` sends
//    everything still queued immediately (best-effort) BEFORE `stop()` is
//    ever called, on every close/error path.

import { WebSocket, WebSocketServer, type RawData } from "ws";

export interface DelayRelay {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/** See this file's own header, bug 1: copies `data` into a fresh `Buffer` before it is ever held across the delay queue below. */
function copyRawData(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk)));
  }
  return Buffer.from(new Uint8Array(data));
}

/** How long to wait before re-checking readiness for a queue head that isn't sendable yet (this file's header, bug 3) — short enough not to add perceptible extra latency, long enough not to busy-loop. */
const NOT_READY_RETRY_MS = 5;

/**
 * A strict FIFO delay queue for one direction of one connection (this
 * file's header, bug 2). `forward` enqueues a frame with its due time and
 * arms a timer ONLY for the current queue head — never one timer per
 * message — so frames are always sent in the exact order they arrived,
 * regardless of real-world timer-firing jitter. `isReady()` gates the
 * actual send: if the destination socket isn't open yet when a frame's
 * delay elapses, the frame is NEVER discarded (this file's header, bug 3)
 * — it stays at the head and is retried every {@link NOT_READY_RETRY_MS}
 * until `isReady()` returns true or the caller stops calling `forward`
 * (e.g. the connection tears down, at which point nothing calls `drain`
 * again and the queue is simply abandoned along with the closed sockets).
 */
interface DelayQueue {
  readonly forward: (data: Buffer, isBinary: boolean) => void;
  /**
   * Sends every item STILL WAITING in the queue immediately, ignoring
   * their scheduled `dueAt` (best-effort — skips, without discarding
   * further, only if the destination isn't ready right now). Call this
   * BEFORE `stop()` on a connection teardown — this was a real, confirmed
   * bug (this file's header, bug 4): a client can legitimately close and
   * reconnect (SyncClient's own real backoff/reconnect logic, unrelated to
   * this relay) WHILE this queue is still holding that client's most
   * recent operations inside their `delayMs` window. Tearing down without
   * flushing first abandoned those operations forever — the real server
   * never received them, and every later insert that depended on them
   * (as an `originLeft`/`originRight`) stayed permanently in `pending`
   * (Invariant I9's exact failure shape) or, worse, corrupted a LATER
   * node's placement enough to eventually trip the engine's own Case C
   * canary (Engine Spec §6.2 sub-case iii-d) on a completely unrelated
   * insert much later in the run.
   */
  readonly flush: () => void;
  /** Stops retrying and clears any pending timer — called when the connection tears down, so a permanently-unready destination (e.g. the upstream handshake never completed at all) doesn't leave a retry timer firing every {@link NOT_READY_RETRY_MS} forever. */
  readonly stop: () => void;
}

function makeDelayQueue(
  isReady: () => boolean,
  send: (data: Buffer, isBinary: boolean) => void,
  delayMs: number,
): DelayQueue {
  const queue: Array<{
    readonly data: Buffer;
    readonly isBinary: boolean;
    readonly dueAt: number;
  }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function armForHead(delayOverrideMs?: number): void {
    if (stopped || timer !== undefined || queue.length === 0) {
      return;
    }
    const delay = delayOverrideMs ?? Math.max(0, queue[0]!.dueAt - Date.now());
    timer = setTimeout(drain, delay);
  }

  function drain(): void {
    timer = undefined;
    if (stopped) {
      return;
    }
    const now = Date.now();
    while (queue.length > 0 && queue[0]!.dueAt <= now) {
      if (!isReady()) {
        // Do NOT shift/discard — leave this item at the head and retry shortly. Never silently
        // drop a frame just because the destination wasn't open yet (bug 3, this file's header).
        armForHead(NOT_READY_RETRY_MS);
        return;
      }
      const item = queue.shift()!;
      send(item.data, item.isBinary);
    }
    armForHead();
  }

  return {
    forward: (data, isBinary) => {
      if (stopped) {
        return;
      }
      queue.push({ data, isBinary, dueAt: Date.now() + delayMs });
      armForHead();
    },
    flush: () => {
      // Ignores `dueAt` entirely — sends everything waiting, right now, in order. Only skips (and
      // stops, leaving the rest queued) if the destination genuinely isn't ready; there is no
      // further "later" for a flush to retry into, since `stop()` always follows immediately.
      while (queue.length > 0 && isReady()) {
        const item = queue.shift()!;
        send(item.data, item.isBinary);
      }
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/**
 * Starts a relay listening on `port` (0 = ephemeral) that forwards every
 * WebSocket connection to `targetWsUrl`, delaying every frame in both
 * directions by `delayMs`, strictly preserving arrival order. Negotiates
 * whatever subprotocol the connecting client offered (SyncClient always
 * offers exactly `obseq.v1`, API Spec §3) and re-offers the SAME one to
 * the upstream server, since the real gateway
 * (packages/server/src/gateway.ts) rejects any other.
 */
export function startDelayRelay(
  targetWsUrl: string,
  delayMs: number,
  port = 0,
): Promise<DelayRelay> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      port,
      handleProtocols: (protocols) => protocols.values().next().value ?? false,
      perMessageDeflate: false,
    });

    wss.on("error", reject);

    wss.on("listening", () => {
      const address = wss.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: boundPort,
        url: `ws://127.0.0.1:${boundPort}`,
        close: () =>
          new Promise((res) => {
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close(() => res());
          }),
      });
    });

    wss.on("connection", (downstream, req) => {
      const protocol = req.headers["sec-websocket-protocol"];
      const upstream = new WebSocket(targetWsUrl, protocol, { perMessageDeflate: false });

      const toUpstream = makeDelayQueue(
        () => upstream.readyState === WebSocket.OPEN,
        (data, isBinary) => upstream.send(data, { binary: isBinary }),
        delayMs,
      );
      const toDownstream = makeDelayQueue(
        () => downstream.readyState === WebSocket.OPEN,
        (data, isBinary) => downstream.send(data, { binary: isBinary }),
        delayMs,
      );

      downstream.on("message", (data, isBinary) => toUpstream.forward(copyRawData(data), isBinary));
      upstream.on("message", (data, isBinary) => toDownstream.forward(copyRawData(data), isBinary));

      function teardown(): void {
        toUpstream.stop();
        toDownstream.stop();
      }
      // FLUSH before closing the peer / stopping — see `flush()`'s own doc comment (bug 4): a
      // real client-initiated reconnect must not silently abandon whatever this connection's
      // queues were still holding at that exact moment.
      downstream.on("close", () => {
        toUpstream.flush();
        upstream.close();
        teardown();
      });
      upstream.on("close", (code, reason) => {
        toDownstream.flush();
        // An abrupt upstream kill (E2E-CONV-03: the real server process closing without a clean
        // WS close frame) can report a code `ws.close()` itself refuses as invalid (must be 1000
        // or 3000-4999) — terminate() instead of close() in that case, matching how downstream's
        // own "error" path already handles an unclean peer.
        if (code === 1000 || (code >= 3000 && code <= 4999)) {
          downstream.close(code, reason);
        } else {
          downstream.close();
        }
        teardown();
      });
      downstream.on("error", () => {
        toUpstream.flush();
        upstream.terminate();
        teardown();
      });
      upstream.on("error", () => {
        toDownstream.flush();
        downstream.terminate();
        teardown();
      });
    });
  });
}
