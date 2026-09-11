// Phase 24 — the server-side half of Rule 7.2's "explicit rejection" (Engine
// Spec §7.6), the piece Phase 21's tombstone GC explicitly left unbuilt: a
// still-BUFFERED (pending, Engine Spec §4.2) operation whose missing origin
// can never resolve — because Phase 21's GC has since physically removed it
// from the live structure (Test Plan RC-30's own wording: "operations whose
// anchors were collected") — must be explicitly rejected
// (OFFLINE_WINDOW_EXCEEDED, API Spec §3.5.8 code 0x06), not left sitting in
// `engine.pending` forever.
//
// A NOTE ON "absent from the log" (Scope-IN's own wording for this
// mechanism): read literally against the DURABLE `operations` table, this
// condition can never fire once an origin has ever been committed — Phase
// 21's own account is explicit that table "is NEVER pruned," so a
// garbage-collected node's own INSERT row lives on forever there. What
// actually distinguishes a permanently-stuck pending operation from an
// ordinary, momentarily-out-of-order one (a completely normal occurrence in
// live concurrent editing — see writePath.ts's own step 5 comment) is NOT
// durable-log membership at all: EVERY pending operation's missing origin
// is, by construction, currently absent from the LIVE ENGINE (that is
// exactly what "pending" means) — durable-log membership cannot add any
// discriminating power on top of that, since readiness is decided purely
// against in-memory structure (Engine Spec §4.2), never against the log.
// The ONLY signal actually available is elapsed TIME, exactly Scope-IN's
// own literal number: a pending operation still unresolved after 30 real
// seconds is treated as permanently stuck (ordinary network reordering
// resolves in milliseconds; nothing in this system's design produces a
// pending operation that legitimately needs tens of seconds to resolve on
// its own). This is a deliberate, disclosed interpretation of the spec
// text's own wording — the same "reasonable, defensible, disclosed"
// latitude this project has taken for prior spec-text ambiguities (Phase
// 8's documentId binding, Phase 9's WELCOME roster, Phase 23's own
// "absent from the log" wording for ALREADY_HAVE, a differently-scoped
// check that genuinely IS a durable-log lookup).
//
// Runs IN-PROCESS, once per open document, on a fixed interval — the same
// shape as gcScheduler.ts/auditScheduler.ts (Phase 18/21): this is the one
// place with direct in-memory access to each coordinator's own live
// `engine.pending`.
//
// Phase 30 (RFC §8.7, Test Plan SEC-11i) extends this SAME sweep with a SIZE bound, independent
// of the age bound above: "the causal buffer is bounded in size AND age ... discarded with a
// logged warning, not accumulated." One scheduler, one pass over `engine.pending`, two related
// (but independently-triggerable) eviction reasons — see this file's own size-bound block near
// the end of `runOneDocument` for the full reasoning.

import { serializeId, type Operation } from "@collab-editor/engine";
import { RejectReason } from "@collab-editor/protocol";
import { DEFAULT_MAX_PENDING_PER_DOCUMENT, type OfflineWindowConfig } from "./config.js";
import type { CoordinatorSession, DocumentCoordinator } from "./documentCoordinator.js";
import type { Gateway } from "./gateway.js";
import { logger } from "./logger.js";
import { sendOpReject } from "./writePath.js";

export interface OfflineWindowScheduler {
  stop(): void;
}

