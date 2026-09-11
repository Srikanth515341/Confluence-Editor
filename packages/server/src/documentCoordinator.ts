import { Engine } from "@collab-editor/engine";
import {
  SessionRole,
  replaySnapshotNodesInto,
  type ParticipantInfo,
} from "@collab-editor/protocol";
import type { AckBatcher } from "./ackBatcher.js";
import type { OperationStore } from "./db/operationStore.js";
import type { DocumentRole } from "./db/documentStore.js";
import { SNAPSHOT_OP_THRESHOLD, SNAPSHOT_TIME_THRESHOLD_MS } from "./snapshotter.js";
import type { ConnectionSendQueues } from "./sendQueues.js";
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  type CircuitBreakerConfig,
  type RateLimitConfig,
} from "./config.js";
import { logger } from "./logger.js";
import { InMemoryRateLimiter } from "./rateLimiter.js";

/**
 * Replica id 0 is reserved for the server and is never handed to a session
 * (API Spec §6.1). The server mints identifiers only for restore-generated
 * operations (a later phase); for everything else — all of Phase 8 — it
 * applies operations, never originates them.
 */
export const SERVER_REPLICA_ID = 0;

/** `null` (no permission row — including a nonexistent user) maps to `null` here too, distinct from every real `DocumentRole`, so callers can tell "this user genuinely has no access" apart from a real VIEWER role. */
function documentRoleToSessionRole(role: DocumentRole | null): SessionRole | null {
  switch (role) {
    case "owner":
      return SessionRole.OWNER;
    case "editor":
      return SessionRole.EDITOR;
    case "viewer":
      return SessionRole.VIEWER;
    case null:
      return null;
  }
}

/**
 * Phase 25 (DUR-06 fix) — plain identity data for a still-BUFFERED operation's original
 * sender, captured at the moment writePath.ts first learns the operation is not yet ready
 * (`Engine.applyRemote` returning `{buffered: true}`). Needed because such an operation may
 * finalize (become ready, get a real seq, get broadcast/committed/acked) as a SIDE EFFECT of a
 * completely different, LATER message's own processing (writePath.ts's own "slow path") —
 * whatever session handles that later message has no other way to learn who originally sent
 * the now-resolved operation, or what identity to commit/ack it under.
 */
