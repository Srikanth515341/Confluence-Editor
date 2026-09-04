// API/Protocol/Data Spec v1.0 §6.3's write path, implemented line for
// line, plus the DUR-04 mutation switch (Test Plan DUR-04). This is the
// single most consequential ordering decision in the system (Phase 16's
// own framing): get the broadcast/commit/ack ordering wrong and either
// M4 latency or M2 durability breaks.
//
//   1. authorize (Phase 24: a real, minimal role check -- session.role !== VIEWER; full
//      authorization beyond that single check is still Phase 28)
//   2. verify stamp.r === session.replica_id
//   3. rate check (stubbed until Phase 30)
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

import type { Operation } from "@collab-editor/engine";
import {
  encodeFrame,
  RejectReason,
  SessionRole,
  type AckEntry,
  type OpsMessage,
  type RejectEntry,
} from "@collab-editor/protocol";
import type { CoordinatorSession, DocumentCoordinator } from "./documentCoordinator.js";
import { toOperations } from "./ingest.js";
import { logger } from "./logger.js";
import { maybeScheduleSnapshot } from "./snapshotter.js";

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

/**
 * Step 1: authorize. Phase 24 gives this its first REAL (if still minimal) check: a session
 * whose role is VIEWER may never mutate the document (RC-32, API Spec §5.4/§5.5). Real role
 * ASSIGNMENT — who may change whose role, and why — remains Phase 26-30's job; `session.role`
 * itself is still either the hardcoded EDITOR default every real connection gets, or a
 * Phase-24-test-only override (`DocumentCoordinator.testOnlyQueueRoleOverride`, RC-32's own
 * stand-in for a permission system that doesn't exist yet).
 */
function authorize(session: CoordinatorSession): boolean {
  return session.role !== SessionRole.VIEWER;
}

/** Step 3: rate check. Stubbed until Phase 30. Always allows. */
function rateCheckStub(_session: CoordinatorSession): boolean {
  return true;
}

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
  const ops = toOperations(msg);
  if (ops.length === 0) {
    return;
  }

  // Step 1: authorize.
  if (!authorize(session)) {
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
  const claimedReplica = ops[0]!.id.r;
  if (claimedReplica !== session.replicaId) {
    sendOpReject(
      session,
      ops,
      RejectReason.IDENTITY_MISMATCH,
      `stamp.r (${claimedReplica}) does not match this session's replica_id (${session.replicaId})`,
    );
    return;
  }

  // Step 3.
  if (!rateCheckStub(session)) {
    sendOpReject(session, ops, RejectReason.RATE_LIMITED, "rate limit exceeded");
    return;
  }

  // Step 5/6, reordered relative to their numbering but not their EFFECT: `startSeq` is
  // computed (not yet committed to `coordinator.currentSeq`) BEFORE applying, so each
  // operation's seq is known AT apply time and can be threaded into `applyRemote`'s optional
  // GC context (Phase 21, Engine Spec §7.3) — a Delete's causal-stability check needs to know
  // its OWN seq, which didn't exist yet under the original apply-then-assign order. Still
  // fully synchronous end to end (no `await` between reading `coordinator.currentSeq` and
  // advancing it below), so the "no other write path can interleave here" monotonicity
  // argument this step's own original comment made is unaffected.
  //
  // Step 5: apply to the server's own engine, same order as the wire representation (a
  // run/batch's internal ordering is already causally correct per expand.ts). `atMs` is
  // wall-clock time ONLY the server ever supplies — packages/engine itself never reads a
  // clock (Engine Spec C9); this is server code, outside that purity boundary.
  const startSeq = coordinator.currentSeq + 1n;
  const appliedAtMs = Date.now();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    coordinator.engine.applyRemote(op, { seq: startSeq + BigInt(i), atMs: appliedAtMs });
  }

  // Step 6: assign seq. PER OPERATION, not per frame — operations.seq is the operations
  // table's own PRIMARY KEY column (Phase 15, API Spec §2.6), and each row identifies exactly
  // one operation's stamp (operations_stamp_uq is a unique index on (document_id, stamp_r,
  // stamp_c), both singular columns) — there is no way to represent N operations sharing one
  // seq as one row. A run/batch of N operations therefore consumes N consecutive seq values;
  // the relayed/acked seq below is the STARTING seq of that range, not a single shared value.
  coordinator.currentSeq += BigInt(ops.length);

  // Step 7: BROADCAST to peers, BEFORE the transaction below. The relay keeps msg's ORIGINAL
  // compact run/batch wire shape — never expanded into individual OP_INSERT frames — only its
  // `seq` field changes, to the range's start. No `await` has happened yet at this point, so
  // this and every step above ran fully synchronously since the message was received (Node's
  // single-threaded event loop guarantees no other message's write path can interleave here) —
  // that's what keeps `coordinator.currentSeq` monotonic across concurrent senders without
  // needing an explicit per-document lock.
  const relay: OpsMessage = { ...msg, seq: Number(startSeq) };
  const relayBytes = encodeFrame(relay);
  for (const other of coordinator.otherSessions(session.sessionId)) {
    other.queues.enqueue("ops", relayBytes);
  }

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

  try {
    // Step 8. Resolves only once the transaction has actually committed.
    await coordinator.operationStore.commitOperations({
      documentId: coordinator.documentId,
      startSeq,
      ops,
      authorSession: session.sessionId,
      authorUser: session.userId,
      replicaId: session.replicaId,
      displayName: session.displayName,
    });
  } catch (err) {
    logger.error("writePath.commitFailed", {
      documentId: coordinator.documentId,
      sessionId: session.sessionId,
      message: err instanceof Error ? err.message : String(err),
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
    session.ackBatcher.add(ackEntries);
  }

  // Not one of API Spec §6.3's nine steps — this project's own addition, RFC §13.2's
  // MAYBE-SNAPSHOT() (Phase 17). Reached only once the commit above has actually succeeded.
  // Deliberately NOT awaited: scheduling is synchronous and cheap (two field reads, one
  // comparison), and any actual snapshot work it triggers is deferred off this function's own
  // completion entirely (snapshotter.ts) — this line must never be what makes
  // processIncomingOperation take longer to resolve.
  maybeScheduleSnapshot(coordinator, ops.length);
}
