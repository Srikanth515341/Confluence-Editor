import type { Identifier, Operation } from "@collab-editor/engine";

/**
 * CONTROL channel message types (API Spec §3.6), namespaced within the
 * CONTROL channel (§3.2's `channel` byte = 0x03, Phase 8's `Channel.CONTROL`).
 * Numeric values are taken verbatim from the spec text. CATCHUP_BEGIN/
 * CATCHUP_CHUNK/CATCHUP_END/ALREADY_HAVE (reconnection, API Spec
 * §3.6.4-§3.6.8) are implemented as of Phase 23. PERMISSION_CHANGED is
 * implemented as of Phase 24 (RC-32, API Spec §5.4) — a minimal wire
 * message (just the new role), NOT the full owner/editor/viewer
 * permission/authorization SYSTEM (who may change whose role, and why),
 * which remains Phase 26-30's job. See documentCoordinator.ts's
 * `testOnlyQueueRoleOverride` for how a role change is actually driven
 * this phase, in the explicit absence of that system.
 */
export enum ControlMessageType {
  HELLO = 0x01,
  WELCOME = 0x02,
  SNAPSHOT = 0x03,
  CATCHUP_BEGIN = 0x04,
  CATCHUP_CHUNK = 0x05,
  CATCHUP_END = 0x06,
  ALREADY_HAVE = 0x07,
  SYNC_COMPLETE = 0x08,
  PERMISSION_CHANGED = 0x09,
  ERROR = 0x0a,
  PING = 0x0b,
  PONG = 0x0c,
  LEAVE = 0x0d,
  GOODBYE = 0x0e,
}

/** Message types this phase implements payload encode/decode for — as of Phase 24, every CONTROL type the spec text names is implemented; none remain reserved-but-unimplemented. */
const IMPLEMENTED_CONTROL_TYPES: ReadonlySet<ControlMessageType> = new Set([
  ControlMessageType.HELLO,
  ControlMessageType.WELCOME,
  ControlMessageType.SNAPSHOT,
  ControlMessageType.CATCHUP_BEGIN,
  ControlMessageType.CATCHUP_CHUNK,
  ControlMessageType.CATCHUP_END,
  ControlMessageType.ALREADY_HAVE,
  ControlMessageType.SYNC_COMPLETE,
  ControlMessageType.PERMISSION_CHANGED,
  ControlMessageType.ERROR,
  ControlMessageType.PING,
  ControlMessageType.PONG,
  ControlMessageType.LEAVE,
  ControlMessageType.GOODBYE,
]);

export function isImplementedControlType(type: number): type is ControlMessageType {
  return IMPLEMENTED_CONTROL_TYPES.has(type as ControlMessageType);
}

/** HELLO's capability bitfield (§3.6.1). */
export const CLIENT_CAP_ACCEPTS_OP_INSERT_RUN = 0x01;
export const CLIENT_CAP_ACCEPTS_STRUCTURE_SNAPSHOT = 0x02;
/**
 * Phase 23 addition: set when this client still holds a live, resident
 * `Engine` from before the reconnect (a socket drop that never nulled
 * `SyncClient.engine` — Phase 14's "last known state" design) as opposed to
 * a brand-new page load with nothing but durably-remembered metadata (Phase
 * 22's `meta.lastServerSeq`, restored with no actual document content
 * behind it). The server must never offer `SyncMode.CATCHUP` — a DELTA the
 * client is expected to apply on top of its own existing structure — to a
 * client that has no existing structure to apply it to; doing so would
 * silently lose everything before `lastServerSeq`. This bit is the only
 * signal that distinguishes those two cases from the server's point of
 * view (`hello.lastServerSeq` alone cannot: both report a nonzero value).
 * See `decideSyncMode` (packages/server/src/handshake.ts).
 */
export const CLIENT_CAP_HAS_RESIDENT_ENGINE = 0x04;