/** Starts a recurring timer that sweeps every open document (`gateway.coordinators`) every `config.sweepIntervalMs`. A document with no open coordinator (nobody connected) is simply not swept — mirrors gcScheduler.ts/auditScheduler.ts's own identical scoping decision. */
export function startOfflineWindowScheduler(
  gateway: Gateway,
  config: OfflineWindowConfig,
): OfflineWindowScheduler {
  const timer = setInterval(() => {
    runAllOpenDocuments(gateway, config);
  }, config.sweepIntervalMs);
  // Same reasoning as every other in-process scheduler in this codebase: never keep the Node
  // process alive solely for this timer, so tests can construct many gateways and exit cleanly.
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

function runAllOpenDocuments(gateway: Gateway, config: OfflineWindowConfig): void {
  for (const coordinator of gateway.coordinators.values()) {
    runOneDocument(coordinator, config);
  }
}

/**
 * Exported directly (not only reachable via the timer) so tests can trigger exactly one sweep
 * deterministically instead of waiting on `sweepIntervalMs` or faking timers — the same
 * pattern `gcScheduler.ts`'s `runOneDocument` already established. Entirely synchronous and
 * in-memory: unlike `gcScheduler.ts`'s own `runOneDocument`, this never awaits a database
 * query (nothing here needs one — see this file's own header comment for why durable-log
 * membership adds no discriminating power for this specific decision).
 */
export function runOneDocument(coordinator: DocumentCoordinator, config: OfflineWindowConfig): void {
  const nowMs = Date.now();
  const stillPending = new Set<string>();
  const toRejectBySession = new Map<string, { session: CoordinatorSession; ops: Operation[] }>();

  // A SNAPSHOT, not a live reference: `engine.rejectPending()` below splices `engine.pending`
  // in place, so iterating that array directly while also mutating it would skip elements
  // (a classic "shift during iteration" bug — found by this file's own test suite, not by
  // review: a 3-item batch evicted only 2, silently leaving the middle element stuck forever).
  for (const op of [...coordinator.engine.pending]) {
    const key = serializeId(op.id);
    stillPending.add(key);

    const firstSeen = coordinator.pendingFirstSeenAtMs.get(key);
    if (firstSeen === undefined) {
      // Just noticed this tick — give it the FULL grace window before ever considering
      // eviction, regardless of how long it might already have silently sat in `engine.pending`
      // before this coordinator's very first sweep ever ran (e.g. right after a warm start).
      coordinator.pendingFirstSeenAtMs.set(key, nowMs);
      continue;
    }
    if (nowMs - firstSeen < config.pendingRejectTimeoutMs) {
      continue; // still within the grace window — an entirely normal, momentary delay
    }

    const session = coordinator.getSessionByReplicaId(op.id.r);
    if (!session) {
      // The originating replica is no longer connected. Still evict from `pending` below (it
      // can never resolve, and Rule 7.2 forbids leaving it there indefinitely regardless of
      // whether anyone is currently listening) — but there is no live socket to notify.
      // Disclosed gap, not silently swallowed: a client that reconnects LATER learns nothing
      // about this specific stamp's fate from this mechanism (only from the fact that the
      // content it queued never actually appears) — closing that gap for a since-disconnected
      // session is out of this phase's own DoD scope (RC-30's own scenario has the client
      // already reconnected by the time this fires).
      logger.warn("offlineWindow.rejectedWithNoSession", {
        documentId: coordinator.documentId,
        replicaId: op.id.r,
        opId: key,
      });
      coordinator.engine.rejectPending(op.id);
      coordinator.pendingFirstSeenAtMs.delete(key);
      coordinator.pendingOpOrigin.delete(key);
      continue;
    }

    const bucket = toRejectBySession.get(session.sessionId);
    if (bucket) {
      bucket.ops.push(op);
    } else {
      toRejectBySession.set(session.sessionId, { session, ops: [op] });
    }
    coordinator.engine.rejectPending(op.id);
    coordinator.pendingFirstSeenAtMs.delete(key);
    coordinator.pendingOpOrigin.delete(key);
  }

  // Prune tracking entries for operations that drained normally (their dependency arrived, and
  // writePath.ts's own "slow path" already finalized and deleted its own pendingOpOrigin entry)
  // since the last sweep — otherwise these maps would grow forever for a healthy, busy document.
  for (const key of coordinator.pendingFirstSeenAtMs.keys()) {
    if (!stillPending.has(key)) {
      coordinator.pendingFirstSeenAtMs.delete(key);
    }
  }
  for (const key of coordinator.pendingOpOrigin.keys()) {
    if (!stillPending.has(key)) {
      coordinator.pendingOpOrigin.delete(key);
    }
  }

  // One OP_REJECT per session for this whole sweep tick, not one per operation — mirrors
  // RC-32's own "in one response" requirement, applied here too for consistency, even though
  // RC-30's own DoD doesn't literally require batching for this specific reason code.
  for (const { session, ops } of toRejectBySession.values()) {
    logger.warn("offlineWindow.rejected", {
      documentId: coordinator.documentId,
      sessionId: session.sessionId,
      replicaId: session.replicaId,
      count: ops.length,
    });
    sendOpReject(
      session,
      ops,
      RejectReason.OFFLINE_WINDOW_EXCEEDED,
      `${ops.length} operation(s) buffered longer than ${config.pendingRejectTimeoutMs}ms with an unresolvable origin (Engine Spec §7.6)`,
    );
  }

  // Phase 30 (RFC §8.7, Test Plan SEC-11i) — the SIZE half of "bounded in size and age," checked
  // on a FRESH snapshot of whatever is left after the age-based pass above already ran (the two
  // are independent conditions, not a priority order — an operation can be evicted for being too
  // OLD, too NUMEROUS, or both). Evicts the OLDEST remaining entries first (by
  // `pendingFirstSeenAtMs`, falling back to "now" for one this exact tick just started tracking —
  // never possible for it to be the oldest, so the fallback value is never actually load-bearing)
  // until back at or under `config.maxPendingPerDocument`, regardless of how much of their own
  // age-based grace period each one still has left — RFC §8.7 bounds the buffer's SIZE
  // unconditionally, not "size, but only for operations already old enough to be suspicious."
  const maxPendingPerDocument = config.maxPendingPerDocument ?? DEFAULT_MAX_PENDING_PER_DOCUMENT;
  const stillPendingSnapshot = [...coordinator.engine.pending];
  const overflow = stillPendingSnapshot.length - maxPendingPerDocument;
  if (overflow > 0) {
    const oldestFirst = stillPendingSnapshot
      .map((op) => ({
        op,
        firstSeen: coordinator.pendingFirstSeenAtMs.get(serializeId(op.id)) ?? nowMs,
      }))
      .sort((a, b) => a.firstSeen - b.firstSeen)
      .slice(0, overflow);
    for (const { op } of oldestFirst) {
      const key = serializeId(op.id);
      logger.warn("offlineWindow.causalBufferOverflow", {
        documentId: coordinator.documentId,
        opId: key,
        pendingSize: stillPendingSnapshot.length,
        maxPendingPerDocument,
      });
      coordinator.engine.rejectPending(op.id);
      coordinator.pendingFirstSeenAtMs.delete(key);
      coordinator.pendingOpOrigin.delete(key);
      const session = coordinator.getSessionByReplicaId(op.id.r);
      if (session) {
        // Reuses RATE_LIMITED (API Spec §3.5.8, 0x05) rather than a new reason code — a
        // capacity-driven eviction IS a rate/load-protection rejection in every sense that
        // matters to a client receiving it, and this project's own RejectReason enum doc comment
        // (messages.ts) reserves new codes strictly for genuinely distinct rejection CATEGORIES,
        // not a second name for the same one.
        sendOpReject(
          session,
          [op],
          RejectReason.RATE_LIMITED,
          `document's causal buffer capacity (${maxPendingPerDocument}) exceeded (RFC §8.7)`,
        );
      }
    }
  }
}
