import type { IncomingMessage, Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  Channel,
  ErrorCode,
  GoodbyeReason,
  ProtocolDecodeError,
  SessionRole,
  SyncMode,
  decodeControlFrame,
  decodeFrame,
  decodePresenceFrame,
  encodeControlFrame,
  encodeFrame,
  peekChannel,
  type ControlMessage,
  type OpsMessage,
  type PresenceMessage,
} from "@collab-editor/protocol";
import { AckBatcher } from "./ackBatcher.js";
import type { OperationStore } from "./db/operationStore.js";
import type { DbPool } from "./db/pool.js";
import { getUserRole, type DocumentRole } from "./db/documentStore.js";
import { DocumentCoordinator, type CoordinatorSession } from "./documentCoordinator.js";
import { armPresenceStaleTimer, disarmPresenceStaleTimer, onPingReceived } from "./heartbeat.js";
import { PresenceLeaveReason, PresenceRoom } from "./presenceManager.js";
import {
  buildAlreadyHaveMessage,
  buildCatchupMessages,
  buildSnapshotMessage,
  buildWelcomeMessage,
  decideSyncMode,
} from "./handshake.js";
import { logger } from "./logger.js";
import { InMemoryRateLimiter } from "./rateLimiter.js";
import { ConnectionSendQueues } from "./sendQueues.js";
import type { InMemoryTicketStore } from "./ticketStore.js";
import type { CircuitBreakerConfig, ConnectionRateLimitConfig, RateLimitConfig } from "./config.js";
import { processIncomingOperation } from "./writePath.js";

function documentRoleToSessionRole(role: DocumentRole): SessionRole {
  switch (role) {
    case "owner":
      return SessionRole.OWNER;
    case "editor":
      return SessionRole.EDITOR;
    case "viewer":
      return SessionRole.VIEWER;
  }
}

/** WebSocket path and subprotocol (API Spec §1.2/§3). */
export const WS_PATH = "/v1/rt";
export const WS_SUBPROTOCOL = "obseq.v1";

/** `ws.bufferedAmount` (bytes) above which a connection is considered backpressured — consulted only by the PRESENCE queue's shed policy (sendQueues.ts, §3.3). */
const BACKPRESSURE_THRESHOLD_BYTES = 1 << 20; // 1 MiB

export interface Gateway {
  readonly wss: WebSocketServer;
  readonly coordinators: ReadonlyMap<string, DocumentCoordinator>;
  /** Phase 31 (API Spec §3.8) — one `PresenceRoom` per open document, structurally SEPARATE from `coordinators` above (never imports `@collab-editor/engine` or any persistence module — see presenceManager.ts's own header comment). Exposed read-only for tests/diagnostics, the same pattern as `coordinators`. */
  readonly presenceRooms: ReadonlyMap<string, PresenceRoom>;
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
  pool: DbPool | undefined,
  rateLimit: RateLimitConfig | undefined,
  circuitBreaker: Partial<CircuitBreakerConfig> | undefined,
): DocumentCoordinator {
  let coordinator = coordinators.get(documentId);
  if (!coordinator) {
    // `lookupRole` is bound to THIS documentId once, here, at construction — see
    // DocumentCoordinator's own `lookupRole` field doc comment for why it's `undefined`
    // (falling back to Phase 28's `session.role`-only check) whenever `pool` isn't configured.
    const lookupRole = pool ? (userId: string) => getUserRole(pool, documentId, userId) : undefined;
    // Phase 30: `rateLimit`/`circuitBreaker` come straight from this gateway's own construction
    // deps (below) — `undefined` for every pre-Phase-30 test (op-rate-limiting stays disabled,
    // circuit-breaker stays at its generous, always-on default; see DocumentCoordinator's own
    // field doc comments for why that split is safe).
    coordinator = new DocumentCoordinator(documentId, operationStore, undefined, lookupRole, {
      ...(rateLimit ? { rateLimit } : {}),
      ...(circuitBreaker ? { circuitBreaker } : {}),
    });
    coordinators.set(documentId, coordinator);
  }
  return coordinator;
}

