// Phase 25 — Milestone M2, Test Plan DUR-05/DUR-06's adverse-network proxy. Per this phase's
// own reference-text guidance ("if a full toxiproxy instance/Docker setup is disproportionate
// ... reuse or extend Phase 14's existing in-process delay-relay pattern ... rather than
// introducing a new external dependency"): this is exactly that extension, applied to this
// project's own stated "network-fault proxy" role for `packages/testkit` (see this package's
// own header comment in CLAUDE.md's architecture table, a role never actually built until now).
//
// `packages/client/e2e/support/delayRelay.ts` (Phase 14) deliberately does ONLY delay, and its
// own header explicitly names duplicate/reorder/drop as "DUR-05's job, in a much later phase" —
// this file is that later phase. It is a SEPARATE, standalone module rather than a modification
// of delayRelay.ts, because the two have genuinely different jobs: delayRelay.ts's whole design
// (bug 2 in its own header) is built to AVOID accidental reordering under load; this file's
// whole purpose is to inject reordering (among other faults) DELIBERATELY, on request, at an
// exact configured rate — the opposite goal, not a generalization of the same one. It still
// carries forward delayRelay.ts's other two hard-won lessons unchanged: copy every frame into a
// fresh Buffer the instant it's received (never hold a reference across an async boundary), and
// never silently drop a frame just because the destination socket isn't OPEN yet — a frame is
// dropped by this relay ONLY as an explicit, configured fault (dropRate), never as an accident
// of connection timing, since DUR-05/06's own "M2, zero loss" assertion must be checking real
// network fault tolerance, not this test double's own readiness bugs.
//
// Also usable from plain Vitest (Node), not just Playwright/e2e — DUR-05/06's own "4-client,
// 10-minute session" scenario is driven by headless `SyncClient` instances over the real global
// `WebSocket`, the same pattern Phase 23's reconnection.test.ts already established, with this
// relay sitting in between each client and the real server.

import { Channel, decodeFrame, peekChannel, type OpsMessage } from "@collab-editor/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";

export interface FaultRelayOptions {
  /** Fraction of frames, per direction, forwarded TWICE (an independent extra send, its own independently-rolled delay). Test Plan DUR-05: 0.05; DUR-06: 0.25. */
  readonly duplicateRate: number;
  /** Fraction of frames delayed by a uniform-random amount in `delayRangeMs`, rather than forwarded immediately. DUR-05: 0.10 over [1000,3000]; DUR-06: 0.30 over [1000,8000]. */
  readonly delayRate: number;
  readonly delayRangeMs: readonly [number, number];
  /** Fraction of frames that overtake whichever frame (in the same direction) is still pending immediately ahead of them, inverting their relative send order. DUR-05: 0.10; DUR-06: 0.30. */
  readonly reorderRate: number;
  /** Fraction of frames dropped outright — never forwarded at all. DUR-05: 0 (not named); DUR-06: 0.02. */
  readonly dropRate: number;
  /** Injected via a real PRNG so a failing run is reproducible from its own seed, rather than `Math.random()`'s own non-reproducible sequence — matches this project's own Phase 2 fuzz-harness convention. */
  readonly random: () => number;
}

export interface FaultRelay {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function copyRawData(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk)));
  }
  return Buffer.from(new Uint8Array(data));
}

/** Same 5ms readiness-retry constant as delayRelay.ts's own `NOT_READY_RETRY_MS`, for the same reason: short enough not to add perceptible extra latency, long enough not to busy-loop. */
const NOT_READY_RETRY_MS = 5;

interface QueueItem {
  readonly data: Buffer;
  readonly isBinary: boolean;
  dueAt: number;
  /**
   * The originating replica id for an OPS-channel frame, or `null` when it can't be determined
   * (a non-OPS frame, an ack/reject batch, or a decode failure) — see `enqueue`'s own doc
   * comment for why this exists and how it's used.
   */
  readonly author: number | null;
}

/**
 * The replica id that MINTED the operation(s) in `msg`, or `null` if none applies (OP_ACK/
 * OP_REJECT are server-authored batches, not a single replica's own mint). A run/batch always
 * shares exactly one replica by construction (Engine Spec §3.4 — one Engine instance mints
 * consecutive counters), so reading the first/only id is reading all of them, the same
 * shortcut writePath.ts's own step 2 already relies on.
 */
function authorReplicaId(msg: OpsMessage): number | null {
  switch (msg.kind) {
    case "opInsert":
    case "opDelete":
    case "opUndelete":
      return msg.id.r;
    case "opInsertRun":
      return msg.firstId.r;
    case "opDeleteBatch":
      return msg.by;
    default:
      return null;
  }
}

