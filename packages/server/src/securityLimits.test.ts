// Phase 30 — Rate limiting, circuit breaker, and the security suite (RFC §8.2 (T2), §8.7, §8.8;
// API Spec §3.5.8; Test Plan SEC-08/09/10/11h/11i). This file covers everything provable with an
// in-memory `DocumentCoordinator`/`CoordinatorSession` fixture and no real Postgres/WebSocket —
// the same pattern writePath.test.ts (Phase 24) and permissions.test.ts (Phase 28) already
// established for their own new server-side mechanisms. Connection-level (per-IP) limiting needs a
// real WebSocket server and lives in gateway.test.ts instead.

import { describe, expect, it } from "vitest";
import { Engine, type InsertOperation, type Operation } from "@collab-editor/engine";
import {
  decodeFrame,
  encodeFrame,
  operationToOpDelete,
  operationToOpInsert,
  RejectReason,
  SessionRole,
  type OpRejectMessage,
  type OpsMessage,
} from "@collab-editor/protocol";
import { AckBatcher } from "./ackBatcher.js";
import { ConnectionSendQueues } from "./sendQueues.js";
import { DocumentCoordinator, type CoordinatorSession } from "./documentCoordinator.js";
import { InMemoryOperationStore } from "./db/operationStore.js";
import { processIncomingOperation } from "./writePath.js";

function buildTestSession(
  replicaId: number,
  role: SessionRole,
  sent: Uint8Array[],
  extra: Partial<CoordinatorSession> = {},
): CoordinatorSession {
  return {
    sessionId: `session-${replicaId}`,
    replicaId,
    queues: new ConnectionSendQueues(
      (frame) => {
        sent.push(frame);
        return Promise.resolve();
      },
      () => false,
    ),
    ackBatcher: new AckBatcher(() => {}),
    role,
    userId: `user-${replicaId}`,
    displayName: `Guest ${replicaId}`,
    lastPingAt: Date.now(),
    presenceStale: false,
    staleTimer: undefined,
    receivedFrameCount: 0,
    ...extra,
  };
}

function rejectReasons(sent: readonly Uint8Array[]): RejectReason[] {
  return sent
    .map((f) => decodeFrame(f, { direction: "serverOrigin" }))
    .filter((m): m is OpRejectMessage => m.kind === "opReject")
    .flatMap((m) => m.rejects.map((r) => r.reason));
}

