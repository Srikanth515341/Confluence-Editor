import type { Identifier } from "@collab-editor/engine";

/**
 * CONTROL channel message types (API Spec §3.6), namespaced within the
 * CONTROL channel (§3.2's `channel` byte = 0x03, Phase 8's `Channel.CONTROL`).
 * Numeric values are taken verbatim from the spec text. CATCHUP_BEGIN/
 * CATCHUP_CHUNK/CATCHUP_END/ALREADY_HAVE (reconnection, Phase 23) and
 * PERMISSION_CHANGED (Phases 26-29) are reserved here — the numeric slot
 * exists so a future frame carrying one of these types is recognized as
 * "a real, still-unimplemented type" rather than "unknown garbage" — but
 * this phase implements none of their payload logic, per the phase
 * brief's explicit instruction.
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

/** Message types this phase implements payload encode/decode for. The rest of {@link ControlMessageType} are reserved-but-unimplemented (see its doc comment). */
const IMPLEMENTED_CONTROL_TYPES: ReadonlySet<ControlMessageType> = new Set([
  ControlMessageType.HELLO,
  ControlMessageType.WELCOME,
  ControlMessageType.SNAPSHOT,
  ControlMessageType.SYNC_COMPLETE,
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

/** The first frame after the upgrade (§3.6.1, C→S). */
export interface HelloMessage {
  readonly kind: "hello";
  readonly documentId: string;
  /** Opaque bytes from a later auth phase (Phase 29) — accepted, never validated, this phase. */
  readonly ticket: Uint8Array;
  /** 0 for a fresh connection — this phase only handles fresh connections (reconnection/CATCHUP is Phase 23). */
  readonly lastServerSeq: number;
  /** Origin stamps only. Always empty this phase (fresh connections only). */
  readonly unacked: readonly Identifier[];
  readonly clientCapabilities: number;
}

/** §3.6.2's role byte. This phase hardcodes every session to EDITOR — real roles/auth are Phase 26-29. */
export enum SessionRole {
  VIEWER = 0,
  EDITOR = 1,
  OWNER = 2,
}

/** §3.6.2's syncMode byte. This phase only ever sends SNAPSHOT — CATCHUP is Phase 23; ALREADY_CURRENT never applies without reconnection support. */
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

/** Client's post-handshake acknowledgment (§3.6.8, C→S). `resentCount` is always 0 for a fresh connection this phase — resend/reconciliation is Phase 23. */
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
  | SyncCompleteMessage
  | PingMessage
  | PongMessage
  | LeaveMessage
  | GoodbyeMessage
  | ErrorMessage;
