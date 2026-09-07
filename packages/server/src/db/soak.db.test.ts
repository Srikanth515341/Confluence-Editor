// Phase 25 — Milestone M2, Test Plan M8-e (long-duration soak: reference text's own literal
// "24 hours / 10^6 operations"), verified against a REAL, migrated Postgres instance. Requires:
//   docker compose up -d
//   pnpm db:migrate
// Run via `pnpm test:db`.
//
// *** A GENUINE, DISCLOSED SCOPE REDUCTION — NOT SILENTLY INTERPRETED AS SATISFIED ***
//
// This test does NOT run for 24 real hours, and does NOT drive 10^6 real operations through
// the real write path. Both would be disproportionate to what a single CI-shaped test run
// (this repository has no long-running soak infrastructure, no overnight job runner, and no
// dedicated soak environment) can responsibly execute as part of this phase's own DoD
// verification. Per this phase's own reference-text guidance ("if a full 24h/10^6-op soak is
// disproportionate, a shorter run is acceptable IF the reduction is explicitly disclosed, not
// silently interpreted as satisfied"), this test instead drives:
//
//   SOAK_TOTAL_OPS = 30,000 real operations (3% of the reference target's op count) through the
//   REAL write path (`processIncomingOperation`), against a REAL Postgres instance, with a real
//   GC cycle (`runOneDocument`, the exact production scheduler function, not a direct
//   `engine.collect()` call) every 5,000 operations and a real, full AUDIT (`auditDocument`)
//   every 10,000 operations — repeatedly exercising the SAME mechanisms (persistence,
//   snapshotting via `maybeScheduleSnapshot`'s own reactive trigger, GC, and integrity audit)
//   the 24h/10^6 target is meant to stress, at a scale this test suite can actually execute in
//   a few minutes.
//
// What this DOES verify, at this reduced scale: no audit failure across the whole run (a
// growing-log/growing-tombstone scenario that silently corrupts durable state would show up as
// an audit mismatch well before 30,000 ops); GC genuinely keeps the tombstone ratio bounded
// rather than growing unboundedly (Rule 7.3's whole point); heap usage sampled at each
// checkpoint does not show unbounded, monotonic growth; and the coordinator/engine/store all remain fully functional and responsive
// (every operation still completes, every audit still returns promptly) after 30,000 operations
// and 6 real GC cycles — the SAME code paths a 24h/10^6-op run would exercise repeatedly, just
// far fewer times. What this reduced run CANNOT rule out: a leak or degradation that only
// manifests after hours of continuous operation, or at 10^6-operation scale specifically (e.g.
// snapshot-table growth becoming a real problem, or a GC fixpoint cost that only becomes
// pathological at a document size this run never reaches). This gap is recorded here, in
// CLAUDE.md's own Phase 25 entry, and in the phase's end-of-phase report, exactly as Test Plan
// C1 (M8-a/M8-b's own 10MB memory target) was recorded honestly rather than glossed over.
//
// *** OPEN ITEM 10 WIRING (2026-09-07): the offline-window sweep is now wired into this loop. ***
// Earlier runs of this test found `coordinator.engine.pending.length` stuck at a nonzero value
// (1,400 on the last full run) at completion -- a genuine finding, not a fixture bug: this
// soak's own simulated clients never went through real reconciliation, so an ordinary
// insert-anchored-to-a-since-collected-node race (Engine Spec §7.6, see CLAUDE.md's own
// "CRITICAL FINDING #2"/R0012 entry for the full mechanism and Option 2's client-side
// mitigation) left a real, permanently-unresolvable operation sitting in `engine.pending`
// forever with nothing to evict it -- Phase 24's own `offlineWindowScheduler.ts` sweep exists
// for exactly this and simply was not wired into this soak loop yet. It now is: `runOfflineWindowSweep`
// (Phase 24's `offlineWindowScheduler.ts` `runOneDocument`, aliased to avoid a name collision
// with `gcScheduler.ts`'s own `runOneDocument` already imported above) runs alongside the
// existing GC cycle, at the REAL default `pendingRejectTimeoutMs: 30_000` (Scope-IN's own
// literal number) -- not shortened for this test, since the whole point is verifying the real,
// shipped production config actually converges `pending` to 0 within this run's own real
// wall-clock duration.
//
// *** OPEN ITEM 11, RESOLVED (2026-09-07): the heap-growth finding was unforced-GC noise. ***
// The Item-10 re-run above found `pending` correctly reaches 0, but ALSO found a heap-growth
// smell-test failure (97.8MB -> 241.2MB between the last two checkpoints, no matching
// structural growth) -- see tests/regression/R0013. That measurement did NOT force `global.gc()`
// before each sample, so the jump could have been genuine accumulation OR ordinary unforced V8
// allocator noise. Re-measured with `global.gc()` (via `--expose-gc`, the same technique M8-a's
// own finalMemoryLatency.bench.test.ts already established) forced immediately before every
// heap sample below, PLUS every long-lived, potentially-unbounded DocumentCoordinator Map
// (`pendingFirstSeenAtMs`, `pendingOpOrigin`, `watermarks`) sampled alongside it: heap growth
// under forced GC was smooth and tracked structural growth closely (29.5MB -> 76.3MB, ~2.6x,
// against ~5.4x structural growth) -- CONFIRMED NOISE, not a leak; the map sizes stayed bounded
// (peaking around 180 entries, never growing without bound) across the whole run. Full data:
// docs/benchmarks.md's own "M8-e soak run" section. Invocation used:
// `NODE_OPTIONS=--expose-gc ... vitest run ... --pool=forks --poolOptions.forks.singleFork`
// (the pool/singleFork flags are required for `NODE_OPTIONS` to actually reach the worker that
// runs this test — the same requirement M8-a's own investigation established).

