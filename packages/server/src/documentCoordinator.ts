import { Engine } from "@collab-editor/engine";
import { SessionRole, type ParticipantInfo } from "@collab-editor/protocol";
import type { ConnectionSendQueues } from "./sendQueues.js";

/**
 * Replica id 0 is reserved for the server and is never handed to a session
 * (API Spec §6.1). The server mints identifiers only for restore-generated
 * operations (a later phase); for everything else — all of Phase 8 — it
 * applies operations, never originates them.
 */
export const SERVER_REPLICA_ID = 0;

/**
 * Per-connection state, populated once a HELLO/WELCOME handshake completes
 * (Phase 9, API Spec §3.6.1-3.6.2). `lastPingAt`/`presenceStale`/
 * `staleTimer` are heartbeat.ts's liveness bookkeeping (§3.6.11) — mutated
 * there, not read for any other purpose.
 */
export interface CoordinatorSession {
  readonly sessionId: string;
  readonly replicaId: number;
  readonly queues: ConnectionSendQueues;
  /** Hardcoded EDITOR for every session this phase — real roles/auth are Phase 26-29 (API Spec §3.6.2). */
  readonly role: SessionRole;
  /** Placeholder UUID this phase — real users don't exist until Phase 26. */
  readonly userId: string;
  readonly displayName: string;
  /** Epoch ms of the last PING received. Updated by heartbeat.ts's `onPingReceived`. */
  lastPingAt: number;
  /** True once 8s have passed with no PING (§3.6.11) — logged/marked only, since no presence system exists yet. */
  presenceStale: boolean;
  /** The pending presence-stale timeout, so a new PING can cancel and restart it. `undefined` before the first PING/join. */
  staleTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * One Document Coordinator per open document (RFC §5), holding the
 * server-side engine instance every connected session's operations flow
 * through. Fields exactly match API Spec §6.1's list; `watermarks` is now
 * live (updated from each session's PING, §3.6.11 — mirrors
 * `sessions.last_ack_seq`); `opsSinceSnap`/`lastSnapAt` remain unused
 * scaffolding for Phase 17.
 */
export class DocumentCoordinator {
  readonly documentId: string;
  readonly engine = new Engine(SERVER_REPLICA_ID);

  /** API Spec §6.1: `currentSeq: bigint`. Assigned once per ingested OPS frame — see gateway.ts's ingest path for why frame-granularity, not per-underlying-operation. */
  currentSeq = 0n;

  /** Per-replica last-acknowledged seq, updated on every PING's `lastAppliedSeq` (§3.6.11: "server updates the session's ... last-acked-seq on receipt"). Mirrors `sessions.last_ack_seq` — real persistence is Phase 16. */
  readonly watermarks = new Map<number, bigint>();
  /** Scaffolding for Phase 17 (snapshotting). Unused this phase. */
  opsSinceSnap = 0;
  /** Scaffolding for Phase 17 (snapshotting). Unused this phase. */
  lastSnapAt: Date | null = null;

  private readonly sessions = new Map<string, CoordinatorSession>();
  private nextReplicaId = 1;

  constructor(documentId: string) {
    this.documentId = documentId;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Allocates a replica id for a newly-joining session — an in-memory
   * monotonic counter per document, starting at 1 (0 stays reserved for the
   * server), backed by `documents.next_replica_id` once persistence exists
   * (Phase 15).
   *
   * A reconnecting client is given a NEW replica id, never its previous one.
   * Reusing it could let the client mint an identifier with a counter it already
   * used before the disconnect, producing two distinct nodes with the same id and
   * violating Engine Spec I1 — silently, and only under specific timing.
   * API Spec §3.6.2.
   */
  allocateReplicaId(): number {
    const id = this.nextReplicaId;
    this.nextReplicaId += 1;
    return id;
  }

  join(session: CoordinatorSession): void {
    this.sessions.set(session.sessionId, session);
  }

  leave(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): CoordinatorSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Every session in this room except `exceptSessionId` — the ingress path's broadcast target set. */
  otherSessions(exceptSessionId: string): CoordinatorSession[] {
    const others: CoordinatorSession[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (sessionId !== exceptSessionId) {
        others.push(session);
      }
    }
    return others;
  }

  /**
   * WELCOME's participant list (API Spec §3.6.2). Includes the session
   * currently being welcomed itself — the spec text doesn't say either way,
   * so this treats WELCOME as a full roster snapshot at time of join
   * (simpler and more consistent than special-casing "everyone but me"),
   * matching the analogous application-level calls made in Phase 8 (e.g.
   * the `documentId` interim binding mechanism) without needing to ask.
   */
  listParticipants(): ParticipantInfo[] {
    return Array.from(this.sessions.values(), (s) => ({
      replicaId: s.replicaId,
      userId: s.userId,
      displayName: s.displayName,
    }));
  }
}
