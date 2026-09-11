// API/Protocol/Data Spec v1.0 §6.3's write path, implemented line for
// line, plus the DUR-04 mutation switch (Test Plan DUR-04). This is the
// single most consequential ordering decision in the system (Phase 16's
// own framing): get the broadcast/commit/ack ordering wrong and either
// M4 latency or M2 durability breaks.
//
//   0. (Phase 30, RFC §8.2 (T2)) circuit breaker check -- ahead of every other step, since a
//      tripped breaker makes the document read-only for EVERYONE, including its own owner; this
//      is not an authorization decision (step 1), it is "there is currently no valid operation
//      to authorize a check against" -- see DocumentCoordinator.isCircuitBreakerTripped
//   1. authorize (Phase 24 gave this a real, minimal check -- session.role !== VIEWER, evaluated
//      once at that phase. Phase 28 makes this a genuine PER-OPERATION re-check, through a ≤2s
//      decision cache (SEC-06) that a live role change invalidates immediately -- see
//      DocumentCoordinator.authorizeSession/setSessionRoleLive)
//   2. verify stamp.r === session.replica_id
//   3. rate check (Phase 30, RFC §8.2 (T2), Test Plan SEC-08) -- per-session AND per-document,
//      independently -- see DocumentCoordinator.checkOpRateLimit
//   4. expand run/batch
//   5. engine.applyRemote
//   6. assign seq
//   7. BROADCAST to peers                                    <- before the transaction
//   8. BEGIN -> INSERT ... ON CONFLICT DO NOTHING ->
//      UPDATE documents SET current_seq -> COMMIT
//   9. OP_ACK from inside the transaction's success continuation  <- after the commit
//
// Steps 1-3 are evaluated AFTER step 4's expansion in the code below (not step order 1,2,3,4)
// -- see the code's own comment at that point for why.
//
// Phase 25 (DUR-06 fix) — steps 5 through 9 above describe the FAST PATH only: every operation
// in the incoming message is immediately causally ready, and nothing else was waiting on it.
// That is overwhelmingly the common case, and the fast path below is byte-for-byte the same
// code that ran before this fix (down to the exact `maybeCrash` site placement DUR-03 depends
// on) — it is not a new, parallel implementation.
//
// The fix this phase adds is for the OTHER case: `Engine.applyRemote` can report an operation
// as `{buffered: true}` — its causal dependency (e.g. a concurrently-dropped/delayed peer
// operation) hasn't arrived at the SERVER yet. Before this fix, writePath.ts ignored that
// return value entirely and broadcast/committed/acked the operation anyway — a direct
// violation of PRD FR-PS-2 ("acknowledgement implies durability"), since the server's own
// engine had just reported it was NOT ready, and worse, could hand a peer an operation whose
// own dependency the SERVER ITSELF doesn't have yet, risking a PERMANENT orphan if that
// dependency is later dropped for good (this is exactly DUR-06's own root cause).
//
// The SLOW PATH (`finalizeSlowPath` below) is taken whenever any operation in the incoming
// message is buffered, OR whenever readiness-checking this message's own operations happens to
// resolve some UNRELATED, previously-buffered operation as a side effect of `Engine.drain()`
// (e.g. this message finally supplies operation X's missing dependency, and X was submitted by
// a completely different session in an earlier message). In the slow path:
//   - seq is assigned LAZILY, only at the moment an operation is actually finalized — never
//     reserved up front for an operation that might still be sitting in `engine.pending` —
//     so `coordinator.currentSeq` can never race ahead of a lower-seq operation that isn't
//     ready yet (which would make a CATCHUP query silently skip that operation forever, since
//     CATCHUP's own range query is `seq > lastServerSeq`, not "whatever seq was reserved").
//   - a delete's GC context (Engine Spec §7.3, Phase 21) is recorded via `Engine.
//     setDeleteContext` explicitly, at the same moment its real seq is assigned, since seq
//     isn't known at the time `applyRemote` first determines readiness.
//   - `DocumentCoordinator.pendingOpOrigin` recovers the ORIGINAL sender's identity for an
//     operation that resolves as someone else's side effect — needed because the session
//     object handling THIS message has no other way to know whose operation just finalized.
//   - each finalized operation is broadcast/committed/acked INDIVIDUALLY (a mixed-readiness
//     batch has no single compact run/batch wire shape left to relay), never as the original
//     message's own compact frame.