describe("SEC-08 — per-session and per-document op rate limiting (RFC §8.2 (T2))", () => {
  it("checkOpRateLimit throttles per-session at its own cap, and the per-document budget trips independently of it", () => {
    const coordinator = new DocumentCoordinator("doc-rl-1", new InMemoryOperationStore(), undefined, undefined, {
      rateLimit: {
        perSessionRule: { max: 2, windowMs: 1000 },
        perSessionDisconnectRule: { max: 100, windowMs: 1000 },
        perDocumentRule: { max: 3, windowMs: 1000 },
      },
    });
    const t0 = 1_000_000;
    // s1's own first two messages: both under its OWN cap of 2, and (combined) under the
    // document's shared cap of 3.
    expect(coordinator.checkOpRateLimit("s1", t0)).toBe("ok");
    expect(coordinator.checkOpRateLimit("s1", t0)).toBe("ok");
    // s1's THIRD message exceeds its own per-session cap -- the document limiter is never even
    // consulted for this call (a session-scope violation is reported as "session", not "document",
    // regardless of how much document budget remains).
    expect(coordinator.checkOpRateLimit("s1", t0)).toBe("session");

    // A DIFFERENT session, s2, is still entirely within ITS OWN per-session cap (this is only
    // its first message) -- yet the SHARED per-document budget (already at 2 from s1's own two
    // successes) trips on s2's second message, proving the two limiters are genuinely
    // independent: s2 alone never came close to violating its own per-session rule.
    expect(coordinator.checkOpRateLimit("s2", t0)).toBe("ok"); // document count now 3 (at its cap)
    expect(coordinator.checkOpRateLimit("s2", t0)).toBe("document"); // document count would be 4 > 3
  });

  it("recordRateLimitViolation reports 'disconnect' once REJECTION VOLUME crosses perSessionDisconnectRule within a rolling window -- a single rejected message never disconnects anything by itself, and it is NOT reset by an accepted message in between", () => {
    // Redesigned after a real empirical measurement (this project's own SEC-08 attack, run
    // against the real rate limiter) found the ORIGINAL "continuous, zero-acceptance streak"
    // design structurally unreachable: a limiter that is successfully THROTTLING an attacker, by
    // design, keeps admitting messages at its own configured rate forever, and every acceptance
    // used to reset the streak clock to zero. See RateLimitConfig.perSessionDisconnectRule's own
    // doc comment (config.ts) for the full account.
    const coordinator = new DocumentCoordinator("doc-rl-2", new InMemoryOperationStore(), undefined, undefined, {
      rateLimit: {
        perSessionRule: { max: 1000, windowMs: 1000 }, // never itself the bottleneck in this test
        perSessionDisconnectRule: { max: 3, windowMs: 1000 },
        perDocumentRule: { max: 1000, windowMs: 1000 },
      },
    });
    const t0 = 2_000_000;
    // Three violations within the same 1s window: the first two are still within budget (a
    // rejection COUNT of 1, then 2, both <= max=3); the THIRD is what actually pushes the
    // session's own violation count to 4 > 3 -- that's the one that reports "disconnect".
    expect(coordinator.recordRateLimitViolation("s1", t0)).toBe(false);
    expect(coordinator.recordRateLimitViolation("s1", t0 + 10)).toBe(false);
    expect(coordinator.recordRateLimitViolation("s1", t0 + 20)).toBe(false);
    expect(coordinator.recordRateLimitViolation("s1", t0 + 30)).toBe(true);

    // A DIFFERENT session's own violations are tracked entirely independently.
    expect(coordinator.recordRateLimitViolation("s2", t0)).toBe(false);

    // Once the window ages out (real time passing, not an accepted message), the count drops
    // back down -- a session whose abuse genuinely stops eventually recovers.
    expect(coordinator.recordRateLimitViolation("s1", t0 + 5000)).toBe(false);
  });

  it("recordRateLimitViolation does NOT disconnect a session that is throttled but whose violations never accumulate past the threshold within any rolling window -- a legitimate, moderately-over-cap burst", () => {
    // Hand-traced case: a client sending individual (non-batchable) messages at a rate
    // MODESTLY over its own cap -- e.g. a burst of fast, un-coalescible edits -- accumulates
    // violations at (actualRate - cap), never the FULL send rate. This must stay well under the
    // disconnect threshold, unlike the real SEC-08 attack shape (500+/s), which overwhelms it.
    const coordinator = new DocumentCoordinator("doc-rl-2b", new InMemoryOperationStore(), undefined, undefined, {
      rateLimit: {
        perSessionRule: { max: 200, windowMs: 1000 },
        perSessionDisconnectRule: { max: 200, windowMs: 1000 }, // this project's own real default
        perDocumentRule: { max: 100_000, windowMs: 1000 },
      },
    });
    const t0 = 3_000_000;
    // Simulates ~250 msgs/s for 2 real seconds: the first 200 in each 1s window pass (never
    // reaching recordRateLimitViolation at all -- only checkOpRateLimit's own "session" result
    // does), and only the EXCESS (~50/s) are violations. Directly drive recordRateLimitViolation
    // at that excess rate to prove it alone never crosses 200 within any window.
    let disconnected = false;
    for (let i = 0; i < 100; i++) {
      // 50 violations/s for 2s = 100 total, spread evenly -- never more than ~50 within any
      // rolling 1000ms slice of this loop.
      const nowMs = t0 + i * 20;
      if (coordinator.recordRateLimitViolation("s1", nowMs)) disconnected = true;
    }
    expect(disconnected).toBe(false);
  });

  it("processIncomingOperation rejects RATE_LIMITED and calls disconnectForRateLimit once a session's REJECTION VOLUME crosses its own disconnect rule (SEC-08 end to end: 'throttles ... then disconnects')", async () => {
    const coordinator = new DocumentCoordinator("doc-rl-3", new InMemoryOperationStore(), undefined, undefined, {
      rateLimit: {
        perSessionRule: { max: 1, windowMs: 60_000 },
        perSessionDisconnectRule: { max: 2, windowMs: 60_000 },
        perDocumentRule: { max: 1000, windowMs: 60_000 },
      },
    });
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    let disconnected = false;
    const session = buildTestSession(coordinator.allocateReplicaId(), SessionRole.OWNER, sent, {
      disconnectForRateLimit: () => {
        disconnected = true;
      },
    });
    coordinator.join(session);
    const engine = new Engine(session.replicaId);

    // Message 1: consumes the one allowed slot for this 60s window -- applied normally.
    const op1 = engine.localInsert(0, 0x61);
    await processIncomingOperation({ coordinator, session, msg: operationToOpInsert(op1, 0) });
    expect(coordinator.engine.text()).toBe("a");
    expect(disconnected).toBe(false);

    // Messages 2 and 3: both exceed the per-session cap of 1 (still the same 60s window), each a
    // separate rejection -- violation count now 1, then 2. Both are still within the
    // perSessionDisconnectRule budget of 2, so neither disconnects on its own.
    const op2 = engine.localInsert(1, 0x62);
    await processIncomingOperation({ coordinator, session, msg: operationToOpInsert(op2, 0) });
    expect(coordinator.engine.text()).toBe("a"); // op2 never applied
    expect(disconnected).toBe(false);

    const op3 = engine.localInsert(1, 0x63);
    await processIncomingOperation({ coordinator, session, msg: operationToOpInsert(op3, 0) });
    expect(coordinator.engine.text()).toBe("a");
    expect(disconnected).toBe(false);
    expect(rejectReasons(sent)).toEqual([RejectReason.RATE_LIMITED, RejectReason.RATE_LIMITED]);

    // Message 4: a THIRD rejection -- pushes the violation count to 3, over the budget of 2.
    // Crucially, NO message ever needed to be accepted in between for this to fire -- unlike the
    // old, broken continuous-streak design, an accepted message wouldn't reset anything here
    // either (there wasn't one, but see the companion "legitimate burst" test above for that
    // case proven directly).
    const op4 = engine.localInsert(1, 0x64);
    await processIncomingOperation({ coordinator, session, msg: operationToOpInsert(op4, 0) });
    expect(coordinator.engine.text()).toBe("a"); // op4 never applied either
    expect(disconnected).toBe(true);
    expect(rejectReasons(sent)).toEqual([
      RejectReason.RATE_LIMITED,
      RejectReason.RATE_LIMITED,
      RejectReason.RATE_LIMITED,
    ]);
  });

  it("a large single-message run/batch is never penalized for the NUMBER of operations it contains -- only the message count matters", async () => {
    // A 500-character paste, sent as one OP_INSERT_RUN, must not itself exceed a per-session cap
    // of even 1 message/window -- see RateLimitConfig's own doc comment (config.ts) for why
    // counting by expanded operation count would make an ordinary large paste indistinguishable
    // from an attack.
    const coordinator = new DocumentCoordinator("doc-rl-4", new InMemoryOperationStore(), undefined, undefined, {
      rateLimit: {
        perSessionRule: { max: 1, windowMs: 60_000 },
        perSessionDisconnectRule: { max: 1, windowMs: 60_000 },
        perDocumentRule: { max: 1, windowMs: 60_000 },
      },
    });
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), SessionRole.OWNER, sent);
    coordinator.join(session);
    const engine = new Engine(session.replicaId);
    const ops: Operation[] = [];
    for (let i = 0; i < 500; i++) {
      ops.push(engine.localInsert(i, 0x61));
    }
    const first = ops[0]!;
    if (first.kind !== "insert") throw new Error("unreachable");
    const runMsg: OpsMessage = {
      kind: "opInsertRun",
      seq: 0,
      firstId: first.id,
      firstParent: first.parent,
      firstSide: first.side,
      bind: false,
      values: ops.map(() => 0x61),
    };

    await processIncomingOperation({ coordinator, session, msg: runMsg });

    expect(coordinator.engine.text()).toHaveLength(500); // the whole paste landed, in ONE message
    expect(rejectReasons(sent)).toEqual([]);
  });
});

