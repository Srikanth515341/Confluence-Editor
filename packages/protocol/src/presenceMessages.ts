import type { Identifier } from "@collab-editor/engine";
import type { SessionRole } from "./controlMessages.js";

/**
 * PRESENCE channel message types (API Spec §3.8), namespaced within
 * `Channel.PRESENCE` (messages.ts's channel byte `0x02`) the same way OPS/
 * CONTROL message types are namespaced within their own channels. Built as
 * of Phase 31 — before this phase, `Channel.PRESENCE` existed only as a
 * reserved enum value (Phase 8) with no message types or broadcast
 * mechanism defined on it anywhere in this codebase (Phase 30's own SEC-11j
 * account: "No presence message types or broadcast mechanism exist
 * anywhere in this codebase yet").
 */
export enum PresenceMessageType {
  PRESENCE_UPDATE = 0x01,
  PRESENCE_JOIN = 0x02,
  PRESENCE_LEAVE = 0x03,
  PRESENCE_ROSTER = 0x04,
}

/** PRESENCE_LEAVE's reason byte (API Spec §3.8) — values taken verbatim from the spec text. */
export enum PresenceLeaveReason {
  CLEAN = 0,
  STALE = 1,
}

/**
 * Cursor/selection state (API Spec §3.8, bidirectional on `Channel.PRESENCE`).
 *
 * Positions are IDENTIFIERS of the node immediately LEFT of the anchor/focus
 * — never visible-offset indices, for the identical reason operations never
 * carry indices (API Spec §1.4): an index is only meaningful against one
 * specific, momentary document state, while an identifier survives whatever
 * concurrent edits land anywhere else in the document before this update is
 * received. `null` means "at the very start of the document" (no node to
 * its left) — the same `null`-means-document-start convention
 * `InsertOperation.parent` already uses (Fugue port, see
 * `@collab-editor/engine`'s `FugueTree.decidePlacement`/`nodeAtVisible`,
 * which is exactly the mechanism a caller uses to RESOLVE a visible cursor
 * offset into this identifier: `nodeAtVisible(visibleIndex - 1)?.id ?? null`
 * — this project's CURRENT, Fugue-based node-identifier convention,
 * deliberately NOT the retired YATA-era `originLeft`/`originRight` pair a
 * stale reading of this phase's own brief would have suggested; see
 * CLAUDE.md's Phase 31 entry for the correction). `focus === anchor`
 * (compared by identifier, not object identity) means a collapsed caret;
 * `collapsed` is carried explicitly on the wire regardless, rather than
 * inferred, so a receiver never needs to know how identifier equality
 * works just to render a caret vs. a highlighted selection.
 *
 * `replicaId` is OMITTED from the wire entirely when a CLIENT sends this —
 * the server already knows who sent it from the connection itself — and is
 * always present when the SERVER rebroadcasts it to peers (with the real
 * sender's own replicaId filled in). See `presenceCodec.ts`'s own
 * `direction`-gated encode/decode for the exact wire mechanics; `replicaId`
 * is simply `0` on a `PresenceUpdateMessage` this client is about to SEND
 * (never read on that side).
 */
export interface PresenceUpdateMessage {
  readonly kind: "presenceUpdate";
  readonly replicaId: number;
  readonly anchor: Identifier | null;
  readonly focus: Identifier | null;
  /** True for a collapsed caret; false for a real (non-empty) selection range. */
  readonly collapsed: boolean;
}

/** S→C only: announces a new participant in this document's presence room (API Spec §3.8). */
export interface PresenceJoinMessage {
  readonly kind: "presenceJoin";
  readonly replicaId: number;
  readonly userId: string;
  readonly displayName: string;
  readonly role: SessionRole;
}

/**
 * S→C only: a participant's presence was removed (API Spec §3.8) — either a
 * clean LEAVE (the existing CONTROL-channel `LeaveMessage`, dual-purposed
 * as this signal — Phase 9 already built the "client announces a clean
 * departure" frame; Phase 31 is the first phase to also use it as
 * PRESENCE_LEAVE's own `reason: CLEAN` trigger) or the 8-second
 * presence-stale timeout (`heartbeat.ts`'s `PRESENCE_STALE_MS` — the SAME
 * timer established since Phase 9/21, kept structurally separate from GC's
 * unrelated 10-minute eviction window; see that file's own comment for the
 * conflation bug this project has already found and fixed once).
 */
export interface PresenceLeaveMessage {
  readonly kind: "presenceLeave";
  readonly replicaId: number;
  readonly reason: PresenceLeaveReason;
}

/** One entry in PRESENCE_ROSTER — the same identity fields PRESENCE_JOIN carries. */
export interface PresenceRosterEntry {
  readonly replicaId: number;
  readonly userId: string;
  readonly displayName: string;
  readonly role: SessionRole;
}

/**
 * S→C only: the full current roster (API Spec §3.8), sent once — right
 * after this session's own handshake completes (the same point WELCOME's
 * own participant list is built, `gateway.ts`'s `handleHandshake`) — NOT
 * re-sent on every later join/leave (those are incremental, via
 * PRESENCE_JOIN/PRESENCE_LEAVE above). This is purely the "catch a
 * newly-joined client up on who else is already present" snapshot,
 * mirroring WELCOME's own "includes the session currently being welcomed
 * itself" application-level call (Phase 9) for the identical reason:
 * treating it as a complete point-in-time snapshot is simpler and more
 * consistent than special-casing "everyone but me."
 */
export interface PresenceRosterMessage {
  readonly kind: "presenceRoster";
  readonly participants: readonly PresenceRosterEntry[];
}

export type PresenceMessage =
  | PresenceUpdateMessage
  | PresenceJoinMessage
  | PresenceLeaveMessage
  | PresenceRosterMessage;
