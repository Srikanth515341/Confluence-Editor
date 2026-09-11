// Phase 31 — the PRESENCE room (API/Protocol/Data Spec §3.8, §9.1/§9.3-§9.5; RFC §9; PRD
// FR-PR-1/4/5/8). Deliberately has ZERO import from `@collab-editor/engine` or from any
// persistence module (`./db/*.js`, `./writePath.js`, `./operationStore` types, etc.) —
// "structural isolation: the presence code has no import from the engine or persistence layer,"
// per this phase's own Scope-IN. `PresenceRoom` knows nothing about `Engine`, `DocumentCoordinator`,
// or Postgres; it operates purely on already-authorized identity data (supplied by `gateway.ts`,
// which already knows a session's role/userId/displayName from the SAME authorization check that
// admits it to the document's `DocumentCoordinator`) and plain send callbacks. This mirrors
// `sendQueues.ts`'s own "deliberately payload-agnostic" discipline, one layer up: this module
// never touches operations, snapshots, or the database, by construction, not by convention.
//
// Presence data is NEVER written to operations, NEVER included in snapshots, NEVER passed to the
// engine (Scope-IN) — trivially true here, since this file has no way to reach any of the three.

import {
  encodePresenceFrame,
  PresenceLeaveReason,
  type PresenceRosterEntry,
  type PresenceUpdateMessage,
  type SessionRole,
} from "@collab-editor/protocol";
import { InMemoryRateLimiter } from "./rateLimiter.js";

/** Server-side ceiling (§9.3-9.5 enforcement point 3): "a server-side ceiling that DROPS excess, never queues." 20/s per session, matching the client's own hard cap (§9.3 point 2) — this is the backstop for a client that ignores or bypasses its own two enforcement points, not the primary mechanism. */
const PRESENCE_SERVER_RULE = { max: 20, windowMs: 1000 };

export interface PresenceParticipant {
  readonly sessionId: string;
  readonly replicaId: number;
  readonly userId: string;
  readonly displayName: string;
  readonly role: SessionRole;
}

/**
 * One document's PRESENCE room — participant roster plus rebroadcast/rate-limiting for
 * PRESENCE_UPDATE. Purely in-memory and ephemeral: nothing here is ever durably persisted, and a
 * room's own lifetime is managed by whoever constructs it (`gateway.ts`, one per open document,
 * mirroring — but never importing — `DocumentCoordinator`'s own one-per-document shape).
 */
export class PresenceRoom {
  private readonly participants = new Map<string, PresenceParticipant>();
  private readonly senders = new Map<string, (frame: Uint8Array) => void>();
  private readonly rateLimiter = new InMemoryRateLimiter();

  /** Current roster size — diagnostic/test only. */
  get size(): number {
    return this.participants.size;
  }

  /**
   * Admits a session to this room: registers its send callback, broadcasts PRESENCE_JOIN to every
   * OTHER already-present participant (never to `participant` itself — a session never receives
   * its own JOIN), then records it in the roster. Gated by the SAME authorization the caller
   * already performed to admit this session to the document's `DocumentCoordinator` in the first
   * place (Scope-IN: "presence room membership gated by the Phase 28 authorization layer") — this
   * method itself performs no authorization check of its own, since it has no way to (no engine,
   * no persistence, no auth layer imported here).
   */
  join(participant: PresenceParticipant, send: (frame: Uint8Array) => void): void {
    const joinFrame = encodePresenceFrame({
      kind: "presenceJoin",
      replicaId: participant.replicaId,
      userId: participant.userId,
      displayName: participant.displayName,
      role: participant.role,
    });
    this.broadcastExcept(participant.sessionId, joinFrame);
    this.participants.set(participant.sessionId, participant);
    this.senders.set(participant.sessionId, send);
  }

  /**
   * Sends the full current roster to ONE session (API Spec §3.8: "sent once after sync
   * completes") — includes the roster's own newly-joined member (the same "a complete
   * point-in-time snapshot, not everyone-but-me" call `WelcomeMessage`'s own participant list
   * already makes, Phase 9). A no-op if `sessionId` isn't currently registered (e.g. the socket
   * already closed before this was called).
   */
  sendRoster(sessionId: string): void {
    const send = this.senders.get(sessionId);
    if (!send) return;
    const participants: PresenceRosterEntry[] = Array.from(this.participants.values(), (p) => ({
      replicaId: p.replicaId,
      userId: p.userId,
      displayName: p.displayName,
      role: p.role,
    }));
    send(encodePresenceFrame({ kind: "presenceRoster", participants }));
  }

  /**
   * Removes a session from this room and broadcasts PRESENCE_LEAVE to every remaining
   * participant. Idempotent — a no-op if the session isn't currently in the roster, which is the
   * normal outcome when this is called a SECOND time for the same session (e.g. an explicit
   * clean LEAVE control frame already removed it before the socket's own 'close' event fires, or
   * the 8-second stale timer already removed it before a late close event arrives) — see
   * `gateway.ts`'s own three call sites for the full reasoning on why idempotence here is what
   * makes those three independent triggers safe to all call this unconditionally.
   */
  leave(sessionId: string, reason: PresenceLeaveReason): void {
    const participant = this.participants.get(sessionId);
    if (!participant) return;
    this.participants.delete(sessionId);
    this.senders.delete(sessionId);
    this.broadcastExcept(
      sessionId,
      encodePresenceFrame({ kind: "presenceLeave", replicaId: participant.replicaId, reason }),
    );
  }

  /**
   * Relays a client's PRESENCE_UPDATE to every other participant, with the real `replicaId`
   * filled in (the client's own frame never carries one — API Spec §3.8). Applies the server-side
   * ceiling (enforcement point 3, §9.3-9.5): an update beyond 20/s for this ONE session is
   * silently DROPPED, never queued — the caller (`gateway.ts`) does not even need to know this
   * happened, since a dropped presence update is never an error condition (Scope-IN: presence
   * "structurally incapable of delaying operations or affecting document state" — dropping one is
   * the intended behavior under load, not a fault). A no-op (also silent) if `sessionId` isn't
   * currently a room member (e.g. its own JOIN raced behind an update somehow) — never throws.
   */
  handleUpdate(sessionId: string, msg: PresenceUpdateMessage, nowMs: number = Date.now()): void {
    const participant = this.participants.get(sessionId);
    if (!participant) return;
    if (!this.rateLimiter.consume(`presence:${sessionId}`, PRESENCE_SERVER_RULE, nowMs)) {
      return; // dropped, not queued (§9.3-9.5 enforcement point 3)
    }
    const frame = encodePresenceFrame(
      { ...msg, replicaId: participant.replicaId },
      { direction: "serverOrigin" },
    );
    this.broadcastExcept(sessionId, frame);
  }

  private broadcastExcept(exceptSessionId: string, frame: Uint8Array): void {
    for (const [sessionId, send] of this.senders) {
      if (sessionId !== exceptSessionId) {
        send(frame);
      }
    }
  }
}

export { PresenceLeaveReason };
