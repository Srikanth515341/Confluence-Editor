// Phase 16 DoD's headline claim, verified through the REAL server
// construction path (createCollabServer -> createGateway ->
// DocumentCoordinator), not just by constructing a DocumentCoordinator
// directly the way durability.db.test.ts's other tests do: "Operations
// persist; server restart replays the log and restores state." Requires
// a real, migrated Postgres instance — see durability.db.test.ts's own
// header comment for setup. Run via `pnpm test:db`.

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { Engine } from "@collab-editor/engine";
import {
  decodeControlFrame,
  decodeStructureSnapshotBody,
  encodeControlFrame,
  encodeFrame,
  operationToOpInsert,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@collab-editor/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createCollabServer, type CollabServer } from "../server.js";
import { WS_PATH, WS_SUBPROTOCOL } from "../gateway.js";
import { PostgresOperationStore } from "./operationStore.js";
import { createPool, type DbPool } from "./pool.js";

let server: CollabServer | undefined;
let pool: DbPool | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  if (pool) {
    await pool.end();
    pool = undefined;
  }
});

function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}${WS_PATH}`;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

/** Minimal HELLO -> WELCOME -> SNAPSHOT exchange — a smaller, local copy of gateway.test.ts's own helper (not imported from there — that file's helpers are private to it, and this test's needs are simple enough not to warrant extracting a shared module across two already-large test files). */
async function connectAndHandshake(
  port: number,
  documentId: string,
): Promise<{ ws: WebSocket; welcome: WelcomeMessage; snapshot: SnapshotMessage }> {
  const ws = new WebSocket(wsUrl(port), WS_SUBPROTOCOL);
  await waitForOpen(ws);

  const messages: Uint8Array[] = [];
  const waiters: Array<(bytes: Uint8Array) => void> = [];
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const bytes = new Uint8Array(data as Buffer);
    const waiter = waiters.shift();
    if (waiter) waiter(bytes);
    else messages.push(bytes);
  });
  const next = (): Promise<Uint8Array> => {
    const already = messages.shift();
    if (already) return Promise.resolve(already);
    return new Promise((resolve) => waiters.push(resolve));
  };

  ws.send(
    encodeControlFrame({
      kind: "hello",
      documentId,
      ticket: new Uint8Array(),
      lastServerSeq: 0,
      unacked: [],
      clientCapabilities: 0,
    }),
    { binary: true },
  );

  const welcome = decodeControlFrame(await next(), { direction: "serverOrigin" });
  if (welcome.kind !== "welcome") {
    throw new Error(`expected WELCOME, got ${welcome.kind}`);
  }
  const snapshot = decodeControlFrame(await next(), { direction: "serverOrigin" });
  if (snapshot.kind !== "snapshot") {
    throw new Error(`expected SNAPSHOT, got ${snapshot.kind}`);
  }
  return { ws, welcome, snapshot };
}

describe("Phase 16 DoD — a real server restart replays the log and restores state", () => {
  it("content committed before a restart is present in a fresh server's SNAPSHOT after it", async () => {
    const config = loadConfig();
    const documentId = randomUUID();

    // First server instance: a real HTTP+WS server, a real PostgresOperationStore.
    const poolA = createPool(config.databaseUrl);
    const serverA = createCollabServer({ operationStore: new PostgresOperationStore(poolA) });
    server = serverA;
    const portA = await serverA.listen(0);

    const { ws: wsA, welcome: welcomeA } = await connectAndHandshake(portA, documentId);
    // A real client, minting through a real Engine using the server-assigned replica id (Phase
    // 16's write path rejects anything else — API Spec §6.3 step 2).
    const engineA = new Engine(welcomeA.replicaId);
    for (const value of [0x68, 0x69]) {
      // "hi"
      const op = engineA.localInsert(engineA.text().length, value);
      wsA.send(encodeFrame(operationToOpInsert(op, 0)), { binary: true });
    }
    // Give the server a moment to commit both inserts before tearing it down.
    await new Promise((resolve) => setTimeout(resolve, 100));
    wsA.close();

    await serverA.close();
    server = undefined;
    await poolA.end();
    pool = undefined;

    // Second server instance: SAME database, a brand-new process's worth of in-memory state
    // (a fresh Map of coordinators — nothing here reuses serverA's DocumentCoordinator or its
    // engine). If persistence were fake, this SNAPSHOT would come back empty.
    const poolB = createPool(config.databaseUrl);
    const serverB = createCollabServer({ operationStore: new PostgresOperationStore(poolB) });
    server = serverB;
    pool = poolB;
    const portB = await serverB.listen(0);

    const { ws: wsB, snapshot: snapshotB } = await connectAndHandshake(portB, documentId);
    const textB = decodeStructureSnapshotBody(snapshotB.body)
      .filter((n) => !n.deleted)
      .map((n) => String.fromCodePoint(n.value))
      .join("");
    expect(textB).toBe("hi");
    wsB.close();
  });
});
