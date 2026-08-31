import { Engine, type Operation } from "@collab-editor/engine";
import { SessionRole, type ParticipantInfo } from "@collab-editor/protocol";
import type { AckBatcher } from "./ackBatcher.js";
import type { OperationStore } from "./db/operationStore.js";
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
  /** Phase 16: coalesces this session's own OP_ACK entries (up to 64 entries or 20ms, whichever first) — see ackBatcher.ts. Constructed once at handshake time (gateway.ts), closed on disconnect. */
  readonly ackBatcher: AckBatcher;
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
  /**
   * Diagnostic-only counter (not part of any phase's Scope-IN): total frames
   * received from this connection (any channel), incremented in gateway.ts.
   * Added while root-causing a Firefox-specific silent divergence found
   * during Phase 14 DoD verification (tests/regression/R0001-R0007) — lets
   * a client's own reported send-call count be compared directly against
   * how many of those sends the server actually saw arrive.
   */
  receivedFrameCount: number;
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
  readonly operationStore: OperationStore;

  /**
   * API Spec §6.1: `currentSeq: bigint`. Assigned PER OPERATION as of
   * Phase 16, not per ingested frame — see writePath.ts's own doc comment
   * for why the operations table's schema (one row per operation's
   * stamp, Phase 15) forced this change from Phase 8's original
   * per-frame numbering. A run/batch of N operations consumes N
   * consecutive seq values.
   */
  currentSeq = 0n;

  /** Per-replica last-acknowledged seq, updated on every PING's `lastAppliedSeq` (§3.6.11: "server updates the session's ... last-acked-seq on receipt"). Mirrors `sessions.last_ack_seq` — real persistence is Phase 16. */
  readonly watermarks = new Map<number, bigint>();
  /** Scaffolding for Phase 17 (snapshotting). Unused this phase. */
  opsSinceSnap = 0;
  /** Scaffolding for Phase 17 (snapshotting). Unused this phase. */
  lastSnapAt: Date | null = null;

  /**
   * Every operation this coordinator has ever ingested, in ingestion order
   * (gateway.ts's `ingestOperation`, appended AFTER `applyRemote` — see that
   * call site's own comment for why append order there is safe to replay
   * later regardless of cross-connection interleaving). NOT persistence
   * (Phases 15-17 own that) — this is an in-memory-only recording that
   * exists specifically so `/v1/documents/:id/replay` (httpApp.ts) can
   * reconstruct the document from scratch in a BRAND NEW `Engine`,
   * independent of this coordinator's own live-incrementally-applied
   * `engine` instance. Test Plan §2.7 E2E-CONV-01 assertion 3 needs exactly
   * this independence: comparing a client's DOM against this coordinator's
   * own already-running `engine` would only ever catch a bug in ingestion,
   * never a bug shared between the client's and server's identical `Engine`
   * code — replaying into a FRESH engine from the raw log is the same
   * "ground truth" argument, just harder for a subtly-corrupted live
   * instance to fake.
   */
  readonly operationLog: Operation[] = [];

  /**
   * Resolves once warm start (API Spec §6.2) has replayed the persisted
   * log into `engine` and restored `currentSeq` from `documents.
current_seq`. gateway.ts's handshake handler awaits this before
   * completing HELLO, so no client can ever observe a coordinator's
   * WELCOME/SNAPSHOT before its own warm start has finished — including
   * the very first connection to a brand-new document, whose warm start
   * still runs (and legitimately returns an empty log) so the
   * documents/users provisioning in `operationStore.warmStart` always
   * happens before any operation from that connection could be
   * persisted.
   */
  readonly ready: Promise<void>;

  private readonly sessions = new Map<string, CoordinatorSession>();
  private nextReplicaId = 1;

  constructor(documentId: string, operationStore: OperationStore) {
    this.documentId = documentId;
    this.operationStore = operationStore;
    this.ready = this.warmStart();
  }

  /**
   * API Spec §6.2. Replays the persisted operation log (in seq order,
   * which is causally valid order — see writePath.ts: an operation is
   * only ever assigned a seq after `engine.applyRemote` already accepted
   * it live, so replaying in that same order reproduces the same
   * causal-readiness path) into a brand-new `engine`, then asserts the
   * DoD's own requirement: `pendingCount() === 0`. A nonempty `pending`
   * here means some persisted operation's causal dependency is MISSING
   * from the log entirely (e.g. a row deleted directly from the table,
   * bypassing this code path, or genuine corruption) — silently starting
   * this coordinator with a partially-applied document would be worse
   * than failing loudly before any client ever sees it, so this throws
   * rather than continuing.
   */
  private async warmStart(): Promise<void> {
    const { ops, currentSeq } = await this.operationStore.warmStart(this.documentId);
    for (const op of ops) {
      this.engine.applyRemote(op);
      this.operationLog.push(op);
    }
    if (this.engine.pending.length !== 0) {
      throw new Error(
        `DocumentCoordinator.warmStart: ${this.engine.pending.length} operation(s) never became ready after replaying ${ops.length} persisted operations for document ${this.documentId} — the log is missing a causal dependency`,
      );
    }
    this.currentSeq = currentSeq;
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

  /** Diagnostic-only (see CoordinatorSession.receivedFrameCount's doc comment). */
  listReceivedFrameCounts(): Array<{
    replicaId: number;
    sessionId: string;
    receivedFrameCount: number;
  }> {
    return Array.from(this.sessions.values(), (s) => ({
      replicaId: s.replicaId,
      sessionId: s.sessionId,
      receivedFrameCount: s.receivedFrameCount,
    }));
  }
}
