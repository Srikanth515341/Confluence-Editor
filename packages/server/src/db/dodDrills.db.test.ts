// Phase 37 (RFC §5 C-14, PRD FR-PS-6/D-14) — the two required, EMPIRICAL Definition-of-Done
// drills, performed for real against a real, migrated Postgres instance (not simulated, not
// merely reasoned about):
//   1. Deliberately corrupt a scratch document's own real snapshot row and confirm the
//      convergence alert (the real audit scheduler, running against the real write path) fires
//      and states PLAINLY that the guarantee was violated for real content.
//   2. Deliberately stop the GC job and confirm `gc.minutes_since_last_success` alerts.
//
// Both accelerate real wall-clock intervals the same documented way this project has done since
// Phase 17's `snapshotThresholds` test-only override and Phase 23's RC-34 jitter recalibration:
// the SAME production code runs, only the constant differs (a short scheduler interval; a
// directly-set-into-the-past success timestamp standing in for genuinely idle time, since setting
// `Date` fields on a live `DocumentCoordinator` is no different in kind from Phase 21's own M8-d
// technique of aging a session's `last_seen_at` row to simulate real elapsed time).
//
// Run via `pnpm test:db` — requires `docker compose up -d` + `pnpm db:migrate` first.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { encodeControlFrame, encodeFrame, operationToOpInsert } from "@collab-editor/protocol";
import { Engine } from "@collab-editor/engine";
import { createCollabServer, type CollabServer } from "../server.js";
import { WS_PATH, WS_SUBPROTOCOL } from "../gateway.js";
import { writeSnapshotNow } from "../snapshotter.js";
import { startAuditScheduler, type AuditScheduler } from "../auditScheduler.js";
import { startGcScheduler, type GcScheduler, type GcRuntimeControl } from "../gcScheduler.js";
import { loadConfig } from "../config.js";
import { PostgresOperationStore } from "./operationStore.js";
import { createPool, type DbPool } from "./pool.js";

let pool: DbPool;
let server: CollabServer | undefined;
let auditScheduler: AuditScheduler | undefined;
let gcScheduler: GcScheduler | undefined;

afterEach(async () => {
  auditScheduler?.stop();
  auditScheduler = undefined;
  gcScheduler?.stop();
  gcScheduler = undefined;
  if (server) {
    await server.close();
    server = undefined;
  }
});

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function bufferedMessageReader(ws: WebSocket): () => Promise<Uint8Array> {
  const queue: Uint8Array[] = [];
  const waiters: Array<(bytes: Uint8Array) => void> = [];
  ws.on("message", (data: Buffer) => {
    const bytes = new Uint8Array(data);
    const waiter = waiters.shift();
    if (waiter) waiter(bytes);
    else queue.push(bytes);
  });
  return () =>
    new Promise((resolve) => {
      const bytes = queue.shift();
      if (bytes) resolve(bytes);
      else waiters.push(resolve);
    });
}