describe("SEC-08 — document-wide circuit breaker (RFC §8.2 (T2))", () => {
  it("trips at the structure-size ceiling and makes the document READ-ONLY for EVERYONE, including its own OWNER -- failing CLOSED", async () => {
    const coordinator = new DocumentCoordinator("doc-cb-1", new InMemoryOperationStore(), undefined, undefined, {
      circuitBreaker: { structureSizeCeiling: 3, structureSizeAlertThreshold: 2, tombstoneCountAlertThreshold: 100 },
    });
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const owner = buildTestSession(coordinator.allocateReplicaId(), SessionRole.OWNER, sent);
    coordinator.join(owner);
    const engine = new Engine(owner.replicaId);

    expect(coordinator.isCircuitBreakerTripped()).toBe(false);

    // Three inserts bring structure size to exactly the ceiling -- tripped as soon as the THIRD
    // one commits (evaluateCircuitBreaker runs reactively, right after the commit).
    for (let i = 0; i < 3; i++) {
      const op = engine.localInsert(i, 0x61 + i);
      await processIncomingOperation({ coordinator, session: owner, msg: operationToOpInsert(op, 0) });
    }
    expect(coordinator.engine.text()).toBe("abc");
    expect(coordinator.isCircuitBreakerTripped()).toBe(true);

    // A FOURTH operation, from the document's own OWNER, is rejected DOCUMENT_LOCKED and never
    // even reaches step 1's authorization check -- the breaker applies UNCONDITIONALLY, not as a
    // role-based decision.
    sent.length = 0;
    const op4 = engine.localInsert(3, 0x64);
    await processIncomingOperation({ coordinator, session: owner, msg: operationToOpInsert(op4, 0) });
    expect(coordinator.engine.text()).toBe("abc"); // op4 never applied
    expect(rejectReasons(sent)).toEqual([RejectReason.DOCUMENT_LOCKED]);
  });

  it("self-heals once GC reclaims enough tombstones to fall back under the ceiling -- 'GC reclaims the damage once the attack stops and the frontier advances'", async () => {
    const coordinator = new DocumentCoordinator("doc-cb-2", new InMemoryOperationStore(), undefined, undefined, {
      circuitBreaker: { structureSizeCeiling: 6, structureSizeAlertThreshold: 4, tombstoneCountAlertThreshold: 100 },
    });
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const owner = buildTestSession(coordinator.allocateReplicaId(), SessionRole.OWNER, sent);
    coordinator.join(owner);
    const engine = new Engine(owner.replicaId);

    // "abcde" -- 5 nodes, still under the ceiling of 6.
    for (let i = 0; i < 5; i++) {
      const op = engine.localInsert(i, 0x61 + i);
      await processIncomingOperation({ coordinator, session: owner, msg: operationToOpInsert(op, 0) });
    }
    expect(coordinator.engine.text()).toBe("abcde");
    expect(coordinator.isCircuitBreakerTripped()).toBe(false);

    // Delete the last TWO characters, from the visible END -- CLAUDE.md's own Phase 21 finding:
    // deleting from the end (never anchored by anything inserted afterward) is what lets GC
    // collect them cleanly, with no cascading-anchor complication to reason about here.
    for (let i = 0; i < 2; i++) {
      const lastVisibleIndex = coordinator.engine.text().length - 1;
      const [deleteOp] = engine.localDelete(lastVisibleIndex, 1);
      await processIncomingOperation({
        coordinator,
        session: owner,
        msg: operationToOpDelete(deleteOp!, 0),
      });
    }
    expect(coordinator.engine.text()).toBe("abc");
    // 5 nodes total (2 now tombstoned) -- still under the ceiling of 6.
    expect(coordinator.engine.stats().totalElements).toBe(5);
    expect(coordinator.isCircuitBreakerTripped()).toBe(false);

    // A SIXTH node crosses the ceiling -- tripped. Inserted in the MIDDLE of the still-visible
    // content ("a|bc", visible index 1), deliberately NOT at the very end: appending right after
    // already-tombstoned content can anchor the new node's own `parent` onto one of the
    // tombstones themselves (Critical Finding #2 / R0012's own mechanism, CLAUDE.md) -- which
    // would make THAT tombstone no longer collectible (something live still anchors it) and
    // silently invalidate this test's own "both tombstones are reclaimed" claim below. Inserting
    // away from the deleted region avoids that interaction entirely.
    const op6 = engine.localInsert(1, 0x66);
    await processIncomingOperation({ coordinator, session: owner, msg: operationToOpInsert(op6, 0) });
    expect(coordinator.engine.text()).toBe("afbc");
    expect(coordinator.engine.stats().totalElements).toBe(6);
    expect(coordinator.isCircuitBreakerTripped()).toBe(true);

    // GC runs DIRECTLY against the engine (gcScheduler.ts's own real call shape) -- bypassing the
    // write path entirely, exactly as production GC does, so it can still reclaim space even
    // while new WRITES are being rejected. A frontier covering everything and a zero-length undo
    // horizon make both tombstones immediately eligible.
    const result = coordinator.engine.collect(coordinator.currentSeq, {
      nowMs: Date.now(),
      maxAgeMs: 0,
      maxOpsPerReplica: 0,
      budgetMs: 1000,
      clock: () => Date.now(),
    });
    expect(result.collectedCount).toBe(2);
    expect(coordinator.engine.stats().totalElements).toBe(4);

    // The SAME re-evaluation gcScheduler.ts itself performs after every real GC cycle -- this is
    // what lets the breaker un-trip with no separate "reset" action from an operator.
    coordinator.evaluateCircuitBreaker();
    expect(coordinator.isCircuitBreakerTripped()).toBe(false);

    // And ordinary writes are accepted again. Inserted at the very START (visible index 0), not
    // the end: `coordinator.engine.collect()` above physically removed the two tombstones from
    // the SERVER's own tree, but this test's separate, local `engine` (standing in for a real
    // client, which never runs its own GC) still has them -- anchoring a new insert anywhere
    // near that now-collected region would itself reproduce Critical Finding #2 / R0012
    // (CLAUDE.md), a genuine, disclosed, SEPARATE finding this test isn't the place to exercise.
    sent.length = 0;
    const op7 = engine.localInsert(0, 0x67);
    await processIncomingOperation({ coordinator, session: owner, msg: operationToOpInsert(op7, 0) });
    expect(coordinator.engine.text()).toBe("gafbc");
    expect(rejectReasons(sent)).toEqual([]);
  });
});

