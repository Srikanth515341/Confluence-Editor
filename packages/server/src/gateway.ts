import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  ProtocolDecodeError,
  decodeFrame,
  encodeFrame,
  type OpsMessage,
} from "@collab-editor/protocol";
import { DocumentCoordinator } from "./documentCoordinator.js";
import { toOperations } from "./ingest.js";
import { logger } from "./logger.js";
import { ConnectionSendQueues } from "./sendQueues.js";

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

/**
 * `documentId` binding (API Spec §1.2: "A WebSocket connection is bound to
 * exactly one document at handshake time and never rebinds"). This phase
 * has no real handshake message yet (Phase 9) and no auth yet (Phases
 * 26-29), so the interim binding mechanism is a `documentId` query
 * parameter on the upgrade URL, read once at connect time and never
 * consulted again for that socket — satisfying "bound at handshake time,
 * never rebinds" without inventing any CONTROL-channel frame content.
 * Phase 9 replaces this with the real handshake.
 */
function readDocumentId(requestUrl: string | undefined): string | null {
  if (!requestUrl) {
    return null;
  }
  const url = new URL(requestUrl, "http://internal");
  return url.searchParams.get("documentId");
}

function getOrCreateCoordinator(
  coordinators: Map<string, DocumentCoordinator>,
  documentId: string,
): DocumentCoordinator {
  let coordinator = coordinators.get(documentId);
  if (!coordinator) {
    coordinator = new DocumentCoordinator(documentId);
    coordinators.set(documentId, coordinator);
  }
  return coordinator;
}

/**
 * Ingress path for one decoded OPS message (API/Protocol/Data Spec's
 * "decode → engine.applyRemote → assign seq → broadcast to peers"):
 * applies every operation the message expands to, assigns the coordinator's
 * next `currentSeq` to the WHOLE FRAME (not per underlying operation —
 * OP_INSERT_RUN/OP_DELETE_BATCH carry exactly one `seq` field on the wire,
 * so a single frame can only be stamped once; Phase 16's real ack design
 * may need to revisit this if OP_ACK's per-operation `(ackSeq, ackStamp)`
 * pairs require finer granularity), and relays the SAME message shape
 * (re-stamped) to every other session in the room — preserving a run/batch
 * frame's compact wire representation on relay instead of expanding it
 * into individual OP_INSERT frames. No ack is sent back to the sender:
 * acks require durable storage, which doesn't exist until Phase 16.
 */
function ingestOperation(
  coordinator: DocumentCoordinator,
  msg: OpsMessage,
  fromSessionId: string,
): void {
  if (msg.kind === "opAck" || msg.kind === "opReject") {
    // Unreachable in practice: decodeFrame({ direction: "clientOrigin" }) already rejects both
    // (server→client only, §3.5.7/§3.5.8) before this function is ever called. Narrows `msg`'s
    // type below so the re-stamped spread type-checks against the remaining 5-member union,
    // all of which do carry `seq`.
    throw new Error(`ingestOperation: ${msg.kind} is server→client only`);
  }
  const ops = toOperations(msg);
  for (const op of ops) {
    coordinator.engine.applyRemote(op);
  }
  coordinator.currentSeq += 1n;
  const relay: OpsMessage = { ...msg, seq: Number(coordinator.currentSeq) };
  const relayBytes = encodeFrame(relay);
  for (const session of coordinator.otherSessions(fromSessionId)) {
    session.queues.enqueue("ops", relayBytes);
  }
}

/** Wires the WebSocket server (path/subprotocol per API Spec §1.2/§3) onto an existing HTTP server, with one DocumentCoordinator per open document. */
export function createGateway(httpServer: HttpServer): Gateway {
  const coordinators = new Map<string, DocumentCoordinator>();

  const wss = new WebSocketServer({
    server: httpServer,
    path: WS_PATH,
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  });

  wss.on("connection", (ws: WebSocket, request) => {
    const documentId = readDocumentId(request.url);
    if (!documentId) {
      ws.close(1008, "documentId query parameter is required");
      return;
    }

    const sessionId = randomUUID();
    const coordinator = getOrCreateCoordinator(coordinators, documentId);
    const replicaId = coordinator.allocateReplicaId();

    const queues = new ConnectionSendQueues(
      (frame) =>
        new Promise<void>((resolve, reject) => {
          ws.send(frame, { binary: true }, (err) => (err ? reject(err) : resolve()));
        }),
      () => ws.bufferedAmount > BACKPRESSURE_THRESHOLD_BYTES,
    );

    coordinator.join({ sessionId, replicaId, queues });
    logger.info("ws.connect", { documentId, sessionId, replicaId });

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        // Binary frames only (Scope-IN, this phase). A text frame is malformed input at the transport level.
        ws.close(1003, "binary frames only");
        return;
      }
      const bytes = toUint8Array(data);

      let msg: OpsMessage;
      try {
        msg = decodeFrame(bytes, { direction: "clientOrigin" });
      } catch (err) {
        const reason = err instanceof ProtocolDecodeError ? err.reason : "DECODE_ERROR";
        logger.warn("ws.malformedFrame", { documentId, sessionId, reason });
        ws.close(1008, "malformed frame");
        return;
      }

      ingestOperation(coordinator, msg, sessionId);
    });

    ws.on("close", (code) => {
      queues.close();
      coordinator.leave(sessionId);
      logger.info("ws.disconnect", { documentId, sessionId, code });
      if (coordinator.sessionCount === 0) {
        coordinators.delete(documentId);
      }
    });

    ws.on("error", (err) => {
      logger.error("ws.error", { documentId, sessionId, message: err.message });
    });
  });

  return {
    wss,
    coordinators,
    close: () => {
      wss.close();
    },
  };
}
