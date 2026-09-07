// Phase 25 — Milestone M2, Test Plan DUR-03 (crash injection at the 10 named sites),
// verified against a REAL, migrated Postgres instance. Requires:
//   docker compose up -d
//   pnpm db:migrate
// Run via `pnpm test:db` — see durability.db.test.ts's own header comment for why this
// whole file's category is gated out of the default `pnpm test`.
//
// METHODOLOGY (the phase brief's own explicitly-sanctioned "acceptable alternative" to
// literal SIGKILL process-kill injection, per the reference text: "explicit synchronous
// throw points at each site ... combined with an actual process restart for the server
// between test iterations, as long as the distinction between 'graceful error' and 'actual
// crash' doesn't matter for what's being verified" — which is the case here, since DUR-03
// verifies Postgres durability, unaffected by HOW the prior process instance ended):
//
// - Crash injection: `testOnlyCrashInjection.ts`'s one-shot armed-site registry, checked
//   inline at each of the 10 real call sites in writePath.ts/operationStore.ts/
//   snapshotter.ts/gcScheduler.ts (see that file's own header for the full account).
// - "Clients": the SAME headless-simulated-client pattern audit.db.test.ts (DUR-01) and
//   gc.db.test.ts (M8-c/M8-d) already established as sufficient for this project's own
//   `*.db.test.ts` suite — a real `Engine` plus a `ConnectionSendQueues` that decodes and
//   applies every relay the server sends, reproducing what a real `SyncClient` would end up
//   with, without a real WebSocket. This drives operations THROUGH the real
//   `processIncomingOperation` write path directly (gateway.ts's network layer is Phase 8/9
//   plumbing already covered by that phase's own tests, orthogonal to what DUR-03 verifies).
// - "Restart": a fresh `DocumentCoordinator` constructed against the SAME real Postgres
//   database — the identical interpretation Phase 16's own `serverRestart.db.test.ts`
//   established (a new server construction against durable state that outlives the old
//   process/object, not a literal new OS process).
// - "Reconnection and reconciliation": each simulated client rebuilds its own engine from
//   the freshly-restarted coordinator's warm-started state (`replaySnapshotNodesInto`, the
//   same function a real client's own SNAPSHOT path uses) and gets a NEW replica id from the
//   fresh coordinator — Phase 22/23's own already-validated "re-mint under a new identity,
//   never the original one" reconnection design, reused here rather than reinvented. A
//   crash-affected "victim" operation that never made it into Postgres is resent by its
//   originating client exactly once, post-reconnect, under this new identity.

import { randomUUID } from "node:crypto";
import { Engine, type InsertOperation } from "@collab-editor/engine";
import {
  decodeFrame,
  encodeFrame,
  operationToOpInsert,
  replaySnapshotNodesInto,
  type OpsMessage,
} from "@collab-editor/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AckBatcher } from "../ackBatcher.js";
import { auditDocument } from "../audit.js";
import { loadConfig } from "../config.js";
import type { CoordinatorSession } from "../documentCoordinator.js";
import { DocumentCoordinator } from "../documentCoordinator.js";
import { runOneDocument as runGcCycle } from "../gcScheduler.js";
import { toOperations } from "../ingest.js";
import { ConnectionSendQueues } from "../sendQueues.js";
import { writeSnapshotNow } from "../snapshotter.js";
import {
  ALL_CRASH_SITES,
  armCrashSite,
  disarmCrashSite,
  isCrashSiteArmed,
  type CrashSite,
} from "../testOnlyCrashInjection.js";
import { processIncomingOperation } from "../writePath.js";
import { PostgresOperationStore } from "./operationStore.js";
import { createPool, type DbPool } from "./pool.js";

let pool: DbPool;
let store: PostgresOperationStore;

beforeAll(() => {
  const config = loadConfig();
  pool = createPool(config.databaseUrl);
  store = new PostgresOperationStore(pool);
});

afterAll(async () => {
  await pool.end();
});

const LOWERCASE_A = 0x61;
function letterAt(i: number): number {
  return LOWERCASE_A + (i % 26);
}

function insertMessageFor(op: InsertOperation): OpsMessage {
  return operationToOpInsert(op, 0);
}

/** Same shape as audit.db.test.ts/gc.db.test.ts's own `SimulatedClient` — duplicated per this project's own established `*.db.test.ts` convention. */
interface SimulatedClient {
  session: CoordinatorSession;
  engine: Engine;
  readonly label: string;
}