export interface PendingOpOrigin {
  readonly sessionId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly replicaId: number;
}

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
  /**
   * Hardcoded EDITOR at connect time for every real session (API Spec §3.6.2) — real per-user
   * role ASSIGNMENT still doesn't reach the WS layer (Phase 29's own "real WS identity" job; see
   * `HelloMessage.ticket`'s own doc comment). Mutable as of Phase 28 (was `readonly` through
   * Phase 27): Phase 28's Goal is authorization "not just at connect," which requires a role
   * change to be observable to an ALREADY-CONNECTED session, not only to the next one that joins
   * (Phase 24's original `testOnlyQueueRoleOverride` only ever affected the latter). Mutated only
   * via `DocumentCoordinator.setSessionRoleLive`/`testOnlySetConnectedSessionRole` below, which
   * also invalidate this session's own cached authorization decision so the change is never
   * masked by a stale cache entry.
   */
  role: SessionRole;
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
  /**
   * Phase 27 (API Spec §4.5 DELETE: "causes every open socket for the document to receive
   * GOODBYE{reason: 2}") — a closure, set only in gateway.ts's own real session construction,
   * that encodes and sends a GOODBYE control frame (reason PERMISSION_REVOKED) then closes the
   * underlying socket. OPTIONAL, not required, deliberately: a dozen pre-existing test fixtures
   * across this codebase construct a `CoordinatorSession` literal directly (writePath.test.ts,
   * heartbeat.test.ts, every `db/*.db.test.ts` file, etc.) with no real `ws` object to close —
   * making this required would force updating every one of them for a capability none of them
   * exercise. `DocumentCoordinator.disconnectAllSessions()` below calls it via `?.()`, so a
   * session with no closure attached (every one of those pre-existing fixtures) is silently
   * skipped rather than throwing.
   */
  readonly disconnectForRevocation?: () => void;
  /**
   * Phase 30 (RFC §8.2 (T2), Test Plan SEC-08: "throttles at 200 ops/s, then disconnects") — a
   * closure, set only in gateway.ts's own real session construction, that ends this session once
   * its own rejection VOLUME has crossed `RateLimitConfig.perSessionDisconnectRule` within a
   * rolling window (see `recordRateLimitViolation`'s own doc comment for why this is a rolling
   * violation-count check, not a continuous-streak one). OPTIONAL for the SAME reason
   * `disconnectForRevocation` above is: a dozen pre-existing test fixtures construct a
   * `CoordinatorSession` literal directly with no real `ws` to close.
   */
  readonly disconnectForRateLimit?: () => void;
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

  /**
   * Phase 25 (DUR-06 fix, follow-up finding) — the highest seq for which this coordinator is
   * CERTAIN the full prefix `[0..that]` has been durably committed, in order, with no gaps.
   * Distinct from `currentSeq` above, which is bumped SYNCHRONOUSLY at seq-RESERVATION time —
   * before the corresponding row has necessarily reached the store. Advanced ONLY by
   * {@link enqueueCommit}, in strict commit order, never by anything else. `handshake.ts`'s
   * `buildCatchupMessages` reads THIS field for CATCHUP's own `toSeq` bound, never the raw
   * `currentSeq` — see `enqueueCommit`'s own doc comment for the full reasoning (a hand-traced
   * finding: without this, a reconnecting client's CATCHUP can be told it received more than
   * what is actually, durably present, permanently skipping an operation with no error).
   * Initialized from `currentSeq` once warm start completes (below) — everything replayed by
   * warm start came from the persisted log itself, so it is durable by construction.
   */
  lastCommittedSeq = 0n;

  /**
   * Phase 25 (DUR-06 fix, follow-up finding) — the tail of a per-document FIFO promise chain.
   * Never read directly outside {@link enqueueCommit}.
   */
  private commitQueueTail: Promise<unknown> = Promise.resolve();

  /**
   * Serializes EVERY `OperationStore.commitOperations` call for this document through one FIFO
   * queue — `fn` for a LATER-reserved seq range can never even START executing until every
   * earlier-enqueued `fn` has fully settled. This is what makes commit EXECUTION order always
   * equal seq RESERVATION order, for ANY number of operations, authors, or write-path branches
   * (writePath.ts's fast path OR its slow path), removing the "commits can land in the store
   * out of seq order" bug class entirely — not narrowing the window, removing it, regardless of
   * how many concurrent messages interleave.
   *
   * MUST be called SYNCHRONOUSLY, with no `await` between reserving the seq range `endSeq`
   * describes and calling this — every call site in writePath.ts satisfies this. The ordering
   * guarantee rests entirely on that: Node's single-threaded execution means one message's
   * synchronous "reserve seq, then enqueue" sequence can never be interrupted by another
   * message's synchronous code, so enqueue order is provably identical to seq-reservation order
   * — and this queue then makes commit EXECUTION order identical to enqueue order.
   *
   * `endSeq` is the LAST seq value `fn`'s own commit call covers. On success, `lastCommittedSeq`
   * is set to it (never merged via `Math.max` — safe precisely because the queue guarantees
   * strict in-order execution, so `endSeq` values arrive already monotonically increasing). On
   * failure, `lastCommittedSeq` is deliberately left exactly where it was: that seq range's own
   * row(s) never actually landed, so the durable prefix genuinely stops there — advancing past
   * it would let a LATER, unrelated success paper over a real, permanent gap, which is exactly
   * the dishonest-CATCHUP-promise class of bug this field exists to prevent. This mirrors an
   * already-accepted risk elsewhere in this codebase (writePath.ts's own "no ack for a commit
   * that failed" reasoning) — this only makes CATCHUP's own promise to a reconnecting client
   * honest about it too, rather than a NEW failure mode.
   */
  enqueueCommit<T>(endSeq: bigint, fn: () => Promise<T>): Promise<T> {
    const result = this.commitQueueTail.then(() => fn());
    this.commitQueueTail = result.then(
      () => {
        this.lastCommittedSeq = endSeq;
      },
      () => {
        // Swallow here only so the QUEUE keeps advancing for later, unrelated commits — `result`
        // itself (returned below) still carries the real rejection to whichever writePath.ts
        // call site awaits it, exactly as before this field existed.
      },
    );
    return result;
  }

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
   * Phase 25 (DUR-06 fix) — see {@link PendingOpOrigin}'s own doc comment for the full
   * reasoning. Populated by writePath.ts the instant `applyRemote` reports an operation as
   * buffered; consumed (and deleted) by writePath.ts's own "slow path" when that operation
   * later finalizes as a side effect of a different message, OR by offlineWindowScheduler.ts
   * when it explicitly rejects/evicts the same operation instead — whichever happens first is
   * expected to clean up its own entry, so this map never grows for an operation that has
   * already been resolved one way or the other.
   */
  readonly pendingOpOrigin = new Map<string, PendingOpOrigin>();

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

  /**
   * Phase 28 (API Spec §6.3 line 1, Test Plan SEC-06) — a per-session decision cache with a
   * ≤2-second TTL, keyed by sessionId. Exists so per-operation authorization (Phase 28's own
   * Goal: "enforced server-side on every operation, not just at connect") does not mean a fresh
   * permission lookup on every single keystroke once a real, DB-backed per-user permission check
   * eventually replaces `session.role` as this cache's source of truth (Phase 29+) — a stale
   * decision can survive for at most `AUTH_DECISION_TTL_MS`, and an EXPLICIT role change
   * (`setSessionRoleLive` below) invalidates it immediately rather than waiting out the TTL, so a
   * revocation is never masked by a cache that just happens to still be "fresh."
   */
  private readonly authDecisionCache = new Map<string, { readonly allowed: boolean; readonly expiresAt: number }>();

  /** SEC-06's own literal bound: "a decision cache whose TTL is ≤ 2s." */
  static readonly AUTH_DECISION_TTL_MS = 2000;

  /**
   * Step 1 of writePath.ts's write path (API Spec §6.3 line 1) — re-evaluated on every call, not
   * read once at connect. As of Phase 29, when this coordinator was constructed with a real
   * {@link lookupRole} (a real server, `auth` deps present), a cache MISS performs a genuine,
   * fresh `document_permissions` lookup — not merely a re-read of `session.role`, which would
   * never change unless something explicitly pushed a new value. This distinction is what makes
   * SEC-05 possible: "with the invalidation push suppressed, revocation still takes effect within
   * 2s via the cache TTL alone" — a design that ONLY works if expiring the cache and recomputing
   * can independently discover a revocation nobody told this session about directly. A coordinator
   * with no `lookupRole` (every pre-Phase-29 test, and any test that doesn't care about real auth)
   * falls back to the original Phase 28 behavior — reading `session.role` directly — preserving
   * that entire test surface unchanged. `session.role` is also kept in sync with a fresh lookup's
   * result (informational — WELCOME/PERMISSION_CHANGED's own role field reads it), so a UI-facing
   * read of `session.role` is never staler than the cache itself.
   */
  async authorizeSession(session: CoordinatorSession, now: number = Date.now()): Promise<boolean> {
    const cached = this.authDecisionCache.get(session.sessionId);
    if (cached && cached.expiresAt > now) {
      return cached.allowed;
    }
    let allowed: boolean;
    if (this.lookupRole) {
      const role = await this.lookupRole(session.userId);
      session.role = documentRoleToSessionRole(role) ?? SessionRole.VIEWER;
      allowed = role === "editor" || role === "owner";
    } else {
      allowed = session.role !== SessionRole.VIEWER;
    }
    this.authDecisionCache.set(session.sessionId, {
      allowed,
      expiresAt: now + DocumentCoordinator.AUTH_DECISION_TTL_MS,
    });
    return allowed;
  }

  /** Drops any cached authorization decision for one session — called whenever that session's own role changes, so the very next operation re-evaluates rather than possibly reusing a decision cached under the OLD role for up to `AUTH_DECISION_TTL_MS` longer. */
  invalidateAuthorizationCache(sessionId: string): void {
    this.authDecisionCache.delete(sessionId);
  }

  /**
   * Phase 28 — generalizes Phase 24's `testOnlyQueueRoleOverride` (which only ever affected the
   * NEXT session to join) to also change an ALREADY-CONNECTED session's role live. As of Phase
   * 29, a real caller (httpApp.ts's grant/revoke/transfer routes) reaches this via
   * `getSessionsByUserId` — a REAL authenticated userId now flows into `CoordinatorSession.userId`
   * (Phase 29's real ticket-based admission, see gateway.ts), so this is no longer only a test
   * seam for the WS side, though `testOnlySetConnectedSessionRole` below remains for tests that
   * don't want to build a real ticket. Returns `false` if no session with that id is currently
   * connected (the caller treats this as "nothing to push," not an error, since the affected user
   * may simply not be connected over WS right now).
   */
  setSessionRoleLive(sessionId: string, role: SessionRole): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.role = role;
    this.invalidateAuthorizationCache(sessionId);
    return true;
  }

  /** TEST-ONLY (Phase 28, Test Plan SEC-01/02/03/07) — thin, explicitly-named alias for `setSessionRoleLive`, kept separate so every call site that exists purely to simulate "a real permission change landed on an already-connected session" (since no real WS identity/ticket-based admission exists until Phase 29) is grep-able as a test seam, the same discipline `testOnlyQueueRoleOverride` above already established. */
  testOnlySetConnectedSessionRole(sessionId: string, role: SessionRole): boolean {
    return this.setSessionRoleLive(sessionId, role);
  }

  /**
   * Phase 28 (API Spec §4.7/§4.8: "pushes PERMISSION_CHANGED to every open session for that user
   * on that document") — matches by `CoordinatorSession.userId`. Through Phase 28 this was a
   * fresh `randomUUID()` per WS connection, so this method structurally never matched anything in
   * production. As of Phase 29, when a session was admitted through real ticket-based validation
   * (gateway.ts, `auth` deps configured), `userId` is the REAL authenticated user id from the
   * ticket, so this now genuinely reaches a live session for that real user. A session admitted
   * with no real auth wiring (every pre-Phase-29 test, and any server built without `auth` deps)
   * still carries the old random placeholder, so this remains a correct no-op finder for that
   * case — it never matches an unrelated real userId by accident.
   */
  getSessionsByUserId(userId: string): CoordinatorSession[] {
    const result: CoordinatorSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        result.push(session);
      }
    }
    return result;
  }

  /**
   * Phase 30 (RFC §8.2 (T2), Test Plan SEC-08) — `undefined` disables per-session/per-document
   * op-rate limiting entirely (writePath.ts's own step 3 skips the check outright when this is
   * unset) — see `RateLimitConfig`'s own doc comment (config.ts) for why this defaults to OFF
   * rather than ON with a generous default, unlike `circuitBreakerConfig` below.
   */
  private readonly rateLimitConfig: RateLimitConfig | undefined;
  /**
   * One shared limiter across every session on this document, used for THREE independent
   * key/rule pairs: `session:<id>` (the per-session cap), `document:<documentId>` (the
   * per-document cap), and `violation:<id>` (SEC-08's own disconnect trigger — see
   * `recordRateLimitViolation`'s own doc comment).
   */
  private readonly opRateLimiter = new InMemoryRateLimiter();

  /**
   * Phase 30 (RFC §8.2 (T2), Test Plan SEC-08) — ALWAYS active, unlike {@link rateLimitConfig}
   * above; see `CircuitBreakerConfig`'s own doc comment (config.ts) for why a generous default is
   * safe to leave on unconditionally. Overridable (constructor's `securityLimits` parameter,
   * below) so a test can trip it without building a document anywhere near the real default's
   * scale.
   */
  private readonly circuitBreakerConfig: CircuitBreakerConfig;
  private circuitBreakerState: {
    tripped: boolean;
    trippedAtMs: number | null;
    reason: string | null;
  } = { tripped: false, trippedAtMs: null, reason: null };
  /** Edge-triggered logging state for the two alert thresholds (config.ts's own doc comment: "logged once, not per operation") — `false` until the threshold is first crossed, reset back to `false` once the metric falls back under it (e.g. after GC), so a LATER re-crossing logs again rather than staying silent forever after the first time. */
  private structureSizeAlertLogged = false;
  private tombstoneCountAlertLogged = false;

  /**
   * Phase 29 — a real, per-user `document_permissions` lookup, bound to THIS coordinator's own
   * `documentId` by whoever constructs it (`gateway.ts`'s `getOrCreateCoordinator`, only when
   * `auth` deps are configured). `undefined` for every coordinator built without real auth wiring
   * (the overwhelming majority of this project's own tests) — `authorizeSession` falls back to
   * the original Phase 28 `session.role`-only check in that case, so none of that test surface
   * needs to change for this phase.
   */
  private readonly lookupRole: ((userId: string) => Promise<DocumentRole | null>) | undefined;

  constructor(
    documentId: string,
    operationStore: OperationStore,
    snapshotThresholds?: { readonly opThreshold?: number; readonly timeThresholdMs?: number },
    lookupRole?: (userId: string) => Promise<DocumentRole | null>,
    /**
     * Phase 30 — bundles the two new, unrelated-in-scope-but-both-optional threshold overrides
     * (see `rateLimitConfig`/`circuitBreakerConfig`'s own field doc comments above for why one
     * defaults to disabled and the other to a generous always-on default) rather than adding two
     * more positional parameters to an already five-parameter constructor.
     */
    securityLimits?: {
      readonly rateLimit?: RateLimitConfig;
      readonly circuitBreaker?: Partial<CircuitBreakerConfig>;
    },
  ) {
    this.documentId = documentId;
    this.operationStore = operationStore;
    this.snapshotOpThreshold = snapshotThresholds?.opThreshold ?? SNAPSHOT_OP_THRESHOLD;
    this.snapshotTimeThresholdMs =
      snapshotThresholds?.timeThresholdMs ?? SNAPSHOT_TIME_THRESHOLD_MS;
    this.lookupRole = lookupRole;
    this.rateLimitConfig = securityLimits?.rateLimit;
    this.circuitBreakerConfig = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      ...securityLimits?.circuitBreaker,
    };
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
    const { snapshotNodes, suffixOps, currentSeq, nextReplicaId } = await this.operationStore.warmStart(
      this.documentId,
    );
    // Phase 25 (found via DUR-03): seeded from a real query, not left at this field's own
    // class-default of 1 — see WarmStartResult.nextReplicaId's own doc comment for the exact
    // collision this closes (a restarted coordinator's counter re-handing-out a replica id a
    // still-existing `sessions` row already used for this same document).
    this.nextReplicaId = nextReplicaId;
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
    // Everything up to `currentSeq` at this point came from the persisted log itself (or is 0
    // for a brand-new document) — durable by construction, so the commit-queue watermark starts
    // in lockstep with it, not at 0n.
    this.lastCommittedSeq = currentSeq;
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

  /**
   * Phase 30 (RFC §8.2 (T2), Test Plan SEC-08) — writePath.ts's own step 3. Returns `"ok"` when
   * either no `rateLimitConfig` was ever supplied to this coordinator (rate limiting disabled —
   * see that field's own doc comment) or the incoming message is under BOTH the per-session and
   * the shared per-document budget; otherwise names WHICH ONE tripped, so writePath.ts's own
   * rejection detail and disconnect logic can react differently (only a SESSION-scope violation
   * ever leads to a disconnect — see `recordRateLimitViolation` below). Counts once per call
   * (one incoming message = one unit), never by the number of operations that message expands
   * to — see `RateLimitConfig`'s own doc comment (config.ts) for the full reasoning.
   */
  checkOpRateLimit(sessionId: string, nowMs: number = Date.now()): "ok" | "session" | "document" {
    if (!this.rateLimitConfig) {
      return "ok";
    }
    if (!this.opRateLimiter.consume(`session:${sessionId}`, this.rateLimitConfig.perSessionRule, nowMs)) {
      return "session";
    }
    if (
      !this.opRateLimiter.consume(
        `document:${this.documentId}`,
        this.rateLimitConfig.perDocumentRule,
        nowMs,
      )
    ) {
      return "document";
    }
    return "ok";
  }

  /**
   * Records one SESSION-scope rate-limit violation and reports whether this session has now
   * exceeded `RateLimitConfig.perSessionDisconnectRule` — SEC-08's own "throttles ... then
   * disconnects": a single rejected message throttles (the caller already sent OP_REJECT); only
   * a genuinely high VOLUME of rejections within a rolling window disconnects.
   *
   * Reuses the SAME `InMemoryRateLimiter.consume()` mechanism `checkOpRateLimit` itself already
   * uses, under a second, independent key (`violation:<sessionId>`) — NOT a continuous-streak
   * check. An earlier design required the streak to be CONTINUOUS (zero acceptances) for a full
   * `perSessionSustainedViolationMs` window, which turned out to be structurally unreachable
   * against a real sustained attacker: a limiter that is successfully THROTTLING an attacker, by
   * design, keeps admitting `perSessionRule.max` messages per `perSessionRule.windowMs` forever,
   * and every acceptance reset that streak to zero — see `perSessionDisconnectRule`'s own doc
   * comment (config.ts) for the full account of why, and this project's own real empirical
   * measurement (Phase 30) that found it. This version counts REJECTIONS, not the absence of
   * acceptances — an accepted message no longer resets anything; only real time aging old
   * violations out of the rolling window ever lowers this count, so a session under CONSTANT,
   * heavy rejection (regardless of how many messages happen to slip through) still accumulates
   * toward disconnect.
   */
  recordRateLimitViolation(sessionId: string, nowMs: number = Date.now()): boolean {
    const config = this.rateLimitConfig;
    if (!config) return false;
    // consume() returns true = "still under its own violation budget"; false = "this violation
    // itself pushed the session over budget" -- THAT'S the disconnect signal.
    return !this.opRateLimiter.consume(`violation:${sessionId}`, config.perSessionDisconnectRule, nowMs);
  }

  /**
   * Phase 30 (RFC §8.2 (T2), Test Plan SEC-08) — re-evaluates the document-wide circuit breaker
   * against the engine's OWN live structural metrics (`engine.stats()`, O(1)). Called reactively
   * after every successfully-committed operation (writePath.ts, both its fast and slow paths) —
   * so the breaker trips as soon as a commit actually crosses the ceiling, not on some later
   * polling interval — and again after every GC cycle (gcScheduler.ts), which is what lets it
   * SELF-HEAL: once GC reclaims enough tombstones to fall back under the ceiling, the very next
   * evaluation (the same GC cycle's own) clears it automatically, with no separate "reset" action
   * required from an operator. Alert-threshold logging is edge-triggered (see
   * `structureSizeAlertLogged`/`tombstoneCountAlertLogged`'s own doc comments) — a document that
   * stays above an alert threshold for a long time logs it exactly once, not on every operation.
   */
  evaluateCircuitBreaker(nowMs: number = Date.now()): void {
    const stats = this.engine.stats();
    const config = this.circuitBreakerConfig;

    const shouldBeTripped = stats.totalElements >= config.structureSizeCeiling;
    if (shouldBeTripped && !this.circuitBreakerState.tripped) {
      this.circuitBreakerState = {
        tripped: true,
        trippedAtMs: nowMs,
        reason: `structure size ${stats.totalElements} reached the ${config.structureSizeCeiling}-node circuit-breaker ceiling (RFC §8.2)`,
      };
      logger.error("documentCoordinator.circuitBreakerTripped", {
        documentId: this.documentId,
        totalElements: stats.totalElements,
        tombstones: stats.tombstones,
        ceiling: config.structureSizeCeiling,
      });
    } else if (!shouldBeTripped && this.circuitBreakerState.tripped) {
      logger.warn("documentCoordinator.circuitBreakerRecovered", {
        documentId: this.documentId,
        totalElements: stats.totalElements,
        tombstones: stats.tombstones,
      });
      this.circuitBreakerState = { tripped: false, trippedAtMs: null, reason: null };
    }

    const structureAlerted = stats.totalElements >= config.structureSizeAlertThreshold;
    if (structureAlerted && !this.structureSizeAlertLogged) {
      logger.warn("documentCoordinator.structureSizeAlert", {
        documentId: this.documentId,
        totalElements: stats.totalElements,
        threshold: config.structureSizeAlertThreshold,
      });
    }
    this.structureSizeAlertLogged = structureAlerted;

    const tombstoneAlerted = stats.tombstones >= config.tombstoneCountAlertThreshold;
    if (tombstoneAlerted && !this.tombstoneCountAlertLogged) {
      logger.warn("documentCoordinator.tombstoneCountAlert", {
        documentId: this.documentId,
        tombstones: stats.tombstones,
        threshold: config.tombstoneCountAlertThreshold,
      });
    }
    this.tombstoneCountAlertLogged = tombstoneAlerted;
  }

  isCircuitBreakerTripped(): boolean {
    return this.circuitBreakerState.tripped;
  }

  /** Read-only introspection for httpApp.ts's `/security-status` endpoint. */
  getSecurityStatus(): {
    readonly circuitBreakerTripped: boolean;
    readonly circuitBreakerTrippedAtMs: number | null;
    readonly circuitBreakerReason: string | null;
    readonly structureSize: number;
    readonly tombstoneCount: number;
    readonly circuitBreakerConfig: CircuitBreakerConfig;
  } {
    const stats = this.engine.stats();
    return {
      circuitBreakerTripped: this.circuitBreakerState.tripped,
      circuitBreakerTrippedAtMs: this.circuitBreakerState.trippedAtMs,
      circuitBreakerReason: this.circuitBreakerState.reason,
      structureSize: stats.totalElements,
      tombstoneCount: stats.tombstones,
      circuitBreakerConfig: this.circuitBreakerConfig,
    };
  }

  /**
   * API Spec §4.5 DELETE — called once, by httpApp.ts's DELETE /v1/documents/{id} handler, after
   * the durable revocation itself has already committed. A no-op if nobody is currently
   * connected (the coordinator's own session map is simply empty, or the coordinator for this
   * document doesn't exist in memory at all — the caller checks that before reaching here). Does
   * NOT remove sessions from `this.sessions` directly: `disconnectForRevocation()` closes the
   * real socket, and the EXISTING `ws.on("close", ...)` handler (gateway.ts) already calls
   * `coordinator.leave(sessionId)` once that close completes — reusing that path rather than
   * duplicating it here.
   */
  disconnectAllSessions(): void {
    for (const session of this.sessions.values()) {
      session.disconnectForRevocation?.();
    }
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
