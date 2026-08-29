import type { Identifier } from "@collab-editor/engine";

/**
 * Wire framing (API/Protocol/Data Spec §3.2): every frame, in both
 * directions, begins with a THREE-byte header — protocolVersion, channel,
 * messageType — and the payload starts immediately at offset 3. There is
 * no frame-level length prefix, no correlation id, and (deliberately, after
 * this file's Phase 7 correction) no frame-level flags byte — per-message
 * flags (e.g. OP_INSERT's origin-presence bits) live INSIDE each message's
 * own payload, never at the envelope level.
 */
export const PROTOCOL_VERSION = 0x01;

/** §3.2's channel byte. A frame with any other value MUST be rejected. */
export enum Channel {
  OPS = 0x01,
  PRESENCE = 0x02,
  CONTROL = 0x03,
}

/** OPS channel message types, namespaced within the channel (§3.5). */
export enum OpsMessageType {
  OP_INSERT = 0x01,
  OP_INSERT_RUN = 0x02,
  OP_DELETE = 0x03,
  OP_DELETE_BATCH = 0x04,
  OP_UNDELETE = 0x05,
  OP_ACK = 0x10,
  OP_REJECT = 0x11,
}

/**
 * OP_REJECT reason codes (§3.5.8). Exactly 7 codes, values and names taken
 * verbatim from the spec table.
 *
 * PRD FR-CE-7 / spec §3.5.8's own closing line: "There is no conflict
 * reason code, and there never will be." OBSEQ's convergence guarantee
 * means two operations never "conflict" in the merge sense — every code
 * here is a protocol/session-level rejection (auth, malformed input, rate
 * limiting, document state), never a merge outcome. No conflict code may
 * ever be added to this enum.
 */
export enum RejectReason {
  PERMISSION_DENIED = 0x01,
  SESSION_EXPIRED = 0x02,
  IDENTITY_MISMATCH = 0x03,
  MALFORMED = 0x04,
  RATE_LIMITED = 0x05,
  OFFLINE_WINDOW_EXCEEDED = 0x06,
  DOCUMENT_LOCKED = 0x07,
}

/**
 * The identity decision (API Spec §1.4): there is no separate operation
 * UUID anywhere in this protocol. Engine Spec I1 establishes that
 * (counter, replica) is globally unique across all operations in a
 * document, and this protocol uses that pair DIRECTLY as the operation
 * identity — the origin stamp, written ⟨c, r⟩ — rather than minting a
 * redundant UUID that could fall out of sync with the identity the engine
 * already has.
 */
export interface OpInsertMessage {
  readonly kind: "opInsert";
  /** 0 from client; assigned by the server (§3.5.1). */
  readonly seq: number;
  readonly id: Identifier;
  readonly originLeft: Identifier | null;
  readonly originRight: Identifier | null;
  readonly bind: boolean;
  readonly value: number;
}

/**
 * A run of `values.length` (n ≥ 2) consecutive-counter inserts from one
 * replica (§3.5.2) — the wire-efficient encoding of ordinary sequential
 * typing, which mint()s consecutive counters by construction (Engine Spec
 * §3.4). `bind` applies to the WHOLE run, not per character — the spec
 * models a run as one grapheme-cluster-uniform burst, not a mix. On the
 * wire, `values` is carried as the run's scalars re-encoded as UTF-8 text
 * (§3.5.2's `bytes utf8`), not as a list of individual varints; see
 * codec.ts for that transcoding. `originLeft`/`originRight` are the FIRST
 * node's origins — see expand.ts's `expandInsertRun` for the exact
 * per-node derivation this implies for nodes 1..n-1.
 */
export interface OpInsertRunMessage {
  readonly kind: "opInsertRun";
  readonly seq: number;
  readonly firstId: Identifier;
  readonly originLeft: Identifier | null;
  readonly originRight: Identifier | null;
  readonly bind: boolean;
  readonly values: readonly number[];
}

export interface OpDeleteMessage {
  readonly kind: "opDelete";
  readonly seq: number;
  /** The deleting operation's own identity — encoded on the wire as separate `at`/`by` varints (§3.5.3), not as a `stamp`, but the same (counter, replica) pair. */
  readonly id: Identifier;
  readonly target: Identifier;
}

/**
 * A batch of deletes from one replica (`by`) whose OWN ids start at
 * `atFirst` and are consecutive counters (n ≥ 2, §3.5.4) — exactly what
 * `Engine.localDelete()` mints (Engine Spec §4.6/API Spec §1.4). `targets`
 * are listed explicitly, one per delete, because the visible range removed
 * need not correspond to contiguous underlying node identifiers.
 */
export interface OpDeleteBatchMessage {
  readonly kind: "opDeleteBatch";
  readonly seq: number;
  readonly by: number;
  readonly atFirst: number;
  readonly targets: readonly Identifier[];
}

export interface OpUndeleteMessage {
  readonly kind: "opUndelete";
  readonly seq: number;
  readonly id: Identifier;
  readonly target: Identifier;
}

/** One acknowledged operation within an OP_ACK batch (§3.5.7). */
export interface AckEntry {
  readonly ackSeq: number;
  readonly ackedId: Identifier;
}

/**
 * Acknowledges a batch of operations in one frame (§3.5.7, server→client
 * only — carries no `seq` of its own, unlike the five bidirectional
 * message types above).
 */
export interface OpAckMessage {
  readonly kind: "opAck";
  readonly acks: readonly AckEntry[];
}

/** One rejected operation within an OP_REJECT batch (§3.5.8). */
export interface RejectEntry {
  readonly rejectedId: Identifier;
  readonly reason: RejectReason;
}

/**
 * Rejects a batch of operations in one frame (§3.5.8, server→client only —
 * no `seq` of its own). `detail` is a single human-readable string shared
 * by the whole frame, UTF-8, never parsed by the client — empty string
 * means absent (wire `detailLength: 0`).
 */
export interface OpRejectMessage {
  readonly kind: "opReject";
  readonly rejects: readonly RejectEntry[];
  readonly detail: string;
}

export type OpsMessage =
  | OpInsertMessage
  | OpInsertRunMessage
  | OpDeleteMessage
  | OpDeleteBatchMessage
  | OpUndeleteMessage
  | OpAckMessage
  | OpRejectMessage;