function buildSimulatedClient(coordinator: DocumentCoordinator, label: string): SimulatedClient {
  const replicaId = coordinator.allocateReplicaId();
  const engine = new Engine(replicaId);
  replaySnapshotNodesInto(engine, coordinator.engine.nodes);
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
    displayName: label,
    lastPingAt: Date.now(),
    presenceStale: false,
    staleTimer: undefined,
    receivedFrameCount: 0,
  };
  coordinator.join(session);
  return { session, engine, label };
}

/** "Reconnects" every simulated client to a freshly-restarted coordinator: a new replica id, a fresh local engine seeded from the coordinator's own post-warm-start state. Mutates each `SimulatedClient` in place. */
function reconnectAll(coordinator: DocumentCoordinator, clients: readonly SimulatedClient[]): void {
  for (const client of clients) {
    const replicaId = coordinator.allocateReplicaId();
    const engine = new Engine(replicaId);
    replaySnapshotNodesInto(engine, coordinator.engine.nodes);
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
          // ignore
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
      role: 1,
      userId: randomUUID(),
      displayName: client.label,
      lastPingAt: Date.now(),
      presenceStale: false,
      staleTimer: undefined,
      receivedFrameCount: 0,
    };
    coordinator.join(session);
    client.session = session;
    client.engine = engine;
  }
}