describe("SEC-11i — the causal buffer is bounded in size, independent of age (RFC §8.7)", () => {
  it("evicts the OLDEST still-buffered operations, logs a warning, and preserves the newest ones, once the document's pending count exceeds its configured cap", async () => {
    const coordinator = new DocumentCoordinator("doc-cb-3", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), SessionRole.OWNER, sent);
    coordinator.join(session);
    // A source engine that mints operations this coordinator will never see the true causal
    // dependency of (a different, disconnected replica's own root document) -- every one of
    // these buffers in `engine.pending` forever, which is exactly the shape SEC-11i needs: many
    // never-resolving operations accumulating. An anchor character is minted first (never sent to
    // the coordinator) purely so every SENT op has a real, non-null `parent` under replica 999 --
    // the very FIRST insert into an empty document has `parent: null`, which would resolve
    // trivially (no dependency at all) and apply immediately instead of buffering.
    const foreignEngine = new Engine(999);
    foreignEngine.localInsert(0, 0x7a);
    const buffered: InsertOperation[] = [];
    for (let i = 0; i < 5; i++) {
      buffered.push(foreignEngine.localInsert(i + 1, 0x61 + i));
    }
    for (const op of buffered) {
      await processIncomingOperation({
        coordinator,
        session,
        msg: operationToOpInsert({ ...op, id: { c: op.id.c, r: session.replicaId } }, 0),
      });
    }
    expect(coordinator.engine.pending.length).toBe(5);

    // Real production code reaches the size-bound sweep through
    // offlineWindowScheduler.ts's own `runOneDocument` (Phase 30 extension) -- imported directly
    // here rather than duplicating its eviction logic.
    const { runOneDocument } = await import("./offlineWindowScheduler.js");
    runOneDocument(coordinator, {
      pendingRejectTimeoutMs: 60_000, // nothing here is old enough to be evicted on AGE
      sweepIntervalMs: 5_000,
      maxPendingPerDocument: 2, // but 5 > 2 -- the SIZE bound fires regardless of age
    });

    expect(coordinator.engine.pending.length).toBe(2);
    // The two SURVIVING entries are the two most RECENTLY buffered (index 3 and 4) -- the three
    // oldest (0, 1, 2) were evicted first.
    const survivingCounters = coordinator.engine.pending
      .map((op) => op.id.c)
      .sort((a, b) => a - b);
    expect(survivingCounters).toEqual([buffered[3]!.id.c, buffered[4]!.id.c]);
  });
});