/**
 * One fault-injecting pipe, for ONE direction of ONE connection.
 *
 * A REAL BUG WAS FOUND AND FIXED HERE while root-causing a suspected engine-correctness issue
 * (Test Plan DUR-05/06's own DoD verification): the first version of this function gave every
 * frame its OWN INDEPENDENT `setTimeout`, with no shared ordering at all — meaning a
 * later-arriving frame that happened to roll a SHORTER delay could overtake an earlier frame
 * even with `reorderRate: 0`, silently reproducing `delayRelay.ts`'s OWN "bug 2" (Phase 14,
 * that file's own header comment: "independent per-message timers do not structurally
 * guarantee delivery in arrival order under load") — a lesson this file's own header claimed
 * to carry forward but did not actually implement. Any test run under the ORIGINAL version of
 * this function that used a nonzero `delayRate` was therefore ALSO exercising uncontrolled
 * reordering as an unintended side effect, regardless of what `reorderRate` was set to —
 * findings from that version cannot be trusted to isolate delay from reorder. Fixed by
 * adopting the SAME single-head-timer FIFO queue delayRelay.ts's own `DelayQueue` already
 * proved correct, with reorder now implemented as an EXPLICIT exception (splicing a frame to
 * the front of the queue, jumping the corrected FIFO order on purpose) rather than an
 * uncontrolled side effect of independent timers.
 *
 * A SECOND real bug was found and fixed here, later, during Phase 25's own resumption after
 * the R0010 engine investigation: `reorder`'s splice had NO concept of which replica originally
 * authored a frame, so it could (and, once found, reliably did) splice one client's own
 * operation #5 ahead of that SAME client's own operation #4. This is not a fault a real
 * network can ever produce: `direction` tells this pipe which way it runs, and the
 * client→server direction ALWAYS carries exactly one sender's own frames (one persistent
 * WebSocket = one TCP connection = TCP's own in-order-delivery guarantee, verified by tracing
 * `SyncClient.sendFrame`'s direct, unqueued `ws.send()` call and confirming `writePath.ts` runs
 * fully synchronously from frame receipt through peer broadcast with no `await` in between —
 * broadcast order is therefore always receive order, which is always the sender's own send
 * order). Only the server→client direction ever carries a genuine MIX of different replicas'
 * relayed operations (the server never echoes a sender's own operation back to it) — and even
 * there, reordering two frames that trace back to the SAME original replica would be the
 * identical impossible fault. Fixed by decoding each OPS frame's own author replica id
 * (`authorReplicaId`) and refusing the reorder splice unless the two frames being swapped have
 * DIFFERENT, both-known authors — see `enqueue`'s own doc comment for the mechanism. This
 * closes the gap that let the R0010-investigation's own 4-replica combined-fault repro fire
 * under a fault condition (same-sender reordering) this project's real architecture cannot
 * produce; see CLAUDE.md's own Phase 25 entry for the full account and the confirming re-run.
 */