/**
 * Phase 31 — one `PresenceRoom` per document, lazily created on first join, mirroring
 * `getOrCreateCoordinator`'s own shape but deliberately independent of it: a presence room never
 * needs the `OperationStore`/`DbPool`/rate-limit config a `DocumentCoordinator` does, and is never
 * removed once created (the same "replica ids/coordinators live for the process's whole lifetime"
 * reasoning `gateway.ts`'s own `ws.on("close", ...)` comment already gives for `coordinators` — an
 * empty presence room costs nothing to keep around, and there is no persisted counter here that
 * recreating it could reset).
 */
function getOrCreatePresenceRoom(
  presenceRooms: Map<string, PresenceRoom>,
  documentId: string,
): PresenceRoom {
  let room = presenceRooms.get(documentId);
  if (!room) {
    room = new PresenceRoom();
    presenceRooms.set(documentId, room);
  }
  return room;
}

export interface CreateGatewayDeps {
  readonly operationStore: OperationStore;
  /**
   * Phase 29 (API Spec §1.5/§4.10) — REAL WebSocket admission ticket validation and per-user
   * `document_permissions` lookups. Optional for the SAME reason `HttpAppDeps.authDeps` is
   * (server.ts's own construction is the direct precedent, and shares this exact pool/config):
   * every pre-Phase-29 test constructing a gateway (gateway.test.ts, heartbeat.test.ts, most of
   * `db/*.db.test.ts`) has no real Postgres instance and no reason to exercise real auth — when
   * omitted, HELLO's `ticket` field is accepted unconditionally (byte-for-byte the original
   * Phase 8-28 behavior) and every session still gets the hardcoded EDITOR default (or a
   * `testOnlyQueueRoleOverride`, Phase 24's own test seam) rather than a real, looked-up role.
   * `ticketStore` MUST be the SAME instance `POST /v1/documents/{id}/rt-ticket` (httpApp.ts)
   * issues tickets into — server.ts's own construction is what guarantees this.
   */
  readonly auth?: { readonly pool: DbPool; readonly ticketStore: InMemoryTicketStore };
  /**
   * Phase 30 (RFC §8.2 (T2), Test Plan SEC-08) — per-session/per-document operation rate
   * limiting, threaded straight into every `DocumentCoordinator` this gateway creates. `undefined`
   * (every pre-Phase-30 test) disables it entirely — see `RateLimitConfig`'s own doc comment
   * (config.ts) for why this specific feature defaults to off rather than a generous always-on
   * default.
   */
  readonly rateLimit?: RateLimitConfig;
  /** Phase 30 — overrides `DocumentCoordinator`'s own generous, always-on circuit-breaker defaults; mainly for tests wanting a tiny ceiling. */
  readonly circuitBreaker?: Partial<CircuitBreakerConfig>;
  /**
   * Phase 30 (RFC §8.8) — per-IP and (once a real ticket identity is known) per-account
   * WebSocket CONNECTION-attempt limiting, checked before any HELLO handshake work happens.
   * `undefined` (every pre-Phase-30 test) disables it entirely.
   */
  readonly connectionRateLimit?: ConnectionRateLimitConfig;
}

