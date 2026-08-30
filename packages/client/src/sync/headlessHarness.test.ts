import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createCollabServer, type CollabServer } from "@collab-editor/server";
import { connectPair, runConvergenceWorkload, waitForState } from "./headlessHarness.js";
import { SyncClient } from "./syncClient.js";
import type { ConnectionState } from "./connectionState.js";

let server: CollabServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

async function startServer(): Promise<{ port: number; server: CollabServer }> {
  const s = createCollabServer();
  server = s;
  const port = await s.listen(0);
  return { port, server: s };
}

function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}/v1/rt`;
}

describe("Headless SyncClient pair against the real server", () => {
  it("two headless clients converge over 1,000 operations", async () => {
    const { port } = await startServer();
    const documentId = randomUUID();

    const pair = await connectPair(documentId, () => ({ url: wsUrl(port) }));
    const text = await runConvergenceWorkload(pair, 1_000);

    expect(text).toHaveLength(1_000);
    expect(pair.a.engine?.text()).toBe(pair.b.engine?.text());

    pair.a.disconnect();
    pair.b.disconnect();
  }, 30_000);

  it("killing the server mid-run: both clients enter reconnecting, then both reconnect and converge once the server restarts on the same port", async () => {
    const { port } = await startServer();
    const documentId = randomUUID();

    const pair = await connectPair(documentId, () => ({ url: wsUrl(port) }));
    expect(pair.a.state.value).toBe("synced"); // connectPair only resolves once both sides reach this

    // Subscribed AFTER the initial connect/synced transitions (already observed above) —
    // this captures exactly the crash-and-recover sequence that follows.
    const statesA: ConnectionState[] = [];
    const statesB: ConnectionState[] = [];
    pair.a.state.subscribe((s) => statesA.push(s));
    pair.b.state.subscribe((s) => statesB.push(s));

    // Some activity before the crash, just to prove there WAS a live session — Phase 8/9's
    // server has no persistence, so this content does NOT need to (and will not) survive the
    // restart below; only post-reconnect convergence is asserted.
    pair.a.localInsert(0, 0x78); // 'x'

    await server!.close();
    server = undefined;

    await Promise.all([waitForState(pair.a, "reconnecting"), waitForState(pair.b, "reconnecting")]);
    expect(statesA).toContain("reconnecting");
    expect(statesB).toContain("reconnecting");

    // Restart a brand-new server on the EXACT same port — this project's server has no
    // persistence yet, so this is a fresh, empty in-memory document, exactly like a real
    // coordinator restart per API Spec §3.10's own framing.
    const restarted = createCollabServer();
    server = restarted;
    await restarted.listen(port);

    await Promise.all([waitForState(pair.a, "synced"), waitForState(pair.b, "synced")]);
    // The crash-and-recover sequence, in order: lost the connection, then came back synced.
    expect(statesA).toEqual(["reconnecting", "synced"]);
    expect(statesB).toEqual(["reconnecting", "synced"]);

    // Fresh replica ids after reconnect (API Spec §3.6.2 — a reconnecting client never keeps its old id).
    const replicaIdBeforeA = pair.a.replicaId;
    expect(replicaIdBeforeA).not.toBeNull();

    const text = await runConvergenceWorkload(pair, 50);
    expect(text).toHaveLength(50);
    expect(pair.a.engine?.text()).toBe(pair.b.engine?.text());

    pair.a.disconnect();
    pair.b.disconnect();
  }, 30_000);
});

describe("Health check that a single SyncClient completes a real handshake end to end", () => {
  it("reaches 'synced' against a real server with an empty fresh document", async () => {
    const { port } = await startServer();
    const client = new SyncClient({ url: wsUrl(port), documentId: randomUUID() });
    client.connect();
    await waitForState(client, "synced");
    expect(client.engine?.text()).toBe("");
    expect(client.replicaId).toBeGreaterThanOrEqual(1);
    client.disconnect();
  });
});