function makeFaultPipe(
  isReady: () => boolean,
  send: (data: Buffer, isBinary: boolean) => void,
  options: FaultRelayOptions,
  direction: "clientOrigin" | "serverOrigin",
): { readonly forward: (data: Buffer, isBinary: boolean) => void; readonly flush: () => void; readonly stop: () => void } {
  const queue: QueueItem[] = [];
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
    if (stopped) return;
    const now = Date.now();
    while (queue.length > 0 && queue[0]!.dueAt <= now) {
      if (!isReady()) {
        // Never discard for not being ready (delayRelay.ts's own bug 3 lesson) — retry the
        // SAME head-of-queue item until the destination socket is actually open.
        armForHead(NOT_READY_RETRY_MS);
        return;
      }
      const item = queue.shift()!;
      send(item.data, item.isBinary);
    }
    armForHead();
  }

  /**
   * `applyFaults = false` (CONTROL-channel frames, see `forward` below) forces `delayMs = 0`
   * and skips the reorder branch entirely — a real, previously-reintroduced bug: the FIFO-
   * queue rewrite (this file's own header comment on `makeFaultPipe`) replaced the original
   * `scheduleOne(data, isBinary, 0)` immediate-forward call for non-OPS frames with a plain
   * `enqueue(data, isBinary)` call, which does NOT know about channel type and so silently
   * started rolling delay/reorder for CONTROL frames again — exactly the handshake-stall bug
   * this file's own header already documents as found-and-fixed once. Found on re-read during
   * Phase 25's own resumption (after the R0010 engine fix), before being trusted again, not by
   * a failing test.
   */
  /**
   * `author`, resolved once in `forward` via `authorReplicaId`, is the replica id that minted
   * this OPS frame's operation(s), or `null` (a CONTROL frame, or an OP_ACK/OP_REJECT batch).
   * The reorder splice below only ever fires when BOTH the new item and the current head have
   * a known, DIFFERING author — see `makeFaultPipe`'s own doc comment for why this is the
   * realistic restriction: a real network (TCP, one connection per sender) can reorder two
   * DIFFERENT senders' frames relative to each other, never one sender's own frames relative
   * to themselves.
   */
  function enqueue(data: Buffer, isBinary: boolean, author: number | null, applyFaults = true): void {
    let delayMs = 0;
    if (applyFaults && options.delayRate > 0 && options.random() < options.delayRate) {
      const [lo, hi] = options.delayRangeMs;
      delayMs = lo + options.random() * (hi - lo);
    }
    const item: QueueItem = { data, isBinary, dueAt: Date.now() + delayMs, author };
    // Reorder: an EXPLICIT exception to the FIFO order above — splice this frame ahead of
    // whatever currently sits at the head, strictly before its own dueAt, a real, verifiable
    // inversion of send order rather than a side effect of independent timing. Restricted to
    // different, both-known authors (this function's own doc comment) — same-sender reorder is
    // never attempted, since no real network can produce it.
    const head = queue[0];
    const canReorder =
      applyFaults &&
      options.reorderRate > 0 &&
      queue.length > 0 &&
      head !== undefined &&
      author !== null &&
      head.author !== null &&
      author !== head.author &&
      options.random() < options.reorderRate;
    if (canReorder) {
      item.dueAt = Math.min(item.dueAt, head.dueAt - 1);
      queue.unshift(item);
    } else {
      queue.push(item);
    }
    // A newly-armed item at the front, or a shorter overall wait than what's currently armed
    // for, means any existing timer is now aimed at the wrong moment — clear and re-arm fresh.
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    armForHead();
  }

  return {
    forward: (data, isBinary) => {
      if (stopped) return;
      // OPS-CHANNEL FRAMES ONLY -- see this file's own header for why: fault injection into
      // CONTROL-channel frames means duplicating/reordering/dropping HELLO/WELCOME/SNAPSHOT/
      // CATCHUP_*/ALREADY_HAVE/SYNC_COMPLETE, a materially different (and untested,
      // unclaimed-anywhere-in-this-project) guarantee than what DUR-05/06's own "4-client,
      // 10-minute EDITING session" scenario is actually about. A duplicated/reordered WELCOME
      // or SNAPSHOT mid-handshake was confirmed, empirically, to genuinely stall a client's own
      // handshake indefinitely (found by actually running this test, not anticipated) -- CONTROL
      // frames are therefore forwarded UNCONDITIONALLY, immediately (still through the same
      // readiness-retry discipline as everything else, so they can never be silently lost for a
      // TIMING reason), never subject to `options`'s own duplicate/delay/reorder/drop rates.
      const channel = peekChannel(data);
      if (channel !== Channel.OPS) {
        enqueue(data, isBinary, null, false);
        return;
      }
      if (options.dropRate > 0 && options.random() < options.dropRate) {
        return; // an EXPLICIT, configured fault -- never a readiness accident (see this file's header)
      }
      let author: number | null = null;
      try {
        const msg: OpsMessage = decodeFrame(data, { direction });
        author = authorReplicaId(msg);
      } catch {
        // Not decodable as this direction's own OPS message shape -- treat as unknown author
        // (reorder against it is then simply never attempted, the conservative default).
      }
      enqueue(data, isBinary, author);
      if (options.duplicateRate > 0 && options.random() < options.duplicateRate) {
        enqueue(data, isBinary, author); // a second copy of the SAME bytes, its own independent delay/reorder rolls
      }
    },
    flush: () => {
      // Sends everything still queued immediately, ignoring `dueAt` -- same "never silently
      // abandon a queued frame on teardown" lesson as delayRelay.ts's own bug 4.
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
 * Starts a relay listening on `port` (0 = ephemeral) that forwards every WebSocket connection
 * to `targetWsUrl`, applying `options`'s fault injection independently to each direction.
 * Negotiates whatever subprotocol the connecting client offered (matches delayRelay.ts's own
 * approach — SyncClient always offers `obseq.v1`, API Spec §3).
 */
export function startFaultRelay(
  targetWsUrl: string,
  options: FaultRelayOptions,
  port = 0,
): Promise<FaultRelay> {
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

      const toUpstream = makeFaultPipe(
        () => upstream.readyState === WebSocket.OPEN,
        (data, isBinary) => upstream.send(data, { binary: isBinary }),
        options,
        "clientOrigin",
      );
      const toDownstream = makeFaultPipe(
        () => downstream.readyState === WebSocket.OPEN,
        (data, isBinary) => downstream.send(data, { binary: isBinary }),
        options,
        "serverOrigin",
      );

      downstream.on("message", (data, isBinary) => toUpstream.forward(copyRawData(data), isBinary));
      upstream.on("message", (data, isBinary) => toDownstream.forward(copyRawData(data), isBinary));

      function teardown(): void {
        toUpstream.stop();
        toDownstream.stop();
      }
      downstream.on("close", () => {
        toUpstream.flush();
        upstream.close();
        teardown();
      });
      upstream.on("close", (code, reason) => {
        toDownstream.flush();
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