/** The first frame after the upgrade (§3.6.1, C→S). */
export interface HelloMessage {
  readonly kind: "hello";
  readonly documentId: string;
  /**
   * API Spec §4.10/§1.5 (Phase 29) — UTF-8 bytes of the opaque `rt_...` ticket string returned by
   * `POST /v1/documents/{id}/rt-ticket`. REAL, validated as of Phase 29: single-use, scoped to
   * one document and one user, valid 30s. A server configured with no `auth` deps (most of this
   * project's own pre-Phase-29 tests) skips validation entirely, preserving the old "accepted,
   * never checked" behavior — see `gateway.ts`'s own handshake handler for the exact gating.
   */
  readonly ticket: Uint8Array;
  /**
   * 0 for a client's very first-ever connection. As of Phase 22, a
   * reconnecting/restarting client with durably-persisted queue state
   * (API Spec §7.9's `meta.lastServerSeq`) reports the last value it
   * confirmed, read back BEFORE this HELLO is sent. As of Phase 23 the
   * server ACTS on this: together with `clientCapabilities`'s
   * `CLIENT_CAP_HAS_RESIDENT_ENGINE` bit, it decides WELCOME's `syncMode`
   * — SNAPSHOT, CATCHUP (a delta over `(lastServerSeq, currentSeq]`), or
   * ALREADY_CURRENT (`lastServerSeq === currentSeq`, nothing missed). See
   * `decideSyncMode` (packages/server/src/handshake.ts).
   */
  readonly lastServerSeq: number;
  /**
   * Origin stamps of every operation this client has queued but not yet
   * had acknowledged — always empty before Phase 22. A client restored
   * from a durable queue (a prior page load that crashed or closed
   * mid-edit) reports the full restored set here, per API Spec §7.9 ("on
   * document open, read before connecting so HELLO.unacked is complete").
   * As of Phase 23 the server ACTS on this too: it checks which of these
   * stamps are already durably committed (they reached the server before
   * the disconnect, just never got acked back) and reports that subset
   * via ALREADY_HAVE, so the client only needs to reconcile/resend the
   * genuine remainder — see
   * `packages/client/src/sync/reconcileOfflineQueue.ts` and
   * `SyncClient.handleAlreadyHave`. There is still no session/replica
   * resumption (Phase 8/9's deliberate design) — a stamp the server
   * already has is acknowledged locally, never literally resent under
   * its original identity.
   */
  readonly unacked: readonly Identifier[];
  /** Bitfield of `CLIENT_CAP_*` constants above. */
  readonly clientCapabilities: number;
}

/** §3.6.2's role byte. This phase hardcodes every session to EDITOR — real roles/auth are Phase 26-29. */
export enum SessionRole {
  VIEWER = 0,
  EDITOR = 1,
  OWNER = 2,
}

/**
 * §3.6.2's syncMode byte — decided per-connection by `decideSyncMode`
 * (packages/server/src/handshake.ts, Phase 23): SNAPSHOT for a client with
 * no resident engine (a fresh join, or a fresh page load restoring only
 * durable metadata) or one whose `lastServerSeq` the server can no longer
 * make sense of; CATCHUP for a client with a resident engine trailing
 * behind `currentSeq`, sent as CATCHUP_BEGIN/CATCHUP_CHUNK.../CATCHUP_END
 * instead of a full SNAPSHOT; ALREADY_CURRENT when `lastServerSeq` already
 * equals `currentSeq` (nothing to catch up on state-sync-wise — ALREADY_HAVE
 * for the client's own unacked stamps still follows either way).
 */
export enum SyncMode {
  SNAPSHOT = 0,
  CATCHUP = 1,
  ALREADY_CURRENT = 2,
}

/** One entry in WELCOME's participant list (§3.6.2). */
export interface ParticipantInfo {
  readonly replicaId: number;
  /** Placeholder UUID this phase — real users don't exist until Phase 26. */
  readonly userId: string;
  readonly displayName: string;
}

/** Admits a session to a document (§3.6.2, S→C). */
export interface WelcomeMessage {
  readonly kind: "welcome";
  readonly sessionId: string;
  /** THE OBSEQ replica id for this session (API Spec §3.6.2, §6.1). */
  readonly replicaId: number;
  readonly role: SessionRole;
  readonly serverSeq: number;
  readonly syncMode: SyncMode;
  readonly participants: readonly ParticipantInfo[];
}

/**
 * Notifies a session its ROLE has changed (§3.6's "Other CONTROL message types" table; API Spec
 * §3.6.9, §5.4; Phase 24 built the minimal shape, Phase 29 makes it real). `role: null` means
 * access was revoked ENTIRELY (no `document_permissions` row at all — DELETE
 * .../permissions/{userId}) — there is no `SessionRole` value for "no access," so `null` is the
 * explicit signal rather than overloading VIEWER (a session that lost ALL access is not the same
 * as one that was merely downgraded TO viewer, even though both are enforced identically
 * server-side: `session.role` itself is set to VIEWER either way, since that's what actually
 * blocks every mutating operation — `role: null` on the WIRE exists purely so the CLIENT can
 * distinguish the two cases for its own UI/export messaging, per FR-PM-8).
 *
 * `effectiveAtSeq` (Phase 29, API Spec §4.7/§4.8's own field, now also echoed here): the document
 * sequence at the moment this permission change committed — operations at or before it were
 * authorized under the PREVIOUS role and are kept; operations after are subject to the new one.
 *
 * Sent AFTER the rest of the handshake (WELCOME/SNAPSHOT-or-CATCHUP/ALREADY_HAVE) completes when
 * triggered during a fresh join (Phase 24's RC-32 scenario, still driven by
 * `DocumentCoordinator.testOnlyQueueRoleOverride` there); pushed directly, at any time, to an
 * ALREADY-OPEN session as of Phase 29 (`httpApp.ts`'s `pushPermissionChanged`, driven by a REAL
 * PUT/DELETE/POST-owner commit, API Spec §4.7/§4.8's own "publishes an authorization invalidation
 * and pushes PERMISSION_CHANGED to every open session for that user on that document").
 */