import { serializeId, type Operation } from "@collab-editor/engine";
import {
  encodeFrame,
  operationToOpDelete,
  operationToOpInsert,
  operationToOpUndelete,
  RejectReason,
  SessionRole,
  type AckEntry,
  type OpAckMessage,
  type OpDeleteMessage,
  type OpInsertMessage,
  type OpRejectMessage,
  type OpsMessage,
  type OpUndeleteMessage,
  type RejectEntry,
} from "@collab-editor/protocol";
import type {
  CoordinatorSession,
  DocumentCoordinator,
  PendingOpOrigin,
} from "./documentCoordinator.js";
import { toOperations } from "./ingest.js";
import { logger } from "./logger.js";
import { maybeScheduleSnapshot } from "./snapshotter.js";
import { maybeCrash } from "./testOnlyCrashInjection.js";

/**
 * DUR-04's mutation switch. Reading `process.env` (not a constructor
 * parameter threaded through gateway.ts) is deliberate: the Test Plan's
 * own wording is "a variant of the write path (gated behind an env flag,
 * e.g. MUTATE_ACK_BEFORE_COMMIT=1)" — the point is that THIS module, the
 * one that actually ships, is what gets toggled, not a parallel
 * reimplementation that could silently drift from production behavior.
 * NEVER set outside packages/server/src/db/durability.db.test.ts's own
 * DUR-04 test — it is not listed in .env.example, and no startup path
 * (server.ts, index.ts) reads or forwards it for any other purpose.
 */
const MUTATE_ACK_BEFORE_COMMIT_ENV = "MUTATE_ACK_BEFORE_COMMIT";

export function isAckBeforeCommitMutationActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MUTATE_ACK_BEFORE_COMMIT_ENV] === "1";
}

export interface WritePathDeps {
  readonly coordinator: DocumentCoordinator;
  readonly session: CoordinatorSession;
  readonly msg: OpsMessage;
}

/**
 * DUR-04 test-only hook. Never supplied by gateway.ts's production call
 * site. Called at "the commit point" (Test Plan DUR-04's own wording) —
 * the exact place in whichever ordering is currently active where a real
 * ack has just been queued to send. Throwing here simulates a process
 * crash at that instant: under the MUTATED ordering, it fires before the
 * transaction has even started; under the REAL ordering, it fires after
 * the transaction has already committed — which is the entire point.
 */
export interface WritePathTestHooks {
  readonly simulateCrashAtCommitPoint?: () => void;
}

/** `OpsMessage` minus the two server-only, seq-less kinds — narrowed once here rather than at every downstream call site, since `processIncomingOperation`'s own early throw guard only narrows within that function's own body, not across the `runFastPath`/`runSlowPath` function boundary. */
type ClientOpsMessage = Exclude<OpsMessage, OpAckMessage | OpRejectMessage>;

/** Sends OP_REJECT to the SENDER only (never broadcast) — used by every rejection path in this module, and (exported) by offlineWindowScheduler.ts's own, separate OFFLINE_WINDOW_EXCEEDED rejection. */
export function sendOpReject(
  session: CoordinatorSession,
  ops: readonly Operation[],
  reason: RejectReason,
  detail: string,
): void {
  const rejects: RejectEntry[] = ops.map((op) => ({ rejectedId: op.id, reason }));
  session.queues.enqueue("ops", encodeFrame({ kind: "opReject", rejects, detail }));
}

/**
 * Broadcast BEFORE the commit; ack AFTER it. Peers need convergence, not
 * durability, so the fanout path must not pay a database round trip (RFC §7.4).
 * The ack is a durability promise and is emitted from inside the transaction's
 * success continuation, never scheduled alongside it — an ack that can outrun
 * the commit makes the save indicator lie. API Spec §6.3, §11.2; PRD US-PE-3.
 */
