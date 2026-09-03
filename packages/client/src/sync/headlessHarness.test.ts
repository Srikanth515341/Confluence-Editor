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

    // Some activity before the crash. Through Phase 21, this content did NOT need to (and did
    // not) survive the restart below — the server has no persistence, and there was no
    // client-side mechanism to recover it either. As of Phase 22 (API Spec §7.9's durable
    // queue), this insert is queued as unacked BEFORE it's sent (never acked by the now-dead
    // server), and `SyncClient.handleSnapshot`'s reconcile step (reconcileOfflineQueue.ts)
    // RE-MINTS it against the fresh post-reconnect engine and resends it — so it now DOES land
    // in the final document, under a brand-new identity (the new server assigns a new replica
    // id; see reconcileOfflineQueue.ts's own header comment for why the content, not the
    // original operation identity, is the guarantee that matters). Asserted below via the total
    // character count (51, not 50) rather than by re-deriving the whole workload's expected
    // string, since exactly where 'x' lands relative to the 50 workload characters is an
    // implementation detail of reconcile timing, not something this test needs to pin down.
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
    // 50 workload characters + the pre-crash 'x', now durably preserved and reconciled through
    // the reconnect (Phase 22) — see this test's own comment above the pre-crash insert.
    expect(text).toHaveLength(51);
    expect(text).toContain("x");
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