export interface PermissionChangedMessage {
  readonly kind: "permissionChanged";
  readonly role: SessionRole | null;
  readonly effectiveAtSeq: number;
}

/**
 * `ErrorMessage.code` values this project actually assigns meaning to, first used as of Phase 29
 * (API Spec §4.10's own named `ERROR{invalid_ticket, fatal: 1}`). The spec text available to this
 * project has never given `code` a literal numeric table (see `ErrorMessage`'s own doc comment,
 * unchanged since Phase 9) — these two values are this phase's own necessary, disclosed
 * definition, the same "a later phase that needs specific error codes should define them, not
 * invent them under an earlier phase's schedule pressure" precedent Phase 9 itself named. A later
 * phase needing a THIRD code should extend this enum, not invent a separate one.
 */
export enum ErrorCode {
  /** API Spec §4.10: a ticket that is missing, unknown, already used, expired, or scoped to a different document than the one claimed in HELLO. Deliberately ONE code for all of these — see gateway.ts's own comment for why distinguishing them on the wire would be a real, if narrow, oracle. */
  INVALID_TICKET = 1,
  /** Phase 29, Test Plan SEC-11e: this session's own authorization can no longer be confirmed (e.g. the connecting user's `document_permissions` row is gone) on an already-admitted, long-lived socket — the SAME condition PERMISSION_CHANGED{role: null} reports when caught by an explicit push; this code covers the case where nothing pushed it, and the decision cache's own ≤2s re-check (SEC-05/06) is what surfaced it instead. */
  SESSION_EXPIRED = 2,
}

/** §3.6.3's form byte. */
export enum SnapshotForm {
  PLAIN_TEXT = 0,
  STRUCTURE = 1,
}

/**
 * Document state as of `seq` (§3.6.3, S→C, sent when `syncMode === SNAPSHOT`).
 * `body`'s byte layout depends on `form` — see snapshotBody.ts for the
 * structure-form (`form: STRUCTURE`) codec; plain-text form is just UTF-8
 * bytes of the document text. `body` is kept as raw bytes at this level
 * (not a parsed union) because the two forms have nothing in common beyond
 * "some bytes" — parsing is the caller's job once `form` is known.
 */
export interface SnapshotMessage {
  readonly kind: "snapshot";
  readonly seq: number;
  readonly form: SnapshotForm;
  readonly body: Uint8Array;
}

/**
 * Announces the start of a CATCHUP delta sync (§3.6.4, S→C) — sent instead
 * of SNAPSHOT when WELCOME's `syncMode === CATCHUP`. `fromSeq` is the
 * client's own reported `lastServerSeq` (exclusive — the delta covers
 * `(fromSeq, toSeq]`); `toSeq` is `coordinator.currentSeq` AT THE MOMENT the
 * delta range was computed (may already be behind `coordinator.currentSeq`
 * by the time streaming finishes, if concurrent operations commit
 * meanwhile — those simply arrive afterward via the normal live OPS
 * broadcast, same as for any already-joined session). `totalOps` is the
 * total operation count the delta will carry across every following
 * CATCHUP_CHUNK, for client-side progress/sanity purposes only.
 */
export interface CatchupBeginMessage {
  readonly kind: "catchupBegin";
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly totalOps: number;
}

/**
 * One chunk of a CATCHUP delta (§3.6.5, S→C) — mandatory chunking, ≤256
 * operations or ≤64KB encoded per chunk (Scope-IN). `throughSeq` is the
 * seq of this chunk's OWN last operation — a safe checkpoint value (seq
 * numbering can legitimately skip a "spent but rowless" value from a
 * historically-suppressed duplicate, API Spec §6.3 step 8's own doc
 * comment, so op count alone can't reconstruct it) — but see
 * `SyncClient.handleCatchupChunk`'s own comment for why the CORRECT client
 * never advances its tracked `lastServerSeq` from this field; it exists
 * on the wire specifically so Test Plan RC-33e's deliberately-mutated
 * client variant has a well-defined (wrong) value to advance from instead.
 */
export interface CatchupChunkMessage {
  readonly kind: "catchupChunk";
  readonly throughSeq: number;
  readonly ops: readonly Operation[];
}

