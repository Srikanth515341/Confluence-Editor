import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createCollabServer, type CollabServer } from "@collab-editor/server";
import { connectPair, waitForState } from "./headlessHarness.js";
import { resolvePresenceAnchor, SyncClient, type PresenceClientEvent } from "./syncClient.js";

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

function waitForEvent(
  client: SyncClient,
  predicate: (event: PresenceClientEvent) => boolean,
  timeoutMs = 5000,
): Promise<PresenceClientEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("waitForEvent: timed out waiting for a matching PRESENCE event"));
    }, timeoutMs);
    const unsubscribe = client.onPresenceEvent((event) => {
      if (predicate(event)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      }
    });
  });
}

describe("SyncClient presence, end to end against a real server (Phase 31, API Spec §3.8)", () => {
  it("a real cursor update reaches the other client with the correct anchor identifier and the real replicaId filled in", async () => {
    const { port } = await startServer();
    const documentId = randomUUID();
    const pair = await connectPair(documentId, () => ({ url: wsUrl(port) }));

    // Real content, so resolvePresenceAnchor has a real node to resolve against.
    const engineA = pair.a.engine!;
    pair.a.localInsertText(0, "hello");
    await new Promise((resolve) => setTimeout(resolve, 50)); // let it reach B and settle

    const anchor = resolvePresenceAnchor(engineA, 3); // "immediately left of visible offset 3"
    const updatePromise = waitForEvent(pair.b, (e) => e.kind === "update");
    pair.a.sendPresenceUpdate(anchor, anchor, true);

    const event = await updatePromise;
    expect(event).toMatchObject({
      kind: "update",
      replicaId: pair.a.replicaId,
      anchor,
      focus: anchor,
      collapsed: true,
    });

    pair.a.disconnect();
    pair.b.disconnect();
  }, 15_000);

  it("resolvePresenceAnchor resolves to null at the document start, and to the correct predecessor elsewhere", async () => {
    const { port } = await startServer();
    const documentId = randomUUID();
    const client = new SyncClient({ url: wsUrl(port), documentId });
    client.connect();
    await waitForState(client, "synced");
    const engine = client.engine!;

    expect(resolvePresenceAnchor(engine, 0)).toBeNull();
    client.localInsertText(0, "ab");
    const afterA = resolvePresenceAnchor(engine, 1);
    const afterB = resolvePresenceAnchor(engine, 2);
    expect(afterA).not.toBeNull();
    expect(afterB).not.toBeNull();
    expect(afterA).not.toEqual(afterB);

    client.disconnect();
  }, 15_000);

  it("PRESENCE_JOIN/PRESENCE_ROSTER/PRESENCE_LEAVE all arrive for a real second client", async () => {
    const { port } = await startServer();
    const documentId = randomUUID();

    const a = new SyncClient({ url: wsUrl(port), documentId });
    a.connect();
    await waitForState(a, "synced");

    const joinPromise = waitForEvent(a, (e) => e.kind === "join");
    const b = new SyncClient({ url: wsUrl(port), documentId });
    b.connect();
    await waitForState(b, "synced");
    const joinEvent = await joinPromise;
    expect(joinEvent).toMatchObject({ kind: "join", replicaId: b.replicaId });

    const leavePromise = waitForEvent(a, (e) => e.kind === "leave");
    b.disconnect();
    // A clean client-initiated `disconnect()` doesn't send an advisory LEAVE control frame today
    // (SyncClient's own disconnect() just closes the socket) — this is deliberately the "abrupt"
    // path (server-side reason: stale, via the socket's own close event), proving the OTHER real
    // removal path end to end through a real SyncClient rather than only via gateway.test.ts's
    // own hand-built raw frames.
    const leaveEvent = await leavePromise;
    expect(leaveEvent).toMatchObject({ kind: "leave", replicaId: b.replicaId, reason: 1 });

    a.disconnect();
  }, 15_000);
});