describe("SEC-11h — a replayed operation from a capture is absorbed idempotently and changes nothing", () => {
  it("re-sending the IDENTICAL, already-applied OP_INSERT frame a second time never grows the document or mints a new node", async () => {
    const coordinator = new DocumentCoordinator("doc-idem-1", new InMemoryOperationStore());
    await coordinator.ready;
    const sent: Uint8Array[] = [];
    const session = buildTestSession(coordinator.allocateReplicaId(), SessionRole.OWNER, sent);
    coordinator.join(session);
    const engine = new Engine(session.replicaId);
    const op = engine.localInsert(0, 0x61);
    const captured = encodeFrame(operationToOpInsert(op, 0)); // "a capture" -- literal wire bytes

    await processIncomingOperation({ coordinator, session, msg: decodeFrame(captured, { direction: "clientOrigin" }) as OpsMessage });
    expect(coordinator.engine.text()).toBe("a");
    const nodeCountAfterFirst = coordinator.engine.stats().totalElements;

    // Replayed verbatim -- e.g. a network-level retransmit, or a captured frame resent by a
    // debugging tool. Engine Spec §6.3's own idempotence guarantee (Phase 3, exercised by every
    // fuzz/property/mutation suite this project has ever run) is what actually absorbs this; this
    // test proves it holds reached THROUGH the full write path, not just at the bare `Engine` API.
    await processIncomingOperation({ coordinator, session, msg: decodeFrame(captured, { direction: "clientOrigin" }) as OpsMessage });

    expect(coordinator.engine.text()).toBe("a"); // still exactly "a" -- not "aa"
    expect(coordinator.engine.stats().totalElements).toBe(nodeCountAfterFirst); // no new node minted
    // A second seq MAY still be reserved for the replay at the wire-protocol layer (Phase 16's
    // own `operations_stamp_uq` SAVEPOINT-based dedup is what actually suppresses the DUPLICATE
    // ROW at the database layer, covered by durability.db.test.ts's own DoD test, not repeated
    // here) -- this test's own scope is strictly the ENGINE-level "changes nothing" guarantee
    // SEC-11h itself names.
  });
});

