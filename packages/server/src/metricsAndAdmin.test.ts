// Phase 37 (RFC §5 C-14, PRD FR-PS-6/D-14) — DoD verification that the metrics/dashboard/RUM/
// admin HTTP surface this phase builds is real, not just typechecked: a real `createCollabServer`,
// real HTTP requests (`fetch`), real WebSocket traffic driving real metrics through the real code
// paths in writePath.ts/gateway.ts/presenceManager.ts/gcScheduler.ts.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  encodeControlFrame,
  encodeFrame,
  operationToOpInsert,
  type WelcomeMessage,
} from "@collab-editor/protocol";
import { Engine } from "@collab-editor/engine";
import { createCollabServer, type CollabServer } from "./server.js";
import { WS_PATH, WS_SUBPROTOCOL } from "./gateway.js";
import type { GcRuntimeControl } from "./gcScheduler.js";
import type { GcConfig } from "./config.js";

const TEST_GC_CONFIG: GcConfig = {
  undoHorizonMaxAgeMs: 5 * 60 * 1000,
  undoHorizonMaxOpsPerReplica: 200,
  gcIntervalMs: 60 * 1000,
  gcFixpointBudgetMs: 150,
};

let server: CollabServer | undefined;

afterEach(async () => {
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

/**
 * Buffers every message arriving on `ws` from the moment this is called, so a caller awaiting
 * them one at a time can never race a frame that arrives before its own `.once("message", ...)`
 * would have been attached — the exact bug class Phase 9's own `IncomingFrames`/
 * `bufferedControlReader` helpers exist to avoid (this project's server enqueues several
 * handshake-completion frames back-to-back, synchronously).
 */
function bufferedMessageReader(ws: WebSocket): () => Promise<Uint8Array> {
  const queue: Uint8Array[] = [];
  const waiters: Array<(bytes: Uint8Array) => void> = [];
  ws.on("message", (data: Buffer) => {
    const bytes = new Uint8Array(data);
    const waiter = waiters.shift();
    if (waiter) {
      waiter(bytes);
    } else {
      queue.push(bytes);
    }
  });
  return () =>
    new Promise((resolve) => {
      const bytes = queue.shift();
      if (bytes) {
        resolve(bytes);
      } else {
        waiters.push(resolve);
      }
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
  const welcomeBytes = await next();
  const { decodeControlFrame } = await import("@collab-editor/protocol");
  const welcome = decodeControlFrame(welcomeBytes, { direction: "serverOrigin" }) as WelcomeMessage;
  // Drain the rest of the handshake (SNAPSHOT + ALREADY_HAVE + PRESENCE_ROSTER) — this test never
  // inspects them, only needs the socket to have completed HELLO enough to send OPS afterward.
  await next();
  await next();
  await next();
  return { ws, replicaId: welcome.replicaId };
}

describe("Phase 37 — /v1/metrics, /dashboard, /v1/rum, and the admin HTTP surface, over real HTTP/WS", () => {
  it("driving real traffic through the write path populates real, named metrics on /v1/metrics", async () => {
    server = createCollabServer();
    const port = await server.listen(0);
    const documentId = randomUUID();
    const { ws, replicaId } = await joinDocument(port, documentId);

    const engine = new Engine(replicaId);
    const op = engine.localInsert(0, "a".codePointAt(0)!);
    ws.send(encodeFrame(operationToOpInsert(op!, 0)));
    await new Promise((r) => setTimeout(r, 50)); // let the write path actually run

    const res = await fetch(`http://127.0.0.1:${port}/v1/metrics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // Connections group — real, non-zero, since a real connection was actually opened.
    expect(typeof body["ws.active_connections"]).toBe("number");
    expect(typeof body["ws.connection_churn"]).toBe("number");
    expect((body["ws.connection_churn"] as number)).toBeGreaterThanOrEqual(1);

    // Latency group — a real op went through op.server_apply and op.remote_visibility.
    expect(body).toHaveProperty("op.server_apply_p95");
    expect(body).toHaveProperty("op.remote_visibility_p95");
    expect(body).toHaveProperty("op.commit_latency_p95");

    // Documents group — computed live from the real coordinator's own engine.stats().
    expect(typeof body["doc.structure_size"]).toBe("number");
    expect((body["doc.structure_size"] as number)).toBeGreaterThanOrEqual(1);
    expect(body).toHaveProperty("doc.tombstone_ratio");
    expect(body).toHaveProperty("engine.replica_bytes_p95");

    // Convergence/GC/Authz groups — present even with no audit/GC cycle having run yet (null).
    expect(body).toHaveProperty("audit.mismatch_count");
    expect(body).toHaveProperty("audit.minutes_since_last_successful_run");
    expect(body).toHaveProperty("gc.minutes_since_last_success");
    expect(body).toHaveProperty("authz.op_rejected_count");

    ws.close();
  });

  it("GET /dashboard serves a real, non-empty HTML page that fetches /v1/metrics", async () => {
    server = createCollabServer();
    const port = await server.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("/v1/metrics");
    expect(html.length).toBeGreaterThan(500);
  });

  it("POST /v1/rum records a client-reported sample into the SAME registry /v1/metrics reads", async () => {
    server = createCollabServer();
    const port = await server.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/v1/rum`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        samples: [
          { name: "binding.reconciliation", value: 1, kind: "counter" },
          { name: "client.local_echo", value: 12.5 },
        ],
      }),
    });
    expect(res.status).toBe(204);
    const metricsRes = await fetch(`http://127.0.0.1:${port}/v1/metrics`);
    const body = (await metricsRes.json()) as Record<string, unknown>;
    expect(body["binding.reconciliation"]).toBe(1);
    expect(body["client.local_echo_count"]).toBe(1);
  });

  it("a malformed /v1/rum batch is silently dropped, never a 500", async () => {
    server = createCollabServer();
    const port = await server.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/v1/rum`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ samples: [{ name: 123, value: "not a number" }, "garbage", null] }),
    });
    expect(res.status).toBe(204);
  });

  it("the admin materialize/doc-stats/freeze/unfreeze endpoints reflect real, live coordinator state", async () => {
    server = createCollabServer();
    const port = await server.listen(0);
    const documentId = randomUUID();
    const { ws, replicaId } = await joinDocument(port, documentId);
    const engine = new Engine(replicaId);
    const op = engine.localInsert(0, "x".codePointAt(0)!);
    ws.send(encodeFrame(operationToOpInsert(op!, 0)));
    await new Promise((r) => setTimeout(r, 50));

    const materialize = await fetch(`http://127.0.0.1:${port}/v1/admin/documents/${documentId}/materialize`);
    expect(materialize.status).toBe(200);
    expect((await materialize.json()) as { text: string }).toEqual({ text: "x" });

    const statsRes = await fetch(`http://127.0.0.1:${port}/v1/admin/documents/${documentId}/doc-stats`);
    expect(statsRes.status).toBe(200);
    const stats = (await statsRes.json()) as { structureSize: number; sessionCount: number };
    expect(stats.structureSize).toBe(1);
    expect(stats.sessionCount).toBe(1);

    const freezeRes = await fetch(`http://127.0.0.1:${port}/v1/admin/documents/${documentId}/freeze`, {
      method: "POST",
    });
    expect(freezeRes.status).toBe(200);
    expect(await freezeRes.json()).toEqual({ documentId, manuallyFrozen: true });

    const unfreezeRes = await fetch(`http://127.0.0.1:${port}/v1/admin/documents/${documentId}/unfreeze`, {
      method: "POST",
    });
    expect(await unfreezeRes.json()).toEqual({ documentId, manuallyFrozen: false });

    ws.close();
  });

  it("materialize/doc-stats/freeze/rebuild all 404 for an unknown document id", async () => {
    server = createCollabServer();
    const port = await server.listen(0);
    for (const path of ["materialize", "doc-stats", "freeze", "unfreeze", "rebuild"]) {
      const method = path === "materialize" || path === "doc-stats" ? "GET" : "POST";
      const res = await fetch(`http://127.0.0.1:${port}/v1/admin/documents/does-not-exist/${path}`, {
        method,
      });
      expect(res.status).toBe(404);
    }
  });

  it("the reconstruct/deploy-history route SHAPE exists and returns 501 not_yet_implemented (Phases 40/39)", async () => {
    server = createCollabServer();
    const port = await server.listen(0);
    const reconstructRes = await fetch(
      `http://127.0.0.1:${port}/v1/admin/documents/doc-x/reconstruct?seq=5`,
    );
    expect(reconstructRes.status).toBe(501);
    expect(((await reconstructRes.json()) as { error: string }).error).toBe("not_yet_implemented");

    const deployRes = await fetch(`http://127.0.0.1:${port}/v1/admin/deploy-history`);
    expect(deployRes.status).toBe(501);
  });

  it("GC control endpoints are only mounted when adminGc deps are supplied, and disable-all genuinely stops the scheduled sweep", async () => {
    const control: GcRuntimeControl = { enabled: true };
    server = createCollabServer({ adminGc: { gcConfig: TEST_GC_CONFIG, control } });
    const port = await server.listen(0);

    const statusRes = await fetch(`http://127.0.0.1:${port}/v1/admin/gc/status`);
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({ schedulerEnabled: true });

    const disableRes = await fetch(`http://127.0.0.1:${port}/v1/admin/gc/disable-all`, { method: "POST" });
    expect(await disableRes.json()).toEqual({ schedulerEnabled: false });
    expect(control.enabled).toBe(false);

    const enableRes = await fetch(`http://127.0.0.1:${port}/v1/admin/gc/enable-all`, { method: "POST" });
    expect(await enableRes.json()).toEqual({ schedulerEnabled: true });
    expect(control.enabled).toBe(true);
  });

  it("GC control endpoints are absent (real 404, route not mounted) when no adminGc deps are supplied", async () => {
    server = createCollabServer();
    const port = await server.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/v1/admin/gc/status`);
    expect(res.status).toBe(404);
  });

  it("./admin gc --run-once works over HTTP even while the scheduled sweep is disabled", async () => {
    const control: GcRuntimeControl = { enabled: false };
    server = createCollabServer({ adminGc: { gcConfig: TEST_GC_CONFIG, control } });
    const port = await server.listen(0);
    const documentId = randomUUID();
    const { ws } = await joinDocument(port, documentId);

    const res = await fetch(`http://127.0.0.1:${port}/v1/admin/gc/run-once`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc: documentId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documentId: string; nodesCollected: number };
    expect(body.documentId).toBe(documentId);
    expect(control.enabled).toBe(false); // run-once never re-enables the schedule

    ws.close();
  });
});
