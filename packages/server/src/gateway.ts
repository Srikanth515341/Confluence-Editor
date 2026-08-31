import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  Channel,
  ProtocolDecodeError,
  SessionRole,
  decodeControlFrame,
  decodeFrame,
  encodeControlFrame,
  encodeFrame,
  peekChannel,
  type ControlMessage,
  type OpsMessage,
} from "@collab-editor/protocol";
import { AckBatcher } from "./ackBatcher.js";
import type { OperationStore } from "./db/operationStore.js";
import { DocumentCoordinator, type CoordinatorSession } from "./documentCoordinator.js";
import { armPresenceStaleTimer, disarmPresenceStaleTimer, onPingReceived } from "./heartbeat.js";
import { buildSnapshotMessage, buildWelcomeMessage } from "./handshake.js";
import { logger } from "./logger.js";
import { ConnectionSendQueues } from "./sendQueues.js";
import { processIncomingOperation } from "./writePath.js";

/** WebSocket path and subprotocol (API Spec §1.2/§3). */
export const WS_PATH = "/v1/rt";
export const WS_SUBPROTOCOL = "obseq.v1";

/** `ws.bufferedAmount` (bytes) above which a connection is considered backpressured — consulted only by the PRESENCE queue's shed policy (sendQueues.ts, §3.3). */
const BACKPRESSURE_THRESHOLD_BYTES = 1 << 20; // 1 MiB

export interface Gateway {
  readonly wss: WebSocketServer;
  readonly coordinators: ReadonlyMap<string, DocumentCoordinator>;
  close(): void;
}

/** Normalizes `ws`'s `RawData` (Buffer | ArrayBuffer | Buffer[]) to one Uint8Array regardless of fragmentation. */
function toUint8Array(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return new Uint8Array(data);
}

function getOrCreateCoordinator(
  coordinators: Map<string, DocumentCoordinator>,
  documentId: string,
  operationStore: OperationStore,
): DocumentCoordinator {
  let coordinator = coordinators.get(documentId);
  if (!coordinator) {
    coordinator = new DocumentCoordinator(documentId, operationStore);
    coordinators.set(documentId, coordinator);
  }
  return coordinator;
}

export interface CreateGatewayDeps {
  readonly operationStore: OperationStore;
}