describe("SEC-10 — the attack propagates to peers, and the circuit breaker bounds that propagation too", () => {
  it("a peer's own local engine grows in lockstep with the coordinator's structure size, and STOPS growing once the circuit breaker trips", async () => {
    const coordinator = new DocumentCoordinator("doc-peer-1", new InMemoryOperationStore(), undefined, undefined, {
      circuitBreaker: { structureSizeCeiling: 10, structureSizeAlertThreshold: 5, tombstoneCountAlertThreshold: 100 },
    });
    await coordinator.ready;

    // The ATTACKER's own session.
    const attackerSent: Uint8Array[] = [];
    const attacker = buildTestSession(coordinator.allocateReplicaId(), SessionRole.EDITOR, attackerSent);
    coordinator.join(attacker);
    const attackerEngine = new Engine(attacker.replicaId);

    // A PEER's own session -- every broadcast frame this coordinator relays to `otherSessions`
    // (writePath.ts) lands in `peerSent`, standing in for "what a real peer's own SyncClient
    // would receive over its socket." `peerEngine` is a completely independent, real `Engine`
    // instance, mirroring exactly what a real peer client integrates into its own memory --
    // never the coordinator's own engine, which would prove nothing about PROPAGATION.
    const peerSent: Uint8Array[] = [];
    const peer = buildTestSession(coordinator.allocateReplicaId(), SessionRole.EDITOR, peerSent);
    coordinator.join(peer);
    const peerEngine = new Engine(peer.replicaId);

    function drainRelayedFramesIntoPeer(): void {
      for (const frame of peerSent.splice(0, peerSent.length)) {
        const msg = decodeFrame(frame, { direction: "serverOrigin" });
        if (msg.kind === "opInsert") {
          peerEngine.applyRemote({ kind: "insert", id: msg.id, value: msg.value, parent: msg.parent, side: msg.side, bind: msg.bind });
        } else if (msg.kind === "opDelete") {
          peerEngine.applyRemote({ kind: "delete", id: msg.id, target: msg.target });
        }
      }
    }

    // Insert-then-delete at scattered positions, from the ATTACKER -- SEC-08's own attack shape.
    // The ceiling (10) is reached partway through this loop.
    for (let i = 0; i < 20 && !coordinator.isCircuitBreakerTripped(); i++) {
      const text = attackerEngine.text();
      const insertAt = text.length === 0 ? 0 : i % (text.length + 1);
      const op = attackerEngine.localInsert(insertAt, 0x61 + (i % 26));
      await processIncomingOperation({ coordinator, session: attacker, msg: operationToOpInsert(op, 0) });
      drainRelayedFramesIntoPeer();
      // Every peer's OWN memory grows in lockstep with the coordinator's structure size --
      // this is SEC-10's own central claim, checked on EVERY iteration, not just at the end.
      expect(peerEngine.stats().totalElements).toBe(coordinator.engine.stats().totalElements);

      if (coordinator.isCircuitBreakerTripped()) break;
      const afterText = attackerEngine.text();
      if (afterText.length > 1) {
        const [deleteOp] = attackerEngine.localDelete(i % afterText.length, 1);
        await processIncomingOperation({ coordinator, session: attacker, msg: operationToOpDelete(deleteOp!, 0) });
        drainRelayedFramesIntoPeer();
        expect(peerEngine.stats().totalElements).toBe(coordinator.engine.stats().totalElements);
      }
    }
    expect(coordinator.isCircuitBreakerTripped()).toBe(true);
    const peerSizeAtTrip = peerEngine.stats().totalElements;
    const coordinatorSizeAtTrip = coordinator.engine.stats().totalElements;

    // Further attacker operations are rejected server-side (DOCUMENT_LOCKED) and NEVER reach the
    // peer at all -- the breaker bounds propagation, not just the server's own storage.
    attackerSent.length = 0;
    const furtherOp = attackerEngine.localInsert(0, 0x7a);
    await processIncomingOperation({ coordinator, session: attacker, msg: operationToOpInsert(furtherOp, 0) });
    expect(rejectReasons(attackerSent)).toEqual([RejectReason.DOCUMENT_LOCKED]);
    drainRelayedFramesIntoPeer();
    expect(peerEngine.stats().totalElements).toBe(peerSizeAtTrip); // unchanged -- nothing propagated
    expect(coordinator.engine.stats().totalElements).toBe(coordinatorSizeAtTrip); // unchanged either
  });
});