import { randomUUID } from "node:crypto";
import { Engine } from "@collab-editor/engine";
import {
  decodeFrame,
  operationToOpDelete,
  operationToOpInsert,
  type OpsMessage,
} from "@collab-editor/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AckBatcher } from "../ackBatcher.js";
import { loadConfig } from "../config.js";
import type { CoordinatorSession } from "../documentCoordinator.js";
import { DocumentCoordinator } from "../documentCoordinator.js";
import { toOperations } from "../ingest.js";
import { runOneDocument } from "../gcScheduler.js";
import { runOneDocument as runOfflineWindowSweep } from "../offlineWindowScheduler.js";
import { auditDocument } from "../audit.js";
import { ConnectionSendQueues } from "../sendQueues.js";
import { processIncomingOperation } from "../writePath.js";
import { PostgresOperationStore } from "./operationStore.js";
import { createPool, type DbPool } from "./pool.js";

let pool: DbPool;

beforeAll(() => {
  const config = loadConfig();
  pool = createPool(config.databaseUrl);
});

afterAll(async () => {
  await pool.end();
});

const LOWERCASE_A = 0x61;
function letterAt(i: number): number {
  return LOWERCASE_A + (i % 26);
}

interface SimulatedClient {
  readonly session: CoordinatorSession;
  readonly engine: Engine;
}