async function isStampCommitted(documentId: string, id: { r: number; c: number }): Promise<boolean> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM operations WHERE document_id = $1 AND stamp_r = $2 AND stamp_c = $3`,
    [documentId, id.r, id.c],
  );
  return Number(rows[0]!.count) > 0;
}

const GC_CONFIG = loadConfig().gc;

/**
 * Runs ONE DUR-03 repetition: 3 simulated clients each commit a couple of baseline
 * operations normally, then ONE "victim" operation is submitted with `site` armed to fire
 * somewhere along its own path through the write path/scheduler. Whatever the crash's
 * effect on the victim operation, the repetition restarts (a fresh `DocumentCoordinator`
 * against the same real Postgres state), reconnects every client, resends the victim if
 * (and only if) it never made it into Postgres, and asserts M1 (convergence), M2 (the
 * victim present exactly once — no loss, no duplication), and DUR-01 (the audit passes).
 */
async function runOneCrashRepetition(site: CrashSite): Promise<void> {
  const documentId = randomUUID();
  let coordinator = new DocumentCoordinator(documentId, store);
  await coordinator.ready;

  let clients: SimulatedClient[] = [
    buildSimulatedClient(coordinator, "Client A"),
    buildSimulatedClient(coordinator, "Client B"),
    buildSimulatedClient(coordinator, "Client C"),
  ];

  // Baseline: 2 ordinary operations per client, committed with NO crash armed — "clients
  // typing continuously" before the crash-inducing edit.
  let opIndex = 0;
  for (let round = 0; round < 2; round++) {
    for (const client of clients) {
      const op = client.engine.localInsert(client.engine.text().length, letterAt(opIndex));
      opIndex += 1;
      await processIncomingOperation({ coordinator, session: client.session, msg: insertMessageFor(op) });
    }
  }
  const baselineText = coordinator.engine.text();
  expect(baselineText.length).toBe(6);

  // The victim operation: minted locally (so its own id/content is fixed regardless of what
  // happens next), submitted with `site` armed.
  const victim = clients[0]!;
  const victimOp = victim.engine.localInsert(victim.engine.text().length, letterAt(opIndex));

  armCrashSite(site);
  if (site === "duringSnapshotWrite") {
    // Not on a plain insert's own mainline path — driven directly, matching this site's own
    // real trigger (snapshotter.ts's writeSnapshotNow), after the victim op has already
    // committed normally (this site's own crash affects ONLY the snapshot row, never the
    // operations log the victim op itself lives in).
    await processIncomingOperation({ coordinator, session: victim.session, msg: insertMessageFor(victimOp) });
    await writeSnapshotNow(coordinator).catch(() => {});
  } else if (site === "duringGcCycle") {
    await processIncomingOperation({ coordinator, session: victim.session, msg: insertMessageFor(victimOp) });
    await runGcCycle(coordinator, GC_CONFIG).catch(() => {});
  } else {
    // Every OTHER site's exception is caught HERE with a plain `.catch(() => {})`, not
    // asserted on directly — some sites (e.g. `beforeCommit`) have their SimulatedCrash
    // deliberately swallowed by writePath.ts's own real "a commit failure is logged, not
    // rethrown" behavior (matching what a genuine database error would do), so a thrown
    // exception reaching THIS call site is not a reliable universal signal. `isCrashSiteArmed()`
    // below is the actual, site-agnostic proof that the crash fired.
    await processIncomingOperation({ coordinator, session: victim.session, msg: insertMessageFor(victimOp) }).catch(
      () => {},
    );
  }
  // The armed site is cleared the INSTANT it fires (testOnlyCrashInjection.ts's own one-shot
  // design) — if it's still armed here, the crash never actually happened, which would mean
  // this repetition tested nothing at all.
  expect(isCrashSiteArmed()).toBe(false);
  disarmCrashSite(); // defensive no-op in the normal case; guards against a future site added to ALL_CRASH_SITES that isn't actually reachable from this test's own call shape above

  // Ground truth, independent of anything either coordinator instance believes: did the
  // victim operation's own row actually make it into Postgres?
  const victimCommitted = await isStampCommitted(documentId, victimOp.id);

  // Sites BEFORE the transaction's own COMMIT can never leave the victim committed — this is
  // the reference text's own "CORRECT and EXPECTED" outcome for e.g. site (e), not a failure.
  const PRE_COMMIT_SITES: readonly CrashSite[] = [
    "afterFrameReceipt",
    "afterAuthorization",
    "afterApplyRemote",
    "afterSeqAssignment",
    "afterBroadcast",
    "beforeCommit",
  ];
  if (PRE_COMMIT_SITES.includes(site)) {
    expect(victimCommitted).toBe(false);
  }
  // Sites AFTER the commit (g, h) must never lose it — that's the whole durability claim.
  const POST_COMMIT_SITES: readonly CrashSite[] = ["afterCommit", "afterAck"];
  if (POST_COMMIT_SITES.includes(site)) {
    expect(victimCommitted).toBe(true);
  }
  // (i)/(j) never even attempt to commit the victim a second time — it was already committed
  // normally before either site's own crash fires — so it must always be present.
  if (site === "duringSnapshotWrite" || site === "duringGcCycle") {
    expect(victimCommitted).toBe(true);
  }

  // "Restart": discard the crashed coordinator object; build a fresh one against the SAME
  // real Postgres database (Phase 16's own `serverRestart.db.test.ts` interpretation).
  coordinator = new DocumentCoordinator(documentId, store);
  await coordinator.ready;
  reconnectAll(coordinator, clients);

  // "Resend the victim if (and only if) it never made it into Postgres" — Phase 22/23's own
  // established re-mint-under-a-new-identity reconciliation, not a byte-identical resend.
  if (!victimCommitted) {
    const resend = victim.engine.localInsert(victim.engine.text().length, letterAt(opIndex));
    await processIncomingOperation({ coordinator, session: victim.session, msg: insertMessageFor(resend) });
  }

  // M1: convergence. M2: the victim's own CONTENT present exactly once (never lost, never
  // duplicated — trivially guaranteed against duplication here since a resend always mints a
  // structurally distinct stamp, Engine Spec I1, but the LENGTH check below is what actually
  // proves neither loss nor an accidental extra character crept in).
  const finalText = coordinator.engine.text();
  expect(finalText.length).toBe(7); // 6 baseline + exactly 1 victim, either the original or its resend
  for (const client of clients) {
    expect(client.engine.text()).toBe(finalText);
    expect(client.engine.pending.length).toBe(0);
  }
  expect(coordinator.engine.pending.length).toBe(0);

  // DUR-01: the log-replay audit passes.
  const audit = await auditDocument(documentId, store, { liveText: coordinator.engine.text() });
  expect(audit.result).toBe("ok");
}

describe("Phase 25 DUR-03 — crash injection at all 10 named sites, 100 repetitions", () => {
  it(
    "100/100 repetitions: every previously-acked operation survives, all clients converge, the audit passes",
    async () => {
      const REPETITIONS = 100;
      const perSiteCounts = new Map<CrashSite, number>(ALL_CRASH_SITES.map((s) => [s, 0]));
      for (let i = 0; i < REPETITIONS; i++) {
        // "at a randomly chosen point among 10 predefined injection sites" — uniform over all
        // 10 on every repetition, so 100 repetitions cover every site many times over rather
        // than exactly 10 each.
        const site = ALL_CRASH_SITES[Math.floor(Math.random() * ALL_CRASH_SITES.length)]!;
        perSiteCounts.set(site, perSiteCounts.get(site)! + 1);
        await runOneCrashRepetition(site);
      }
      // Sanity: confirm the random draw actually exercised every one of the 10 sites at least
      // once across 100 repetitions (astronomically likely, but asserted rather than assumed —
      // a site that never fired would mean this test silently covered only 9 of 10).
      for (const site of ALL_CRASH_SITES) {
        expect(perSiteCounts.get(site)!).toBeGreaterThan(0);
      }
      // eslint-disable-next-line no-console -- DUR-03's own DoD wants the per-site breakdown recorded, not just a pass/fail
      console.log(
        "[DUR-03] repetitions per site:",
        Object.fromEntries(perSiteCounts),
      );
    },
    300_000,
  );
});