export async function processIncomingOperation(
  deps: WritePathDeps,
  hooks: WritePathTestHooks = {},
): Promise<void> {
  const { coordinator, session, msg } = deps;

  if (msg.kind === "opAck" || msg.kind === "opReject") {
    // Unreachable in practice: decodeFrame({ direction: "clientOrigin" }) already rejects both
    // (server->client only, §3.5.7/§3.5.8) before this is ever called — see gateway.ts.
    throw new Error(`processIncomingOperation: ${msg.kind} is server→client only`);
  }

  // Step 4: expand run/batch into individual engine operations FIRST — every rejection path
  // below (steps 1-3) needs to name each operation's own stamp (RejectEntry, API Spec §3.5.8),
  // which requires the expanded per-operation view, not the raw wire message. This reorders
  // the CODE relative to the spec's own step NUMBERING, not its effect: a rejection at any
  // step still needs the same expand-then-name mechanics regardless of which check fired it
  // (matching step 2's own pre-existing precedent, already evaluated after expansion below).
  // DUR-03 site (a) "after frame receipt, before authorization" -- checked at this function's
  // own entry, since every DUR-03 test in this codebase drives processIncomingOperation
  // directly (the same headless-simulated-client pattern Phase 18/21's own DB tests already
  // established as sufficient), so "frame receipt" for those tests IS this call.
  maybeCrash("afterFrameReceipt");

  const ops = toOperations(msg);
  if (ops.length === 0) {
    return;
  }

  // Step 0 (Phase 30, RFC §8.2 (T2), Test Plan SEC-08): "tripping the breaker makes the document
  // READ-ONLY for everyone -- failing CLOSED protects other participants' clients." Checked BEFORE
  // authorization deliberately -- a tripped breaker rejects the document's own OWNER too, which
  // step 1's role check alone would never do. `DOCUMENT_LOCKED` (API Spec §3.5.8, 0x07) was
  // reserved in the enum since Phase 7 and never used until now -- this is exactly the "document
  // state" rejection category its own doc comment names.
  if (coordinator.isCircuitBreakerTripped()) {
    sendOpReject(
      session,
      ops,
      RejectReason.DOCUMENT_LOCKED,
      "this document is read-only: its structure-size circuit breaker has tripped (RFC §8.2)",
    );
    return;
  }

  // Step 1: authorize (API Spec §6.3 line 1). Phase 28's own Goal: enforced on EVERY operation,
  // not just at connect — `coordinator.authorizeSession` re-evaluates `session.role` on every
  // call (through a ≤2s decision cache, SEC-06), and `session.role` itself can now change on an
  // ALREADY-CONNECTED session (`DocumentCoordinator.setSessionRoleLive`/
  // `testOnlySetConnectedSessionRole`), not only affect the next session to join (Phase 24's
  // original `testOnlyQueueRoleOverride`). Real per-user role ASSIGNMENT (who may change whose
  // role, and why) still doesn't reach the WS layer — no real WS identity/ticket-based admission
  // exists yet (Phase 29's own job; see `HelloMessage.ticket`'s own doc comment) — `session.role`
  // is still either the hardcoded EDITOR default every real connection gets, or a test-only
  // override standing in for a permission system this layer can't yet look up by real identity.
  if (!(await coordinator.authorizeSession(session))) {
    // SEC-01's own "security log" requirement: session + document ids on every rejection, not
    // just the OP_REJECT sent back to the sender.
    logger.warn("writePath.authorizationDenied", {
      documentId: coordinator.documentId,
      sessionId: session.sessionId,
      replicaId: session.replicaId,
      role: SessionRole[session.role],
    });
    sendOpReject(
      session,
      ops,
      RejectReason.PERMISSION_DENIED,
      `session role ${SessionRole[session.role]} may not submit operations`,
    );
    return;
  }

  // Step 2: verify stamp.r === session.replica_id. Every operation in one message shares
  // exactly one replica by construction (a run/batch is always minted by ONE local Engine
  // instance) — checking the first operation's id.r is checking all of them.
  //
  // stamp.r is verified against the session's replica id. This is a CORRECTNESS
  // control, not an attribution nicety: a client that could choose its own replica
  // id could mint identifiers colliding with another replica's, violating Engine
  // Spec I1 and breaking convergence itself. RFC §8.3, API Spec §11.8.
  const claimedReplica = ops[0]!.id.r;
  if (claimedReplica !== session.replicaId) {
    // SEC-01/02's own "security log" requirement — see the identical reasoning above.
    logger.warn("writePath.identityMismatch", {
      documentId: coordinator.documentId,
      sessionId: session.sessionId,
      replicaId: session.replicaId,
      claimedReplica,
    });
    sendOpReject(
      session,
      ops,
      RejectReason.IDENTITY_MISMATCH,
      `stamp.r (${claimedReplica}) does not match this session's replica_id (${session.replicaId})`,
    );
    return;
  }

  // Step 3 (Phase 30, RFC §8.2 (T2), Test Plan SEC-08). Counts once per MESSAGE, never per
  // expanded operation -- see RateLimitConfig's own doc comment (config.ts) for why (a large
  // legitimate paste or reconciliation resend must never be rejected for the SIZE of the batch
  // it happens to arrive as one frame).
  const rateResult = coordinator.checkOpRateLimit(session.sessionId);
  if (rateResult !== "ok") {
    logger.warn("writePath.rateLimited", {
      documentId: coordinator.documentId,
      sessionId: session.sessionId,
      replicaId: session.replicaId,
      scope: rateResult,
    });
    sendOpReject(
      session,
      ops,
      RejectReason.RATE_LIMITED,
      `${rateResult === "session" ? "per-session" : "per-document"} rate limit exceeded`,
    );
    if (rateResult === "session" && coordinator.recordRateLimitViolation(session.sessionId)) {
      // SEC-08: "throttles ... then disconnects" -- sustained (not merely one-off) abuse from
      // THIS session specifically disconnects it; a per-document trip never disconnects anyone,
      // since the document budget being exceeded says nothing about which session(s) caused it.
      logger.warn("writePath.rateLimitDisconnect", {
        documentId: coordinator.documentId,
        sessionId: session.sessionId,
        replicaId: session.replicaId,
      });
      session.disconnectForRateLimit?.();
    }
    return;
  }

  // DUR-03 site (b) "after authorization, before engine.applyRemote": every pre-apply
  // validation step (1-3) has now passed, and nothing below has touched the engine yet.
  maybeCrash("afterAuthorization");

  // Step 5: apply to the server's own engine, same order as the wire representation (a
  // run/batch's internal ordering is already causally correct per expand.ts). Applied WITHOUT
  // a GC context here — deliberately: seq is not known yet (Phase 25's own lazy-assignment
  // fix, see this file's header comment), and a delete's GC context is recorded separately,
  // via `Engine.setDeleteContext`, at whichever point (fast or slow path) its real seq is
  // actually assigned.
  //
  // `pendingBefore` snapshots BOTH the identifiers AND the Operation objects themselves,
  // captured before this message's own ops are applied — this is what lets the slow path
  // recover the actual Operation (not just its id) for anything that drains as a SIDE EFFECT
  // of this message, since `engine.pending` is mutated in place and the departed object would
  // otherwise be unrecoverable after the fact.
  const pendingBefore = new Map<string, Operation>();
  for (const p of coordinator.engine.pending) {
    pendingBefore.set(serializeId(p.id), p);
  }

  const applyResults: Array<{ op: Operation; buffered: boolean }> = [];
  for (const op of ops) {
    const { buffered } = coordinator.engine.applyRemote(op);
    applyResults.push({ op, buffered });
    if (buffered) {
      coordinator.pendingOpOrigin.set(serializeId(op.id), {
        sessionId: session.sessionId,
        userId: session.userId,
        displayName: session.displayName,
        replicaId: session.replicaId,
      });
    }
  }

  // DUR-03 site (c) "after applyRemote, before sequence assignment": no seq has been assigned
  // yet in either path at this point.
  maybeCrash("afterApplyRemote");

  const stillPendingIds = new Set(coordinator.engine.pending.map((p) => serializeId(p.id)));
  const sideEffectResolved: Operation[] = [];
  for (const [id, op] of pendingBefore) {
    if (!stillPendingIds.has(id)) {
      sideEffectResolved.push(op);
    }
  }

  const allThisMessageReady = applyResults.every((r) => !r.buffered);

  if (allThisMessageReady && sideEffectResolved.length === 0) {
    await runFastPath({ coordinator, session, msg, ops }, hooks);
    return;
  }

  await runSlowPath({ coordinator, session, applyResults, sideEffectResolved });
}

