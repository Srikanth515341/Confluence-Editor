import { Engine } from "@collab-editor/engine";
import {
  SessionRole,
  replaySnapshotNodesInto,
  type ParticipantInfo,
} from "@collab-editor/protocol";
import type { AckBatcher } from "./ackBatcher.js";
import type { OperationStore } from "./db/operationStore.js";
import { SNAPSHOT_OP_THRESHOLD, SNAPSHOT_TIME_THRESHOLD_MS } from "./snapshotter.js";
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
 * `sessions.last_ack_seq`); `opsSinceSnap`/`lastSnapAt` are live as of
 * Phase 17 (RFC §13.2's MAYBE-SNAPSHOT — see snapshotter.ts).
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

  /** Operations committed since the last successful snapshot write (or since warm start, if none yet) — snapshotter.ts's own MAYBE-SNAPSHOT() trigger reads and resets this. */
  opsSinceSnap = 0;
  /** When the last snapshot was written, OR when warm start completed if none has been written yet since — the baseline snapshotter.ts's 30-second trigger measures from. Never `null`: an unset baseline (e.g. "since epoch") would make a fresh coordinator's very first operation immediately due by the time-based trigger, which isn't the intent of "30 seconds since [something became stale]." */
  lastSnapAt: Date;
  /** True while a snapshot write is in flight (snapshotter.ts) — prevents scheduling a second, overlapping write for the same coordinator. */
  snapshotInFlight = false;

  /**
   * GC observability (Phase 21, Scope-IN's own metrics list — "GC's failure mode is silent,
   * so liveness is monitored, not errors"). All four are read by httpApp.ts's `/gc-status`
   * endpoint and computed/updated by gcScheduler.ts on every tick, success or failure:
   * `lastGcAttemptAt`/`lastGcSuccessAt` are separate (not merged) specifically so a run that
   * THROWS still updates "attempted," letting `minutes_since_last_success` grow even while
   * cycles keep firing on schedule — a stuck GC that still LOOKS alive (the timer fires) is
   * exactly the silent failure this metric exists to catch. `lastCollectedCount` is the most
   * recent cycle's own count (not cumulative). `frontierLastAdvancedAt`/`lastKnownFrontier`
   * track when the stability frontier itself last MOVED — `frontier_lag_seconds` is derived
   * from the former, a genuine staleness signal (a frontier stuck for a long time means no
   * active session is acking, not necessarily that GC itself is broken).
   */
  lastGcAttemptAt: Date | null = null;
  lastGcSuccessAt: Date | null = null;
  lastGcCollectedCount = 0;
  lastKnownFrontier = 0n;
  frontierLastAdvancedAt: Date | null = null;
  /**
   * Phase 21 safety-cap metric (`gc.cycle_incomplete_count`): cumulative count, for this
   * coordinator's lifetime, of GC cycles that hit `GcConfig.gcFixpointBudgetMs` before the
   * fixpoint sweep naturally converged (engine.ts's `CollectResult.incomplete`). A cycle that
   * hits this is NOT a failure — the collected set is still fully safe, just possibly smaller
   * than the true maximum this time — but a document that keeps incrementing this every cycle
   * without making progress is worth alerting on separately from `minutes_since_last_success`
   * (that cycle DID succeed; it just didn't finish the whole sweep).
   */
  gcCycleIncompleteCount = 0;
  /**
   * RFC §13.2's cadence (500 ops / 30s), as instance fields rather than
   * only the module-level constants (snapshotter.ts) — test-only
   * injection point (constructor parameter below), so a test can prove
   * the "does not measurably affect operation latency" DoD claim by
   * comparing a coordinator with real thresholds against one whose
   * thresholds can never be reached, without needing to fake timers or
   * actually commit hundreds of operations to observe the disabled case.
   * Production code never overrides these — every real construction site
   * (gateway.ts) uses the two-argument constructor, leaving both at their
   * RFC-specified defaults.
   */
  readonly snapshotOpThreshold: number;
  readonly snapshotTimeThresholdMs: number;

  /**
   * Resolves once warm start (API Spec §6.2, extended by Phase 17's
   * snapshot-aware §6.4) has seeded `engine` from the latest snapshot (if
   * any) and replayed the operation-log SUFFIX after it, and restored
   * `currentSeq` from `documents.current_seq`. gateway.ts's handshake
   * handler awaits this before completing HELLO, so no client can ever
   * observe a coordinator's WELCOME/SNAPSHOT before its own warm start
   * has finished — including the very first connection to a brand-new
   * document, whose warm start still runs (and legitimately returns no
   * snapshot and an empty suffix) so the documents/users provisioning in
   * `operationStore.warmStart` always happens before any operation from
   * that connection could be persisted.
   */
  readonly ready: Promise<void>;

  private readonly sessions = new Map<string, CoordinatorSession>();
  private nextReplicaId = 1;

  /**
   * Phase 24's offline-window sweep (offlineWindowScheduler.ts): the first time each
   * still-BUFFERED operation (keyed by its own serialized stamp) was observed sitting in
   * `engine.pending`, so the sweep can tell "just noticed, give it the full 30s grace period"
   * apart from "already waited long enough, reject it" across repeated sweep ticks. Lives here
   * (not in `Engine`, which stays free of wall-clock concerns, Engine Spec C9) — the same
   * "server supplies the timestamp, the pure engine never reads one" split as
   * `applyRemote`'s own optional `context` argument.
   */
  readonly pendingFirstSeenAtMs = new Map<string, number>();

  /**
   * TEST-ONLY (Phase 24, Test Plan RC-32) — a ONE-SHOT role override consumed by the very NEXT
   * session to join this coordinator, standing in for a real, persisted permission lookup that
   * doesn't exist until Phases 26-30. Simulates "the owner already changed this specific
   * user's role before they reconnected" — a real permission system would look this up from
   * durable storage keyed by a stable user identity; neither exists yet (every session's own
   * identity is a fresh `randomUUID()` minted at connect time, Phase 8/16), so this override is
   * keyed by nothing more than "the very next join," which is sufficient to drive RC-32's own
   * scenario (one specific client reconnecting once) without inventing a persistent identity or
   * a permission model under schedule pressure. NEVER called by production code — see
   * gateway.ts's own consuming call site (`handleHandshake`) for how a downgrade is actually
   * communicated (WELCOME's own `role` field, then an explicit PERMISSION_CHANGED) and enforced
   * (writePath.ts's `authorize` step).
   */
  private testOnlyNextRoleOverride: SessionRole | null = null;

  testOnlyQueueRoleOverride(role: SessionRole): void {
    this.testOnlyNextRoleOverride = role;
  }

  /** Consumes (and clears) the queued override, if any — called exactly once per join attempt, win or lose, so a role override can never leak into a LATER, unrelated join. */
  consumeTestOnlyRoleOverride(): SessionRole | null {
    const role = this.testOnlyNextRoleOverride;
    this.testOnlyNextRoleOverride = null;
    return role;
  }

  constructor(
    documentId: string,
    operationStore: OperationStore,
    snapshotThresholds?: { readonly opThreshold?: number; readonly timeThresholdMs?: number },
  ) {
    this.documentId = documentId;
    this.operationStore = operationStore;
    this.snapshotOpThreshold = snapshotThresholds?.opThreshold ?? SNAPSHOT_OP_THRESHOLD;
    this.snapshotTimeThresholdMs =
      snapshotThresholds?.timeThresholdMs ?? SNAPSHOT_TIME_THRESHOLD_MS;
    this.lastSnapAt = new Date(); // provisional — warmStart() below sets the real baseline once it completes
    this.ready = this.warmStart();
  }

  /**
   * API Spec §6.2/§6.4. Seeds `engine` from the latest persisted snapshot
   * (if any — `replaySnapshotNodesInto`, `@collab-editor/protocol`), then
   * replays only the operation-log SUFFIX after it (in seq order, which
   * is causally valid order — see writePath.ts: an operation is only
   * ever assigned a seq after `engine.applyRemote` already accepted it
   * live, so replaying in that same order reproduces the same
   * causal-readiness path). Then asserts the DoD's own requirement:
   * `pendingCount() === 0`. A nonempty `pending` here means some
   * persisted operation's causal dependency is MISSING from the snapshot
   * + suffix entirely (e.g. a row deleted directly from the table,
   * bypassing this code path, or genuine corruption) — silently starting
   * this coordinator with a partially-applied document would be worse
   * than failing loudly before any client ever sees it, so this throws
   * rather than continuing.
   */
  private async warmStart(): Promise<void> {
    const { snapshotNodes, suffixOps, currentSeq } = await this.operationStore.warmStart(
      this.documentId,
    );
    if (snapshotNodes) {
      replaySnapshotNodesInto(this.engine, snapshotNodes);
    }
    for (const entry of suffixOps) {
      // Phase 21: thread seq/committed-time through so a Delete replayed after a restart
      // still carries GC context (see WarmStartSuffixOperation's own doc comment) — passed
      // unconditionally (engine.applyRemote only consults it for `kind: "delete"` ops).
      this.engine.applyRemote(entry.op, { seq: entry.seq, atMs: entry.committedAtMs });
    }
    if (this.engine.pending.length !== 0) {
      throw new Error(
        `DocumentCoordinator.warmStart: ${this.engine.pending.length} operation(s) never became ready after seeding${snapshotNodes ? ` from a ${snapshotNodes.length}-node snapshot and` : ""} replaying ${suffixOps.length} suffix operation(s) for document ${this.documentId} — the log is missing a causal dependency`,
      );
    }
    this.currentSeq = currentSeq;
    this.lastSnapAt = new Date(); // the real baseline — see this field's own doc comment
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

  /** Phase 24's offline-window sweep needs to reach a session by the REPLICA id an evicted pending operation names (`op.id.r`), not by session id — a linear scan over the (typically small) set of currently-open sessions for this document. Returns `undefined` if that replica has since disconnected (the sweep still evicts the pending operation either way — see offlineWindowScheduler.ts's own comment on this disclosed gap). */
  getSessionByReplicaId(replicaId: number): CoordinatorSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.replicaId === replicaId) {
        return session;
      }
    }
    return undefined;
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