/** Wires the WebSocket server (path/subprotocol per API Spec §1.2/§3) onto an existing HTTP server, with one DocumentCoordinator per open document. */
export function createGateway(httpServer: HttpServer, deps: CreateGatewayDeps): Gateway {
  const { operationStore } = deps;
  const coordinators = new Map<string, DocumentCoordinator>();

  const wss = new WebSocketServer({
    server: httpServer,
    path: WS_PATH,
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  });

  wss.on("connection", (ws: WebSocket) => {
    const sessionId = randomUUID();
    // `bound` is set the moment HELLO completes the handshake (API Spec §1.2: "bound to
    // exactly one document at handshake time and never rebinds" — this is that binding).
    // Before that, the socket exists but belongs to no document and no coordinator.
    let bound:
      | { readonly coordinator: DocumentCoordinator; readonly session: CoordinatorSession }
      | undefined;

    const queues = new ConnectionSendQueues(
      (frame) =>
        new Promise<void>((resolve, reject) => {
          ws.send(frame, { binary: true }, (err) => (err ? reject(err) : resolve()));
        }),
      () => ws.bufferedAmount > BACKPRESSURE_THRESHOLD_BYTES,
    );

    logger.info("ws.open", { sessionId });

    function closeMalformed(reason: string): void {
      logger.warn("ws.malformedFrame", {
        sessionId,
        documentId: bound?.coordinator.documentId,
        reason,
      });
      ws.close(1008, "malformed frame");
    }

    /**
     * The first frame after the upgrade MUST be HELLO on CONTROL (API Spec
     * §3.6.1). Everything else (wrong channel, wrong CONTROL type, a decode
     * failure) closes the socket — there is no partially-joined state to
     * clean up, since nothing was registered with a coordinator yet.
     *
     * Async as of Phase 16: a brand-new (or not-yet-warm-started)
     * coordinator's `ready` promise must resolve before WELCOME/SNAPSHOT
     * can be sent — otherwise a client could be handed a SNAPSHOT of an
     * empty engine while that same document's persisted history is still
     * being loaded in the background, then watch operations it already
     * has "reappear" once warm start finishes applying them out from
     * under it.
     */
    async function handleHandshake(bytes: Uint8Array): Promise<void> {
      if (peekChannel(bytes) !== Channel.CONTROL) {
        closeMalformed("first frame must be HELLO on the CONTROL channel");
        return;
      }
      let ctrlMsg: ControlMessage;
      try {
        ctrlMsg = decodeControlFrame(bytes, { direction: "clientOrigin" });
      } catch (err) {
        closeMalformed(err instanceof ProtocolDecodeError ? err.reason : "DECODE_ERROR");
        return;
      }
      if (ctrlMsg.kind !== "hello") {
        closeMalformed(`first frame must be HELLO, got ${ctrlMsg.kind}`);
        return;
      }

      const coordinator = getOrCreateCoordinator(coordinators, ctrlMsg.documentId, operationStore);
      try {
        await coordinator.ready;
      } catch (err) {
        // Warm start failed (e.g. the pendingCount()===0 assertion fired, or the database is
        // unreachable) — a server-side fault, not a malformed client frame, so this closes with
        // 1011 ("internal error") rather than closeMalformed's 1008.
        logger.error("ws.warmStartFailed", {
          documentId: ctrlMsg.documentId,
          sessionId,
          message: err instanceof Error ? err.message : String(err),
        });
        ws.close(1011, "document failed to warm start");
        return;
      }
      if (ws.readyState !== ws.OPEN) {
        return; // the socket closed while warm start was in flight — nothing left to admit
      }

      const replicaId = coordinator.allocateReplicaId();
      const session: CoordinatorSession = {
        sessionId,
        replicaId,
        queues,
        ackBatcher: new AckBatcher((entries) => {
          queues.enqueue("ops", encodeFrame({ kind: "opAck", acks: entries }));
        }),
        // Hardcoded EDITOR for every session this phase — matches buildWelcomeMessage's role (real roles/auth are Phase 26-29).
        role: SessionRole.EDITOR,
        // Placeholder identity — real users don't exist until Phase 26.
        userId: randomUUID(),
        displayName: `Guest ${replicaId}`,
        lastPingAt: Date.now(),
        presenceStale: false,
        staleTimer: undefined,
        receivedFrameCount: 0,
      };
      coordinator.join(session);
      bound = { coordinator, session };
      armPresenceStaleTimer(session);
      logger.info("ws.connect", { documentId: ctrlMsg.documentId, sessionId, replicaId });

      // WELCOME, then SNAPSHOT (API Spec §3.6.1-§3.6.3) — both on CONTROL, in this order,
      // so the client always sees its own admission before the state it's being admitted to.
      queues.enqueue(
        "control",
        encodeControlFrame(buildWelcomeMessage(coordinator, sessionId, replicaId)),
      );
      queues.enqueue("control", encodeControlFrame(buildSnapshotMessage(coordinator)));
    }

    /** PING/SYNC_COMPLETE/LEAVE — the only CONTROL types a client may legally send after handshake (§3.6). */
    function handleControlMessage(ctrlMsg: ControlMessage): void {
      if (!bound) {
        return;
      }
      const { coordinator, session } = bound;
      switch (ctrlMsg.kind) {
        case "ping": {
          onPingReceived(session);
          coordinator.watermarks.set(session.replicaId, BigInt(ctrlMsg.lastAppliedSeq));
          queues.enqueue(
            "control",
            encodeControlFrame({
              kind: "pong",
              clientTimeMs: ctrlMsg.clientTimeMs,
              serverSeq: Number(coordinator.currentSeq),
            }),
          );
          break;
        }
        case "syncComplete":
          logger.info("ws.syncComplete", {
            documentId: coordinator.documentId,
            sessionId,
            lastServerSeq: ctrlMsg.lastServerSeq,
            resentCount: ctrlMsg.resentCount,
          });
          break;
        case "leave":
          logger.info("ws.leave", {
            documentId: coordinator.documentId,
            sessionId,
            lastAppliedSeq: ctrlMsg.lastAppliedSeq,
          });
          break;
        default:
          // HELLO again, or a server-only type somehow past decodeControlFrame's direction
          // check (shouldn't happen) — ignore rather than tear down an otherwise-healthy session.
          break;
      }
    }

    // The handler itself stays synchronous-looking (`ws.on` never awaits its return value
    // regardless), but its body is `async` as of Phase 16 (handleHandshake awaits warm start;
    // OPS ingestion awaits the write path's transaction) — wrapped in its own async IIFE and
    // `.catch()` so a rejection (e.g. a database error) is logged instead of becoming an
    // unhandled promise rejection that could crash the process.
    ws.on("message", (data, isBinary) => {
      void (async () => {
        if (!isBinary) {
          // Binary frames only (Scope-IN, Phase 8). A text frame is malformed input at the transport level.
          ws.close(1003, "binary frames only");
          return;
        }
        const bytes = toUint8Array(data);

        if (!bound) {
          await handleHandshake(bytes);
          return;
        }

        // Diagnostic-only counter (see CoordinatorSession.receivedFrameCount's doc comment) —
        // counts every frame that actually reaches this handler, any channel, before any
        // decode/dispatch, so it reflects what the server truly received regardless of what
        // happens to the frame afterward.
        bound.session.receivedFrameCount += 1;

        const channel = peekChannel(bytes);
        if (channel === Channel.OPS) {
          let msg: OpsMessage;
          try {
            msg = decodeFrame(bytes, { direction: "clientOrigin" });
          } catch (err) {
            closeMalformed(err instanceof ProtocolDecodeError ? err.reason : "DECODE_ERROR");
            return;
          }
          await processIncomingOperation({
            coordinator: bound.coordinator,
            session: bound.session,
            msg,
          });
        } else if (channel === Channel.CONTROL) {
          let ctrlMsg: ControlMessage;
          try {
            ctrlMsg = decodeControlFrame(bytes, { direction: "clientOrigin" });
          } catch (err) {
            closeMalformed(err instanceof ProtocolDecodeError ? err.reason : "DECODE_ERROR");
            return;
          }
          handleControlMessage(ctrlMsg);
        } else {
          // PRESENCE (0x02) isn't built yet (Phase 31); anything else is not a valid channel.
          closeMalformed(`unsupported channel ${channel}`);
        }
      })().catch((err: unknown) => {
        logger.error("ws.messageHandlerFailed", {
          sessionId,
          documentId: bound?.coordinator.documentId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    });

    ws.on("close", (code) => {
      queues.close();
      if (bound) {
        disarmPresenceStaleTimer(bound.session);
        bound.session.ackBatcher.close();
        bound.coordinator.leave(sessionId);
        logger.info("ws.disconnect", { documentId: bound.coordinator.documentId, sessionId, code });
        // Deliberately NOT deleting the coordinator when it empties out (Phase 8 did this; Phase
        // 9 removes it): API Spec §3.6.2 requires replica ids to be "NEVER reused, NEVER
        // reclaimed" for a document's whole lifetime. With no persistence yet (Phase 15), the
        // only way to honor that once every session has left and a new one later joins the same
        // document is to keep the coordinator (and its replica-id counter) alive in memory for
        // the life of the process — recreating it on the next join would silently reset the
        // counter back to 1 and hand out an already-used id.
      } else {
        logger.info("ws.disconnect", { sessionId, code });
      }
    });

    ws.on("error", (err) => {
      logger.error("ws.error", {
        sessionId,
        documentId: bound?.coordinator.documentId,
        message: err.message,
      });
    });
  });

  return {
    wss,
    coordinators,
    close: () => {
      // `wss.close()` alone only stops accepting NEW connections — it does not touch already-open
      // sockets, so `httpServer.close(cb)` (server.ts) would hang forever waiting for them to end
      // on their own. Terminate every still-open connection first so shutdown always completes.
      for (const ws of wss.clients) {
        ws.terminate();
      }
      wss.close();
    },
  };
}