/**
 * The common case, unchanged in behavior (down to `maybeCrash` site placement) from before
 * Phase 25's DUR-06 fix: every operation in `ops` was already confirmed ready by the caller.
 * Steps 6-9 (API Spec §6.3), exactly as originally implemented.
 */
async function runFastPath(
  deps: {
    coordinator: DocumentCoordinator;
    session: CoordinatorSession;
    msg: ClientOpsMessage;
    ops: readonly Operation[];
  },
  hooks: WritePathTestHooks,
): Promise<void> {
  const { coordinator, session, msg, ops } = deps;

  // Step 5/6, reordered relative to their numbering but not their EFFECT: `startSeq` is
  // computed (not yet committed to `coordinator.currentSeq`) here, and each operation's seq is
  // threaded into `Engine.setDeleteContext` for GC (Phase 21, Engine Spec §7.3) — a Delete's
  // causal-stability check needs to know its OWN seq. Still fully synchronous end to end (no
  // `await` between reading `coordinator.currentSeq` and advancing it below), so the "no other
  // write path can interleave here" monotonicity argument this step's own original comment
  // made is unaffected.
  const startSeq = coordinator.currentSeq + 1n;
  const appliedAtMs = Date.now();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.kind === "delete") {
      coordinator.engine.setDeleteContext(op.id, { seq: startSeq + BigInt(i), atMs: appliedAtMs });
    }
  }

  // Step 6: assign seq. PER OPERATION, not per frame — operations.seq is the operations
  // table's own PRIMARY KEY column (Phase 15, API Spec §2.6), and each row identifies exactly
  // one operation's stamp (operations_stamp_uq is a unique index on (document_id, stamp_r,
  // stamp_c), both singular columns) — there is no way to represent N operations sharing one
  // seq as one row. A run/batch of N operations therefore consumes N consecutive seq values;
  // the relayed/acked seq below is the STARTING seq of that range, not a single shared value.
  coordinator.currentSeq += BigInt(ops.length);

  // DUR-03 site (d) "after sequence assignment, before broadcast": `coordinator.currentSeq`
  // is now advanced, but no peer has been told anything yet.
  maybeCrash("afterSeqAssignment");

  // Step 7: BROADCAST to peers, BEFORE the transaction below. The relay keeps msg's ORIGINAL
  // compact run/batch wire shape — never expanded into individual OP_INSERT frames — only its
  // `seq` field changes, to the range's start. No `await` has happened yet at this point, so
  // this and every step above ran fully synchronously since the message was received (Node's
  // single-threaded event loop guarantees no other message's write path can interleave here) —
  // that's what keeps `coordinator.currentSeq` monotonic across concurrent senders without
  // needing an explicit per-document lock.
  const relay: ClientOpsMessage = { ...msg, seq: Number(startSeq) };
  const relayBytes = encodeFrame(relay);
  for (const other of coordinator.otherSessions(session.sessionId)) {
    other.queues.enqueue("ops", relayBytes);
  }

  // DUR-03 site (e) "after broadcast, before BEGIN TRANSACTION": peers have already integrated
  // this operation (the exact "CORRECT and EXPECTED" scenario the reference text names --
  // the originating client never got an ack, so it's still in its own durable queue and
  // resends on reconnection).
  maybeCrash("afterBroadcast");

  const mutated = isAckBeforeCommitMutationActive();
  const ackEntries: AckEntry[] = ops.map((op, i) => ({
    ackSeq: Number(startSeq) + i,
    ackedId: op.id,
  }));

  if (mutated) {
    // MUTATED ORDERING (DUR-04's negative control): ack is queued BEFORE the transaction even
    // starts. Never active outside durability.db.test.ts's own DUR-04 test.
    session.ackBatcher.add(ackEntries);
    hooks.simulateCrashAtCommitPoint?.();
  }

  // Step 8, enqueued through the per-document commit queue (Phase 25, DUR-06 fix's own
  // follow-up finding) rather than called directly — `enqueueCommit` itself is synchronous
  // (it only schedules `fn` onto the queue's tail; nothing has awaited yet since the seq bump
  // above), which is what keeps commit EXECUTION order pinned to seq RESERVATION order even
  // when this call's own `await` below is racing against some OTHER message's write path for
  // the same document. See DocumentCoordinator.enqueueCommit's own doc comment for the full
  // hand-traced reasoning (two-author interleaving producing a permanently-skipped CATCHUP
  // row) this exists to close.
  const commitPromise = coordinator.enqueueCommit(coordinator.currentSeq, () =>
    coordinator.operationStore.commitOperations({
      documentId: coordinator.documentId,
      startSeq,
      ops,
      authorSession: session.sessionId,
      authorUser: session.userId,
      replicaId: session.replicaId,
      displayName: session.displayName,
    }),
  );
  try {
    // Resolves only once the transaction has actually committed.
    await commitPromise;
  } catch (err) {
    logger.error("writePath.commitFailed", {
      documentId: coordinator.documentId,
      sessionId: session.sessionId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    // No ack for a commit that failed (real ordering only reaches here before ever queuing
    // one) — matching DUR-04's own reasoning: the commit never happened, so the client
    // correctly never receives an ack, and will retry on reconnect (Phase 10's existing
    // unacked-queue behavior). Nothing more to do this phase.
    return;
  }

  if (!mutated) {
    // Step 9, REAL ORDERING — the commit above has ALREADY happened by the time this line
    // runs, which is the entire point: nothing from here on can un-durable it.
    hooks.simulateCrashAtCommitPoint?.();

    // DUR-03 site (g) "after COMMIT, before OP_ACK is emitted": the row is durably committed
    // but no ack has been queued yet — the reference text's own "durably committed but the
    // client was never told" scenario, resolved on reconnect by ALREADY_HAVE/operations_stamp_uq.
    maybeCrash("afterCommit");

    session.ackBatcher.add(ackEntries);

    // DUR-03 site (h) "after OP_ACK, before the client processes it": interpreted as
    // immediately after the ack has been handed to AckBatcher (queued for send) — the
    // furthest point reachable synchronously in this process without waiting on a real network
    // round trip to the client, which is the only thing "before the client processes it" could
    // still mean once the ack has already been queued for transmission.
    maybeCrash("afterAck");
  }

  // Not one of API Spec §6.3's nine steps — this project's own addition, RFC §13.2's
  // MAYBE-SNAPSHOT() (Phase 17). Reached only once the commit above has actually succeeded.
  // Deliberately NOT awaited: scheduling is synchronous and cheap (two field reads, one
  // comparison), and any actual snapshot work it triggers is deferred off this function's own
  // completion entirely (snapshotter.ts) — this line must never be what makes
  // processIncomingOperation take longer to resolve.
  maybeScheduleSnapshot(coordinator, ops.length);

  // Also not one of the nine steps -- Phase 30 (RFC §8.2 (T2)). Re-evaluated reactively, right
  // after a real commit, so the breaker trips the moment a commit ACTUALLY crosses the ceiling
  // rather than on some later polling interval. Cheap: `engine.stats()` is O(1).
  coordinator.evaluateCircuitBreaker();
}

function toWireMessage(op: Operation, seq: number): OpInsertMessage | OpDeleteMessage | OpUndeleteMessage {
  switch (op.kind) {
    case "insert":
      return operationToOpInsert(op, seq);
    case "delete":
      return operationToOpDelete(op, seq);
    case "undelete":
      return operationToOpUndelete(op, seq);
  }
}

interface FinalizeItem {
  readonly op: Operation;
  readonly origin: PendingOpOrigin;
  seq: bigint;
}

/**
 * The DUR-06-fix path: at least one operation in this message was buffered, or applying this
 * message's own operations resolved some OTHER, previously-buffered operation as a side
 * effect. Nothing in `applyResults`/`sideEffectResolved` has been broadcast, committed, or
 * acked yet — this function is the only place that happens, for exactly the operations that
 * are actually ready RIGHT NOW, never for one still sitting in `engine.pending`.
 */
async function runSlowPath(deps: {
  coordinator: DocumentCoordinator;
  session: CoordinatorSession;
  applyResults: ReadonlyArray<{ op: Operation; buffered: boolean }>;
  sideEffectResolved: readonly Operation[];
}): Promise<void> {
  const { coordinator, session, applyResults, sideEffectResolved } = deps;

  const toFinalize: Array<Omit<FinalizeItem, "seq">> = [];
  const thisMessageOrigin: PendingOpOrigin = {
    sessionId: session.sessionId,
    userId: session.userId,
    displayName: session.displayName,
    replicaId: session.replicaId,
  };
  for (const { op, buffered } of applyResults) {
    if (!buffered) {
      toFinalize.push({ op, origin: thisMessageOrigin });
    }
  }
  for (const op of sideEffectResolved) {
    const key = serializeId(op.id);
    const origin = coordinator.pendingOpOrigin.get(key);
    coordinator.pendingOpOrigin.delete(key);
    if (!origin) {
      // Should not happen for anything that was ever live in `engine.pending` on this
      // process (every buffering `applyRemote` call above records an origin first) — a
      // defensive guard, not an expected path. Logged, not thrown: the operation is already
      // structurally integrated into the engine regardless, so refusing to finalize it would
      // just create a second, worse bug (a node peers can never learn about).
      logger.error("writePath.missingPendingOrigin", {
        documentId: coordinator.documentId,
        opId: key,
      });
      continue;
    }
    toFinalize.push({ op, origin });
  }

  if (toFinalize.length === 0) {
    // This message's own operation(s) all buffered, and nothing else resolved as a side
    // effect — nothing to broadcast/commit/ack yet. The offline-window sweep
    // (offlineWindowScheduler.ts) is what eventually rejects this if it never resolves.
    return;
  }

  // Assign seq LAZILY, synchronously, in one pass with no `await` — see this file's header
  // comment for why this must never race ahead of a still-buffered lower-seq operation.
  const appliedAtMs = Date.now();
  let seq = coordinator.currentSeq;
  const finalized: FinalizeItem[] = [];
  for (const item of toFinalize) {
    seq += 1n;
    if (item.op.kind === "delete") {
      coordinator.engine.setDeleteContext(item.op.id, { seq, atMs: appliedAtMs });
    }
    finalized.push({ ...item, seq });
  }
  coordinator.currentSeq = seq;

  // Broadcast each finalized operation individually — a mixed-readiness batch has no single
  // compact run/batch wire shape left to relay (protocol/src/catchupOps.ts already established
  // this exact single-operation frame shape for CATCHUP_CHUNK; reused here).
  for (const item of finalized) {
    const bytes = encodeFrame(toWireMessage(item.op, Number(item.seq)));
    for (const other of coordinator.otherSessions(item.origin.sessionId)) {
      other.queues.enqueue("ops", bytes);
    }
  }

  // Enqueue EVERY finalized item's commit synchronously, in one tight loop, BEFORE awaiting any
  // of them (Phase 25, DUR-06 fix's own follow-up finding). This is the load-bearing property:
  // enqueueing here happens in the exact same synchronous stretch as the seq assignment above
  // (no `await` anywhere in between, for any item) — so enqueue order, and therefore commit
  // EXECUTION order (DocumentCoordinator.enqueueCommit serializes strictly FIFO), is provably
  // identical to seq order regardless of how many items or distinct authors are in `finalized`,
  // and regardless of what any OTHER concurrently-processing message for this same document
  // does in between. Awaiting them one at a time, in order, below is what preserves this file's
  // existing "ack only after ITS OWN commit resolves" guarantee — it does not reintroduce the
  // ordering risk, since the actual DB writes are already pinned to the right order by the time
  // any of these awaits even begin.
  const commitPromises = finalized.map((item) =>
    coordinator.enqueueCommit(item.seq, () =>
      coordinator.operationStore.commitOperations({
        documentId: coordinator.documentId,
        startSeq: item.seq,
        ops: [item.op],
        authorSession: item.origin.sessionId,
        authorUser: item.origin.userId,
        replicaId: item.origin.replicaId,
        displayName: item.origin.displayName,
      }),
    ),
  );

  for (let i = 0; i < finalized.length; i++) {
    const item = finalized[i]!;
    try {
      await commitPromises[i];
    } catch (err) {
      logger.error("writePath.commitFailed", {
        documentId: coordinator.documentId,
        sessionId: item.origin.sessionId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      continue; // no ack for a commit that failed — same reasoning as the fast path.
    }
    const liveSession = coordinator.getSession(item.origin.sessionId);
    if (liveSession) {
      liveSession.ackBatcher.add([{ ackSeq: Number(item.seq), ackedId: item.op.id }]);
    }
  }

  maybeScheduleSnapshot(coordinator, finalized.length);
  coordinator.evaluateCircuitBreaker();
}
