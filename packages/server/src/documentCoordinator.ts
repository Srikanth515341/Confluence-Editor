import { Engine } from "@collab-editor/engine";
import type { ConnectionSendQueues } from "./sendQueues.js";

/**
 * Replica id 0 is reserved for the server and is never handed to a session
 * (API Spec §6.1). The server mints identifiers only for restore-generated
 * operations (a later phase); for everything else — all of Phase 8 — it
 * applies operations, never originates them.
 */
export const SERVER_REPLICA_ID = 0;

export interface CoordinatorSession {
  readonly sessionId: string;
  readonly replicaId: number;
  readonly queues: ConnectionSendQueues;
}

/**
 * One Document Coordinator per open document (RFC §5), holding the
 * server-side engine instance every connected session's operations flow
 * through. Fields exactly match API Spec §6.1's list; `watermarks`,
 * `opsSinceSnap`, and `lastSnapAt` are scaffolding for persistence/snapshot
 * phases (15-17) and are unused no-ops here — this phase only reads/writes
 * `engine` and `currentSeq`.
 */
export class DocumentCoordinator {
  readonly documentId: string;
  readonly engine = new Engine(SERVER_REPLICA_ID);

  /** API Spec §6.1: `currentSeq: bigint`. Assigned once per ingested OPS frame — see gateway.ts's ingest path for why frame-granularity, not per-underlying-operation. */
  currentSeq = 0n;

  /** Scaffolding for Phase 16 (persistence acks) — mirrors `sessions.last_ack_seq`. Unused this phase. */
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
   * Allocates a replica id for a newly-joining session. Interim scheme for
   * this phase — a monotonic counter per document, starting at 1 (0 stays
   * reserved for the server) — since real session/identity assignment is
   * Phases 26-29's auth work, not yet built.
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
}