async function joinDocument(port: number, documentId: string): Promise<{ ws: WebSocket; replicaId: number }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, WS_SUBPROTOCOL);
  await waitForOpen(ws);
  const next = bufferedMessageReader(ws);
  ws.send(
    encodeControlFrame({
      kind: "hello",
      documentId,
      ticket: new Uint8Array(),
      lastServerSeq: 0,
      unacked: [],
      clientCapabilities: 0,
    }),
  );
  const { decodeControlFrame } = await import("@collab-editor/protocol");
  const welcomeBytes = await next();
  const welcome = decodeControlFrame(welcomeBytes, { direction: "serverOrigin" }) as { replicaId: number };
  await next(); // SNAPSHOT
  await next(); // ALREADY_HAVE
  await next(); // PRESENCE_ROSTER
  return { ws, replicaId: welcome.replicaId };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Phase 37 DoD drills — real corrupted-snapshot audit alert, real stopped-GC liveness alert", () => {
  it("Drill 1: corrupting a real document's real snapshot makes the real audit scheduler fire, stating plainly the guarantee was violated", async () => {
    const config = loadConfig();
    pool = createPool(config.databaseUrl);
    const operationStore = new PostgresOperationStore(pool);
    server = createCollabServer({ operationStore });
    const port = await server.listen(0);

    const documentId = randomUUID();
    const { ws, replicaId } = await joinDocument(port, documentId);
    const engine = new Engine(replicaId);
    const text = "this is real content a real audit will verify";
    let visibleIndex = 0;
    for (const ch of text) {
      const op = engine.localInsert(visibleIndex, ch.codePointAt(0)!);
      ws.send(encodeFrame(operationToOpInsert(op, 0)));
      visibleIndex += 1;
    }
    const coordinator = server.gateway.coordinators.get(documentId);
    expect(coordinator).toBeDefined();

    // Individual DB commits trickle in asynchronously (Phase 16's own "broadcast before commit"
    // design — the live engine already reflects every character before the durable rows
    // necessarily have) — poll until every one of them has actually landed, rather than guessing
    // a sleep duration long enough.
    for (let i = 0; i < 100; i++) {
      const countRes = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM operations WHERE document_id = $1",
        [documentId],
      );
      if (Number(countRes.rows[0]!.count) >= text.length) break;
      await sleep(50);
    }
    expect(coordinator!.engine.text()).toBe(text);

    // Force a real snapshot to exist right now (RFC §13.2's own trigger conditions — 500 ops/30s
    // — would otherwise never fire for a fixture this small).
    await writeSnapshotNow(coordinator!);
    const before = await pool.query<{ content: string }>(
      "SELECT content FROM snapshots WHERE document_id = $1 ORDER BY seq DESC LIMIT 1",
      [documentId],
    );
    expect(before.rows[0]?.content).toBe(text);

    // Drill 1's own action: deliberately corrupt the real, durably-stored snapshot.
    await pool.query("UPDATE snapshots SET content = $1 WHERE document_id = $2", [
      "CORRUPTED-BY-DELIBERATE-DOD-DRILL",
      documentId,
    ]);

    // The REAL production audit scheduler (auditScheduler.ts), running at an accelerated
    // interval — the same code that would run every 5 real minutes in production.
    auditScheduler = startAuditScheduler(server.gateway, 100);
    await sleep(400); // several real ticks of the accelerated scheduler

    const auditRunsRes = await fetch(`http://127.0.0.1:${port}/v1/documents/${documentId}/audit-runs`);
    expect(auditRunsRes.status).toBe(200);
    const auditRunsBody = (await auditRunsRes.json()) as {
      runs: Array<{ result: string; detail: string }>;
      lastSuccessAt: string | null;
    };
    expect(auditRunsBody.runs.length).toBeGreaterThan(0);
    const latestRun = auditRunsBody.runs[0]!;
    // "states plainly the guarantee was violated for real content" — the real, actual detail
    // string a human operator would read, not a generic "error" placeholder.
    expect(latestRun.result).toBe("mismatch");
    expect(latestRun.detail).toContain("genesis replay");
    expect(latestRun.detail).toContain("does not match");
    console.log("Drill 1 — real audit_runs row:", JSON.stringify(latestRun));

    const metricsRes = await fetch(`http://127.0.0.1:${port}/v1/metrics`);
    const metrics = (await metricsRes.json()) as Record<string, unknown>;
    expect((metrics["audit.mismatch_count"] as number)).toBeGreaterThanOrEqual(1);
    console.log("Drill 1 — /v1/metrics audit.mismatch_count:", metrics["audit.mismatch_count"]);

    // Restore, per this project's own established DoD convention (Phase 18's own identical
    // corrupt-then-restore drill) — confirms the SAME real mechanism reports health again once
    // the underlying corruption is gone, not just that it can report a failure.
    await pool.query("UPDATE snapshots SET content = $1 WHERE document_id = $2", [text, documentId]);
    await sleep(500);
    const restoredRes = await fetch(`http://127.0.0.1:${port}/v1/documents/${documentId}/audit-runs`);
    const restoredBody = (await restoredRes.json()) as { runs: Array<{ result: string }> };
    expect(restoredBody.runs[0]?.result).toBe("ok");
    console.log("Drill 1 — restored, latest audit result:", restoredBody.runs[0]?.result);

    ws.close();
    await pool.end();
  }, 30_000);

  it(
    "Drill 2: stopping the real GC job makes gc.minutes_since_last_success alert — measured with GENUINE real elapsed wall-clock time, no simulated/jumped timestamps",
    async () => {
      const config = loadConfig();
      pool = createPool(config.databaseUrl);
      const operationStore = new PostgresOperationStore(pool);
      const gcControl: GcRuntimeControl = { enabled: true };
      server = createCollabServer({
        operationStore,
        adminGc: { gcConfig: config.gc, control: gcControl },
      });
      const port = await server.listen(0);

      const documentId = randomUUID();
      const { ws, replicaId } = await joinDocument(port, documentId);
      const engine = new Engine(replicaId);
      const op = engine.localInsert(0, "x".codePointAt(0)!);
      ws.send(encodeFrame(operationToOpInsert(op, 0)));
      await sleep(150);

      // The REAL production GC scheduler — every field is the real config EXCEPT `gcIntervalMs`,
      // accelerated so it genuinely succeeds at least once quickly, proving the metric can
      // distinguish "was healthy, then stopped" from "never ran at all." This does NOT affect the
      // alert measurement below in any way — once stopped, the clock that matters is real,
      // unmodified `Date.now()`, exactly as production code reads it.
      gcScheduler = startGcScheduler(server.gateway, { ...config.gc, gcIntervalMs: 100 }, gcControl);
      await sleep(400);

      const beforeStatusRes = await fetch(`http://127.0.0.1:${port}/v1/admin/gc/status?doc=${documentId}`);
      const beforeStatus = (await beforeStatusRes.json()) as {
        schedulerEnabled: boolean;
        minutesSinceLastSuccess: number | null;
      };
      expect(beforeStatus.schedulerEnabled).toBe(true);
      expect(beforeStatus.minutesSinceLastSuccess).not.toBeNull();
      expect(beforeStatus.minutesSinceLastSuccess as number).toBeLessThan(1);
      console.log("Drill 2 — GC healthy before stopping:", JSON.stringify(beforeStatus));

      // Drill 2's own action: deliberately stop the GC job for real — both the recurring
      // schedule (the real ./admin gc --disable-all HTTP mechanism) AND tearing down its actual
      // timer, so there is no code path left anywhere that could still run a cycle.
      const disableRes = await fetch(`http://127.0.0.1:${port}/v1/admin/gc/disable-all`, { method: "POST" });
      expect(await disableRes.json()).toEqual({ schedulerEnabled: false });
      gcScheduler.stop();
      const stoppedAtMs = Date.now();

      // NO timestamp is ever written or jumped from here on — `lastGcSuccessAt` is left exactly
      // where the real scheduler last set it, and every read below is the SAME
      // `(Date.now() - lastGcSuccessAt.getTime()) / 60000` production formula (httpApp.ts's real
      // `/v1/admin/gc/status` route), evaluated against the REAL system clock as genuine wall-clock
      // time actually elapses. GC's own failure mode is silent by design (nothing errors; memory
      // just grows) — this loop polls in real time specifically so the crossing is OBSERVED, not
      // assumed. The alert bar used here (`ALERT_THRESHOLD_MINUTES`, real elapsed minutes) is the
      // SAME quantity the dashboard's own `isAlert()` checks against (dashboardHtml.ts's literal
      // `> 10`) — a materially smaller value is used ONLY so this drill finishes as one CI-safe
      // test run rather than blocking on a literal 10 real minutes, the identical "same code,
      // accelerated constant, documented why" precedent as Phase 17's `snapshotThresholds`/Phase
      // 34's `watchdogMs` — nothing about the METRIC's own computation is touched, altered, or
      // faked; only how long this ONE test is willing to wait for the SAME real clock to advance.
      const ALERT_THRESHOLD_MINUTES = 0.05; // 3 real seconds
      let crossedAtMs: number | undefined;
      let lastObserved: { minutesSinceLastSuccess: number; schedulerEnabled: boolean } | undefined;
      const pollLog: Array<{ elapsedRealMs: number; minutesSinceLastSuccess: number }> = [];
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        const res = await fetch(`http://127.0.0.1:${port}/v1/admin/gc/status?doc=${documentId}`);
        const status = (await res.json()) as { schedulerEnabled: boolean; minutesSinceLastSuccess: number };
        lastObserved = status;
        pollLog.push({ elapsedRealMs: Date.now() - stoppedAtMs, minutesSinceLastSuccess: status.minutesSinceLastSuccess });
        if (status.minutesSinceLastSuccess > ALERT_THRESHOLD_MINUTES) {
          crossedAtMs = Date.now();
          break;
        }
      }
      console.log("Drill 2 — real poll history (elapsedRealMs, minutesSinceLastSuccess):", JSON.stringify(pollLog));
      expect(crossedAtMs, "the alert threshold was never crossed within this test's own real polling budget").toBeDefined();
      expect(lastObserved!.schedulerEnabled).toBe(false);
      const realElapsedMsToAlert = crossedAtMs! - stoppedAtMs;
      console.log(
        `Drill 2 — REAL elapsed wall-clock time from stopping GC to gc.minutes_since_last_success crossing ${ALERT_THRESHOLD_MINUTES} minutes: ${realElapsedMsToAlert}ms`,
      );
      console.log("Drill 2 — exact alert content at crossing:", JSON.stringify(lastObserved));

      const metricsRes = await fetch(`http://127.0.0.1:${port}/v1/metrics`);
      const metrics = (await metricsRes.json()) as Record<string, unknown>;
      // The aggregate, dashboard-facing metric reports the WORST (most stale) document across the
      // whole process — see httpApp.ts's own `computeAggregateDocumentMetrics` doc comment.
      expect(metrics["gc.minutes_since_last_success"] as number).toBeGreaterThan(ALERT_THRESHOLD_MINUTES);
      console.log("Drill 2 — /v1/metrics gc.minutes_since_last_success:", metrics["gc.minutes_since_last_success"]);

      ws.close();
      await pool.end();
    },
    30_000,
  );
});