/**
 * Ends a CATCHUP delta sync (§3.6.6, S→C). `toSeq` matches
 * CatchupBeginMessage's own `toSeq` — the ONLY point at which a correct
 * client may advance its tracked `lastServerSeq` (API Spec §11.5; see the
 * required comment at `SyncClient.handleCatchupEnd`). `totalOps` echoes
 * CATCHUP_BEGIN's own count, for a client-side sanity cross-check against
 * how many operations actually arrived across all chunks.
 */
export interface CatchupEndMessage {
  readonly kind: "catchupEnd";
  readonly toSeq: number;
  readonly totalOps: number;
}

/**
 * The subset of the client's own HELLO.unacked stamps the server already
 * has durably committed (§3.6.7, S→C) — always sent, after whichever
 * state-sync payload (SNAPSHOT, CATCHUP, or nothing for ALREADY_CURRENT)
 * completes, even when `alreadyHave` is empty. A stamp listed here reached
 * the server before the disconnect but never got its OP_ACK back (the
 * exact race RC-33d/RC-28 exercise) — the client acknowledges it locally
 * rather than reconciling/resending it (which, since every reconnect gets
 * a brand-new replica id — Phase 8/9's deliberate design, reaffirmed Phase
 * 22 — would otherwise duplicate content already present under the
 * original stamp). Every OTHER unacked stamp is the genuine remainder the
 * client reconciles and sends (Scope-IN: "Client resends only the
 * remainder").
 */
export interface AlreadyHaveMessage {
  readonly kind: "alreadyHave";
  readonly alreadyHave: readonly Identifier[];
}

/**
 * Client's post-handshake acknowledgment (§3.6.8, C→S). `resentCount` is
 * always 0 through Phase 21. As of Phase 22, a client with a non-empty
 * durable/in-memory unacked queue reports how many operations it just
 * RE-MINTED (not literally resent — a fresh SNAPSHOT always carries a new
 * replica id, so the original identities can never be resent as-is; see
 * `packages/client/src/sync/reconcileOfflineQueue.ts`) and sent as part of
 * this same handshake. Server-side CATCHUP/ALREADY_HAVE (§3.6.4-§3.6.7,
 * Phase 23) is a different mechanism — a delta sync FROM the server — and
 * remains unbuilt; this field's Phase 22 meaning is purely "how many
 * client-originated ops accompanied this SYNC_COMPLETE."
 */
export interface SyncCompleteMessage {
  readonly kind: "syncComplete";
  readonly lastServerSeq: number;
  readonly resentCount: number;
}

/** §3.6.11, C→S. Sent by the client every 3 seconds, unconditionally, on CONTROL. */
export interface PingMessage {
  readonly kind: "ping";
  readonly clientTimeMs: number;
  readonly lastAppliedSeq: number;
}

/** §3.6.11, S→C — the server's reply to PING. */
export interface PongMessage {
  readonly kind: "pong";
  readonly clientTimeMs: number;
  readonly serverSeq: number;
}

/** C→S, advisory: a client announcing a clean departure. */
export interface LeaveMessage {
  readonly kind: "leave";
  readonly lastAppliedSeq: number;
}

/** GOODBYE's reason byte (§3.6's "Other CONTROL message types" table) — values taken verbatim. */
export enum GoodbyeReason {
  SHUTDOWN = 0,
  EVICTED = 1,
  PERMISSION_REVOKED = 2,
  PROTOCOL_VERSION_RETIRED = 3,
}

/** S→C: the server ending a session. */
export interface GoodbyeMessage {
  readonly kind: "goodbye";
  readonly reason: GoodbyeReason;
  readonly retryAfterMs: number;
}

/**
 * S→C. `code`'s specific numeric meanings are not defined by the spec text
 * available to this phase — the wire layout (`uint8 code, uint8 fatal,
 * varint messageLength, bytes message`) is implemented and round-trip
 * tested, but no code in this phase constructs one: doing so would mean
 * inventing `code` semantics the spec doesn't define, and nothing in this
 * phase's required behavior needs to send one (protocol violations are
 * handled at the WebSocket close-code level instead, matching Phase 8's
 * existing pattern). A later phase that needs specific error codes should
 * define them against the real spec text, not values guessed here.
 */
export interface ErrorMessage {
  readonly kind: "error";
  readonly code: number;
  readonly fatal: boolean;
  readonly message: string;
}

export type ControlMessage =
  | HelloMessage
  | WelcomeMessage
  | SnapshotMessage
  | CatchupBeginMessage
  | CatchupChunkMessage
  | CatchupEndMessage
  | AlreadyHaveMessage
  | SyncCompleteMessage
  | PermissionChangedMessage
  | PingMessage
  | PongMessage
  | LeaveMessage
  | GoodbyeMessage
  | ErrorMessage;