function buildSimulatedClient(coordinator: DocumentCoordinator): SimulatedClient {
  const replicaId = coordinator.allocateReplicaId();
  const engine = new Engine(replicaId);
  const queues = new ConnectionSendQueues(
    (frame) => {
      try {
        const msg: OpsMessage = decodeFrame(frame, { direction: "serverOrigin" });
        if (msg.kind !== "opAck" && msg.kind !== "opReject") {
          for (const op of toOperations(msg)) {
            engine.applyRemote(op);
          }
        }
      } catch {
        // Not a decodable OPS frame this client cares about.
      }
      return Promise.resolve();
    },
    () => false,
  );
  const session: CoordinatorSession = {
    sessionId: randomUUID(),
    replicaId,
    queues,
    ackBatcher: new AckBatcher(() => {}),
    role: 1, // EDITOR
    userId: randomUUID(),
    displayName: `soak-client-${replicaId}`,
    lastPingAt: Date.now(),
    presenceStale: false,
    staleTimer: undefined,
    receivedFrameCount: 0,
  };
  coordinator.join(session);
  return { session, engine };
}

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Phase 25 M8-e — soak (SCOPED DOWN from 24h/10^6-op to 30,000 ops — see this file's own header for the full, disclosed reduction)", () => {
  it(
    "30,000 operations, periodic real GC cycles and real audits, no audit failure, tombstone ratio stays bounded, heap does not grow unboundedly",
    async () => {
      const documentId = randomUUID();
      const store = new PostgresOperationStore(pool);
      const coordinator = new DocumentCoordinator(documentId, store);
      await coordinator.ready;

      const clients: SimulatedClient[] = [
        buildSimulatedClient(coordinator),
        buildSimulatedClient(coordinator),
        buildSimulatedClient(coordinator),
        buildSimulatedClient(coordinator),
      ];

      const gcConfig = {
        undoHorizonMaxAgeMs: 0, // no artificial grace window -- this soak's own point is to actually collect
        undoHorizonMaxOpsPerReplica: 0,
        gcIntervalMs: 60_000, // irrelevant here -- runOneDocument is called directly, never via the timer
        gcFixpointBudgetMs: 150,
      };
      // Open Item 11 investigation, step 4 (2026-09-07): the REAL, non-zero production undo-
      // horizon default (RFC's own 5min/200-ops-per-replica) was swapped in for exactly ONE
      // comparison run (then reverted to the config above) to measure R0012's own rejection
      // frequency under realistic tuning rather than this test's own deliberately-aggressive
      // zero-grace-window config. Result: NO material difference (1,632/30,000 = 5.44% vs.
      // 1,605/30,000 = 5.35% under zero-grace) -- because at this test's own synthetic
      // throughput (~67 ops/sec across 4 replicas), Rule 7.3's OR-condition's op-count half
      // (200 further ops per replica) is satisfied within roughly 12 real seconds, making the
      // nominal "5 minute" grace window practically irrelevant at this op rate -- the effective
      // grace period a genuinely busy real editing session would see is governed by whichever
      // of the two Rule 7.3 conditions is hit first, and for active, multi-user editing that is
      // very often the op-count condition, not the wall-clock one. See CLAUDE.md's own Open
      // Item 11/R0013 entries for the full account and what this means for Item 9's priority.
      // The REAL default offline-window config (Scope-IN's own literal 30s), not shortened --
      // see this file's own "OPEN ITEM 10 WIRING" header comment.
      const offlineWindowConfig = {
        pendingRejectTimeoutMs: 30_000,
        sweepIntervalMs: 5_000, // unused directly -- runOfflineWindowSweep is called manually below, never via a timer
      };

      // Open Item 11 investigation (2026-09-07): the previous run's heap-growth smell-test
      // failure (97.8MB -> 241.2MB between the last two checkpoints, no matching structural
      // growth) was measured WITHOUT forcing V8's own GC before each sample -- meaning the
      // observed jump could equally be a genuine accumulation OR ordinary unforced allocator
      // noise (the file's own pre-existing header comment already disclosed this ambiguity).
      // This run resolves that ambiguity by forcing `global.gc()` immediately before EVERY
      // heap sample, the same `--expose-gc` technique already established for M8-a's own
      // benchmark (finalMemoryLatency.bench.test.ts) -- see this file's own README/CLAUDE.md
      // entries for the exact invocation this requires
      // (`NODE_OPTIONS=--expose-gc ... --pool=forks --poolOptions.forks.singleFork`).
      const forceGc = (globalThis as { gc?: () => void }).gc;
      console.log(`M8-e soak — global.gc available: ${forceGc !== undefined}`);

      const random = mulberry32(0x50a4_0000);
      const TOTAL_OPS = 30_000;
      const GC_EVERY = 5_000;
      const AUDIT_EVERY = 10_000;
      let valueCounter = 0;
      const heapSamplesMb: number[] = [];
      const tombstoneRatios: number[] = [];
      // Open Item 11 investigation: cheap, always-collected diagnostic samples of every
      // long-lived, potentially-unbounded Map on DocumentCoordinator (Rule 7.2's own pending-
      // tracking bookkeeping) -- collected in the SAME run as the forced-GC heap samples so a
      // genuine leak can be immediately attributed (or ruled out) without a third re-run.
      const pendingFirstSeenSizes: number[] = [];
      const pendingOpOriginSizes: number[] = [];
      const watermarksSizes: number[] = [];

      for (let i = 1; i <= TOTAL_OPS; i++) {
        const client = clients[Math.floor(random() * clients.length)]!;
        const text = client.engine.text();
        const wantDelete = text.length > 0 && random() < 0.3;
        if (wantDelete) {
          const pos = Math.floor(random() * text.length);
          const deleteOp = client.engine.localDelete(pos, 1)[0]!;
          await processIncomingOperation({
            coordinator,
            session: client.session,
            msg: operationToOpDelete(deleteOp, 0),
          });
        } else {
          const pos = Math.floor(random() * (text.length + 1));
          const insertOp = client.engine.localInsert(pos, letterAt(valueCounter));
          valueCounter += 1;
          await processIncomingOperation({
            coordinator,
            session: client.session,
            msg: operationToOpInsert(insertOp, 0),
          });
        }

        // Every client acks up to the coordinator's current seq -- a real, ordinary heartbeat
        // pattern -- so the stability frontier (API Spec §6.5) can actually advance and GC has
        // something real to collect, rather than being permanently blocked at frontier 0 the
        // way Phase 21's own gc.db.test.ts had to explicitly guard against (bug #3 in that
        // phase's own account: a phantom always-fresh session row holds the frontier at 0).
        if (i % 500 === 0) {
          for (const client of clients) {
            await store.upsertSessionHeartbeat({
              sessionId: client.session.sessionId,
              documentId,
              userId: client.session.userId,
              replicaId: client.session.replicaId,
              displayName: client.session.displayName,
              lastAckSeq: coordinator.currentSeq,
            });
          }
          // Phase 24's own offline-window sweep (Rule 7.2's "explicit rejection" half), run at
          // the same cadence as the heartbeat above -- cheap, synchronous, in-memory (see
          // offlineWindowScheduler.ts's own doc comment: no database query involved). Frequent
          // calls are safe and idempotent -- a pending op is only ever rejected once it has
          // genuinely aged past the real 30s threshold, regardless of how often this runs.
          runOfflineWindowSweep(coordinator, offlineWindowConfig);
        }

        if (i % GC_EVERY === 0) {
          await runOneDocument(coordinator, gcConfig);
          const stats = coordinator.engine.stats();
          tombstoneRatios.push(
            stats.totalElements === 0 ? 0 : stats.tombstones / stats.totalElements,
          );
          // Open Item 11: force a real GC pass before sampling heap, so this number reflects
          // actual live retained memory, not whatever V8 happens not to have reclaimed yet.
          forceGc?.();
          heapSamplesMb.push(process.memoryUsage().heapUsed / (1024 * 1024));
          pendingFirstSeenSizes.push(coordinator.pendingFirstSeenAtMs.size);
          pendingOpOriginSizes.push(coordinator.pendingOpOrigin.size);
          watermarksSizes.push(coordinator.watermarks.size);
        }

        if (i % AUDIT_EVERY === 0) {
          const result = await auditDocument(documentId, store, {
            liveText: coordinator.engine.text(),
          });
          expect(result.result).toBe("ok");
        }
      }

      // Final drain: any operation that became permanently stuck in the LAST 30 real seconds of
      // the main loop above has not yet aged past `pendingRejectTimeoutMs` and would still show
      // up as pending here even though the sweep above is working correctly -- so wait out the
      // real timeout window, then run one final sweep, before asserting quiescence. This is a
      // real, deliberate 30+s wait, not a flake -- the whole point of this run is confirming the
      // REAL production timeout actually converges `pending` to 0 within a bounded, real amount
      // of wall-clock time, not merely "eventually, given enough calls."
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      runOfflineWindowSweep(coordinator, offlineWindowConfig);

      // Final quiescence and a final, full audit.
      for (const client of clients) {
        expect(client.engine.pending.length).toBe(0);
      }
      expect(coordinator.engine.pending.length).toBe(0);
      const finalAudit = await auditDocument(documentId, store, {
        liveText: coordinator.engine.text(),
      });
      expect(finalAudit.result).toBe("ok");

      console.log("M8-e soak (scoped to 30,000 ops) — tombstone ratios at each GC checkpoint:", tombstoneRatios);
      console.log("M8-e soak — heap (MB, forced GC) at each GC checkpoint:", heapSamplesMb.map((n) => n.toFixed(1)));
      console.log("M8-e soak — coordinator.pendingFirstSeenAtMs.size at each checkpoint:", pendingFirstSeenSizes);
      console.log("M8-e soak — coordinator.pendingOpOrigin.size at each checkpoint:", pendingOpOriginSizes);
      console.log("M8-e soak — coordinator.watermarks.size at each checkpoint:", watermarksSizes);

      // Tombstone ratio must stay meaningfully bounded across the run, not climb toward 1 --
      // Rule 7.3's whole point. A generous bound (0.5), not a tight one: this is a coarse
      // stability signal at reduced scale, not a precise GC-effectiveness benchmark (that's
      // gc.db.test.ts's own M8-c/M8-d job, at a controlled, single-shot scenario).
      for (const ratio of tombstoneRatios) {
        expect(ratio).toBeLessThan(0.5);
      }

      // Coarse, disclosed-as-non-exhaustive leak signal: heap usage across the 6 GC checkpoints
      // should not show unbounded, purely monotonic growth -- the LAST sample should not be
      // dramatically larger than the median of the first half, which would indicate something
      // accumulating without bound rather than merely ordinary allocator variance.
      const firstHalf = heapSamplesMb.slice(0, Math.ceil(heapSamplesMb.length / 2));
      const medianFirstHalf = firstHalf.slice().sort((a, b) => a - b)[Math.floor(firstHalf.length / 2)]!;
      const last = heapSamplesMb[heapSamplesMb.length - 1]!;
      expect(last).toBeLessThan(medianFirstHalf * 4); // generous -- a coarse smell test, not a tight bound
    },
    900_000,
  );
});