/** Wires the WebSocket server (path/subprotocol per API Spec §1.2/§3) onto an existing HTTP server, with one DocumentCoordinator per open document. */
export function createGateway(httpServer: HttpServer, deps: CreateGatewayDeps): Gateway {
  const { operationStore, auth, rateLimit, circuitBreaker, connectionRateLimit } = deps;
  const coordinators = new Map<string, DocumentCoordinator>();
  // Phase 31 (API Spec §3.8) — structurally separate from `coordinators`; see `Gateway.
  // presenceRooms`'s own doc comment and presenceManager.ts's header comment for why.
  const presenceRooms = new Map<string, PresenceRoom>();
  // Phase 30 (RFC §8.8) — ONE shared limiter for this whole gateway's lifetime, keyed
  // `ip:<addr>`/`account:<userId>` so the two scopes never collide in the same map.
  const connectionLimiter = new InMemoryRateLimiter();

  const wss = new WebSocketServer({
    server: httpServer,
    path: WS_PATH,
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const sessionId = randomUUID();
    // No trusted-proxy handling (`X-Forwarded-For`) — this project has no reverse-proxy
    // deployment story yet, so the raw socket's own remote address is the only value that
    // can't be spoofed by whoever is actually opening the TCP connection.
    const remoteIp = req.socket.remoteAddress ?? "unknown";

    // Phase 30 (RFC §8.8) — checked BEFORE anything else, including HELLO: a connection that
    // never even attempts to authenticate still costs a TCP/WS handshake and an entry in `wss`'s
    // own client set, so this must reject as early as possible, not after HELLO is parsed.
    if (connectionRateLimit && !connectionLimiter.consume(`ip:${remoteIp}`, connectionRateLimit.perIp)) {
      logger.warn("ws.connectionRateLimited", { sessionId, scope: "ip" });
      const frame = encodeControlFrame({
        kind: "error",
        code: ErrorCode.RATE_LIMITED,
        fatal: true,
        message: "too many connection attempts from this address",
      });
      ws.send(frame, { binary: true }, () => {
        ws.close(1008, "connection rate limit exceeded");
      });
      return;
    }
    // `bound` is set the moment HELLO completes the handshake (API Spec §1.2: "bound to
    // exactly one document at handshake time and never rebinds" — this is that binding).
    // Before that, the socket exists but belongs to no document and no coordinator.
    let bound:
      | {
          readonly coordinator: DocumentCoordinator;
          readonly session: CoordinatorSession;
          readonly presenceRoom: PresenceRoom;
        }
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
     * Phase 29 — rejects the handshake with a real CONTROL-channel ERROR frame (API Spec §4.10:
     * `ERROR{invalid_ticket, fatal: 1}`) BEFORE closing, mirroring `disconnectForRevocation`'s own
     * "send the frame first, close only once it's actually been written" ordering — closing
     * immediately after `send()` returns (before its callback fires) risks the close frame racing
     * ahead of the ERROR payload on some platforms. `1008` (policy violation) is the same close
     * code `closeMalformed` already uses for "this client did something the protocol forbids" —
     * a rejected ticket is exactly that category, not a server-side fault.
     */
    function rejectHandshake(code: ErrorCode, reason: string, message: string): void {
      logger.warn("ws.handshakeRejected", { sessionId, reason });
      const frame = encodeControlFrame({ kind: "error", code, fatal: true, message });
      ws.send(frame, { binary: true }, () => {
        ws.close(1008, reason);
      });
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

      // Phase 29 (API Spec §1.5/§4.10) — real ticket validation, only when this gateway was
      // configured with real `auth` deps (see CreateGatewayDeps.auth's own doc comment for why
      // every pre-Phase-29 test skips this entirely). Deliberately checked BEFORE creating/
      // warm-starting a coordinator for `ctrlMsg.documentId` — a bad ticket should cost nothing
      // more than an in-memory map lookup, not a coordinator construction (and, for a brand-new
      // document, a real warm-start DB round trip) for a connection that's about to be rejected
      // anyway.
      let realIdentity: { readonly userId: string; readonly displayName: string } | undefined;
      if (auth) {
        const ticketString = new TextDecoder().decode(ctrlMsg.ticket);
        const consumed = auth.ticketStore.consume(ticketString, ctrlMsg.documentId);
        if (consumed.outcome !== "ok") {
          // ONE wire signal for every failure mode (not-found/already-used/expired/wrong-document)
          // — API Spec §4.10 names a single `invalid_ticket` code, and distinguishing these on the
          // wire would hand an attacker a real oracle (e.g. "wrong-document" vs "expired" leaks
          // whether a guessed ticket string was ever real). The specific reason is still logged
          // server-side (below) for real operational visibility.
          rejectHandshake(
            ErrorCode.INVALID_TICKET,
            `invalid ticket (${consumed.outcome})`,
            "invalid or expired ticket",
          );
          return;
        }
        realIdentity = { userId: consumed.userId, displayName: consumed.displayName };

        // Phase 30 (RFC §8.8) — the per-ACCOUNT half of connection-rate limiting. Only reachable
        // here, never earlier: there is no real identity to key on before a ticket is consumed
        // (see ConnectionRateLimitConfig's own doc comment for why a server with no `auth` deps
        // skips this entirely).
        if (
          connectionRateLimit &&
          !connectionLimiter.consume(`account:${realIdentity.userId}`, connectionRateLimit.perAccount)
        ) {
          logger.warn("ws.connectionRateLimited", { sessionId, scope: "account" });
          rejectHandshake(
            ErrorCode.RATE_LIMITED,
            "too many connection attempts for this account",
            "too many connection attempts",
          );
          return;
        }
      }

      const coordinator = getOrCreateCoordinator(
        coordinators,
        ctrlMsg.documentId,
        operationStore,
        auth?.pool,
        rateLimit,
        circuitBreaker,
      );
      try {
        await coordinator.ready;
      } catch (err) {
        // Warm start failed (e.g. the pendingCount()===0 assertion fired, or the database is
        // unreachable) — a server-side fault, not a malformed client frame, so this closes with
        // 1011 ("internal error") rather than closeMalformed's 1008.
        logger.error("ws.warmStartFailed", {
          documentId: ctrlMsg.documentId,
          sessionId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        ws.close(1011, "document failed to warm start");
        return;
      }
      if (ws.readyState !== ws.OPEN) {
        return; // the socket closed while warm start was in flight — nothing left to admit
      }

      const replicaId = coordinator.allocateReplicaId();
      // Phase 24, Test Plan RC-32 — TEST-ONLY: consumes a one-shot role override queued via
      // `DocumentCoordinator.testOnlyQueueRoleOverride`, standing in for a real, persisted
      // permission lookup. Only ever consulted when this connection has NO real ticket-based
      // identity (see below) — a real, authenticated connection's role always comes from a
      // genuine `document_permissions` lookup as of Phase 29, never from this test seam.
      const roleOverride = coordinator.consumeTestOnlyRoleOverride();

      let role: SessionRole;
      let userId: string;
      let displayName: string;
      if (realIdentity) {
        // Phase 29: a REAL, fresh permission lookup — not the ticket's own (up to 30s stale)
        // snapshot. A ticket only proves "this user could issue a ticket a moment ago"; the
        // actual role admitted here must reflect the CURRENT database state, since a grant/revoke
        // could legitimately land in that same window.
        const dbRole = await getUserRole(auth!.pool, ctrlMsg.documentId, realIdentity.userId);
        if (!dbRole) {
          rejectHandshake(
            ErrorCode.SESSION_EXPIRED,
            "access no longer granted at connect time",
            "your access to this document has ended",
          );
          return;
        }
        role = documentRoleToSessionRole(dbRole);
        userId = realIdentity.userId;
        displayName = realIdentity.displayName;
      } else {
        role = roleOverride ?? SessionRole.EDITOR;
        // Placeholder identity — real, ticket-based identity only exists when `auth` deps are
        // configured (Phase 29); every other connection keeps this project's original Phase
        // 8-16 placeholder.
        userId = randomUUID();
        displayName = `Guest ${replicaId}`;
      }

      const session: CoordinatorSession = {
        sessionId,
        replicaId,
        queues,
        ackBatcher: new AckBatcher((entries) => {
          queues.enqueue("ops", encodeFrame({ kind: "opAck", acks: entries }));
        }),
        role,
        userId,
        displayName,
        lastPingAt: Date.now(),
        presenceStale: false,
        staleTimer: undefined,
        receivedFrameCount: 0,
        // Phase 27 (API Spec §4.5 DELETE) — see CoordinatorSession.disconnectForRevocation's own
        // doc comment. `4001` is an application-specific WebSocket close code (the 4000-4999
        // range is reserved for exactly this); the CONTROL-level GOODBYE frame's own `reason`
        // field (PERMISSION_REVOKED) is the actual, protocol-defined signal a real client parses
        // — this raw close code is only ever a secondary, transport-level hint.
        disconnectForRevocation: () => {
          if (ws.readyState !== ws.OPEN) return;
          const frame = encodeControlFrame({
            kind: "goodbye",
            reason: GoodbyeReason.PERMISSION_REVOKED,
            // A revoked document's access isn't coming back — 0 signals "do not retry," unlike
            // e.g. a SHUTDOWN goodbye, which would give a real backoff hint instead.
            retryAfterMs: 0,
          });
          // Send the GOODBYE first, close only once it's actually been written to the socket —
          // closing immediately after `send()` returns (before its own callback fires) risks the
          // close frame racing ahead of the GOODBYE payload on some platforms.
          ws.send(frame, { binary: true }, () => {
            ws.close(4001, "document access revoked");
          });
        },
        // Phase 30 (RFC §8.2 (T2), Test Plan SEC-08: "throttles ... then disconnects") — see
        // CoordinatorSession.disconnectForRateLimit's own doc comment. `EVICTED` (not a new
        // GoodbyeReason value) already names exactly this category ("the server is ending this
        // session"); `4002`, a second application-specific close code distinct from revocation's
        // `4001`, so a real client's own transport-level logging can tell the two apart even
        // though the GOODBYE frame's own `reason` is the actual, protocol-defined signal.
        // `retryAfterMs` is nonzero, unlike revocation's `0` -- a rate-limited session is welcome
        // to reconnect once it backs off, unlike a permission revocation, which never reverses
        // itself without a NEW grant.
        disconnectForRateLimit: () => {
          if (ws.readyState !== ws.OPEN) return;
          const frame = encodeControlFrame({
            kind: "goodbye",
            reason: GoodbyeReason.EVICTED,
            retryAfterMs: 5000,
          });
          ws.send(frame, { binary: true }, () => {
            ws.close(4002, "sustained rate limit violation");
          });
        },
        // `onPresenceStale` (Phase 31, API Spec §3.8) is set just below, once `presenceRoom`
        // exists — omitted here (not assigned `undefined`) since `exactOptionalPropertyTypes`
        // treats an explicit `undefined` differently from an omitted optional field, and this
        // field is genuinely mutable, unlike `disconnectForRevocation`/`disconnectForRateLimit`
        // above (both fixed at construction time since they close over `ws` directly).
      };
      coordinator.join(session);
      // Phase 31 — the SAME authorization that just admitted this session to the document's
      // coordinator (role/userId/displayName, computed above) is what gates its presence room
      // membership too (Scope-IN: "presence room membership gated by the Phase 28 authorization
      // layer") — no separate check is performed here, since there is nothing left to check.
      const presenceRoom = getOrCreatePresenceRoom(presenceRooms, ctrlMsg.documentId);
      presenceRoom.join({ sessionId, replicaId, userId, displayName, role }, (frame) => {
        queues.enqueue("presence", frame);
      });
      session.onPresenceStale = () => presenceRoom.leave(sessionId, PresenceLeaveReason.STALE);
      bound = { coordinator, session, presenceRoom };
      armPresenceStaleTimer(session);
      logger.info("ws.connect", { documentId: ctrlMsg.documentId, sessionId, replicaId });

      // Phase 21: persist this session's row NOW, at join time, not only on its first
      // committed operation (writePath.ts's own auto-provisioning) — a session that only
      // ever READS must still appear in the GC stability frontier query (API Spec §6.5), or
      // an active-but-silent reader's still-needed tombstones could be collected out from
      // under it. Fire-and-forget (never blocks the handshake on a DB round trip) — a
      // failure here just means this session is invisible to the frontier until its next
      // PING succeeds, not a correctness break in anything already committed.
      coordinator.operationStore
        .upsertSessionHeartbeat({
          sessionId,
          documentId: ctrlMsg.documentId,
          userId: session.userId,
          replicaId,
          displayName: session.displayName,
          lastAckSeq: 0n,
        })
        .catch((err: unknown) => {
          logger.error("gc.heartbeatFailed", {
            documentId: ctrlMsg.documentId,
            sessionId,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        });

      // WELCOME, then whichever state-sync payload its own syncMode promises, then ALREADY_HAVE
      // (API Spec §3.6.1-§3.6.3, §3.6.4-§3.6.7, Phase 23) — all on CONTROL, in this order, so the
      // client always sees its own admission before the state it's being admitted to, and the
      // state it's being admitted to before being told which of its own queued edits already
      // landed.
      const syncMode = decideSyncMode(ctrlMsg, coordinator.currentSeq);
      queues.enqueue(
        "control",
        encodeControlFrame(buildWelcomeMessage(coordinator, sessionId, replicaId, syncMode, role)),
      );
      if (syncMode === SyncMode.SNAPSHOT) {
        queues.enqueue("control", encodeControlFrame(buildSnapshotMessage(coordinator)));
      } else if (syncMode === SyncMode.CATCHUP) {
        const { begin, chunks, end } = await buildCatchupMessages(
          coordinator,
          ctrlMsg.lastServerSeq,
        );
        queues.enqueue("control", encodeControlFrame(begin));
        for (const chunk of chunks) {
          queues.enqueue("control", encodeControlFrame(chunk));
        }
        queues.enqueue("control", encodeControlFrame(end));
      }
      // ALREADY_CURRENT: nothing to send for state sync — the client's own resident engine is
      // already caught up.

      const alreadyHave = await buildAlreadyHaveMessage(coordinator, ctrlMsg.unacked);
      queues.enqueue("control", encodeControlFrame(alreadyHave));

      // Phase 24, Test Plan RC-32: PERMISSION_CHANGED is sent AFTER the rest of the handshake
      // completes — RC-32's own assertion order lists "HELLO succeeds, CATCHUP delivered"
      // before "PERMISSION_CHANGED received." Only sent when a test-only override was actually
      // queued for THIS join (never for an ordinary, real connection, which always gets the
      // hardcoded EDITOR default and no notification at all).
      if (roleOverride !== null) {
        queues.enqueue(
          "control",
          encodeControlFrame({
            kind: "permissionChanged",
            role: roleOverride,
            // This test-only path has no real REST commit behind it (RC-32's own simulated
            // downgrade), so there is no real "document sequence at commit" to report — the
            // current seq at the moment of the join is the most honest value available.
            effectiveAtSeq: Number(coordinator.currentSeq),
          }),
        );
      }

      // Phase 31 (API Spec §3.8): "PRESENCE_ROSTER... sent once after sync completes" — sent as
      // the LAST step of this same handshake-completion sequence (after WELCOME/state-sync/
      // ALREADY_HAVE/PERMISSION_CHANGED), on the PRESENCE channel/queue itself, never CONTROL —
      // routing it through `queues.enqueue("presence", ...)` (via `sendRoster`) is what proves
      // this frame can never jump ahead of a still-draining OPS/CONTROL backlog (§3.3's own
      // three-queue priority order), the same guarantee M5-c's own test exists to prove for
      // PRESENCE_UPDATE.
      presenceRoom.sendRoster(sessionId);
    }

    /** PING/SYNC_COMPLETE/LEAVE — the only CONTROL types a client may legally send after handshake (§3.6). */
    function handleControlMessage(ctrlMsg: ControlMessage): void {
      if (!bound) {
        return;
      }
      const { coordinator, session, presenceRoom } = bound;
      switch (ctrlMsg.kind) {
        case "ping": {
          onPingReceived(session);
          const lastAckSeq = BigInt(ctrlMsg.lastAppliedSeq);
          coordinator.watermarks.set(session.replicaId, lastAckSeq);
          // Phase 21: keep sessions.last_ack_seq/last_seen_at current — this IS Definition
          // 7.1's watermark w(r), durably, not just in `coordinator.watermarks` (in-memory,
          // lost on restart). Fire-and-forget, same reasoning as the join-time heartbeat
          // above — must never add a DB round trip to the PING/PONG latency path.
          coordinator.operationStore
            .upsertSessionHeartbeat({
              sessionId,
              documentId: coordinator.documentId,
              userId: session.userId,
              replicaId: session.replicaId,
              displayName: session.displayName,
              lastAckSeq,
            })
            .catch((err: unknown) => {
              logger.error("gc.heartbeatFailed", {
                documentId: coordinator.documentId,
                sessionId,
                errorMessage: err instanceof Error ? err.message : String(err),
              });
            });
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
          // Phase 31, Test Plan PRES-05: "clean LEAVE removes presence immediately, without
          // waiting 8s" — removed right here, at the moment the advisory LEAVE frame itself
          // arrives, not deferred until the socket's own later 'close' event. `PresenceRoom.leave`
          // is idempotent, so the SECOND call this same session's eventual socket close makes
          // (below) is simply a no-op.
          presenceRoom.leave(sessionId, PresenceLeaveReason.CLEAN);
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
        } else if (channel === Channel.PRESENCE) {
          // Phase 31 (API Spec §3.8, §9.1) — routed through its OWN physical queue
          // (`queues.enqueue("presence", ...)`, Phase 8's three-queue design) end to end, never
          // through OPS or CONTROL, so a presence flood can never delay an operation (M5-b/c).
          let presenceMsg: PresenceMessage;
          try {
            presenceMsg = decodePresenceFrame(bytes, { direction: "clientOrigin" });
          } catch (err) {
            closeMalformed(err instanceof ProtocolDecodeError ? err.reason : "DECODE_ERROR");
            return;
          }
          if (presenceMsg.kind === "presenceUpdate") {
            bound.presenceRoom.handleUpdate(sessionId, presenceMsg);
          }
          // No other PresenceMessage kind can decode successfully with `direction:
          // "clientOrigin"` — decodePresenceFrame already rejects JOIN/LEAVE/ROSTER from a client
          // (server-only, §3.8) before returning.
        } else {
          closeMalformed(`unsupported channel ${channel}`);
        }
      })().catch((err: unknown) => {
        logger.error("ws.messageHandlerFailed", {
          sessionId,
          documentId: bound?.coordinator.documentId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });
    });

    ws.on("close", (code) => {
      queues.close();
      if (bound) {
        disarmPresenceStaleTimer(bound.session);
        // Phase 31, Test Plan PRES-04: an abrupt close with no prior clean LEAVE (e.g. a SIGKILLed
        // browser process) removes presence IMMEDIATELY here, with reason STALE — "stale" names
        // the SEMANTIC category (no clean goodbye happened), not literally "detected via the 8s
        // timer": the OS closing the TCP connection is itself a strong, immediate signal, well
        // within PRES-04's 10s bound. `PresenceRoom.leave` is idempotent, so this is a safe no-op
        // if an explicit LEAVE control frame already removed it moments earlier (PRES-05). The
        // 8-second `onPresenceStale` timer (heartbeat.ts) remains the ONLY removal path for the
        // separate case this close handler can never cover: a socket that stays open but stops
        // PINGing (e.g. a frozen tab, or a NAT silently dropping packets with no TCP close ever
        // propagating) — see documentCoordinator.ts's own `onPresenceStale` field doc comment.
        bound.presenceRoom.leave(sessionId, PresenceLeaveReason.STALE);
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
    presenceRooms,
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
