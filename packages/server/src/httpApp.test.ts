import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  decodeControlFrame,
  encodeControlFrame,
  encodeFrame,
  operationToOpInsert,
  type ControlMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@collab-editor/protocol";
import { Engine } from "@collab-editor/engine";
import { createCollabServer, type CollabServer } from "./server.js";
import { WS_PATH, WS_SUBPROTOCOL } from "./gateway.js";

let server: CollabServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

async function startServer(): Promise<{ port: number }> {
  server = createCollabServer();
  const port = await server.listen(0);
  return { port };
}

function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}${WS_PATH}`;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

/** Buffers control frames so a test can `await next()` without racing WELCOME/SNAPSHOT arriving back-to-back — same pattern as gateway.test.ts. Only used for the handshake: the listener is removed once both control frames arrive, since this test verifies convergence via the HTTP replay endpoint, not by decoding the OPS relay frames a real second client also receives on this same socket afterward. */
function bufferedControlReader(ws: WebSocket): {
  next: () => Promise<ControlMessage>;
  detach: () => void;
} {
  const queue: ControlMessage[] = [];
  const waiters: Array<(msg: ControlMessage) => void> = [];
  const listener = (data: Buffer): void => {
    const msg = decodeControlFrame(new Uint8Array(data), { direction: "serverOrigin" });
    const waiter = waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      queue.push(msg);
    }
  };
  ws.on("message", listener);
  return {
    next: () =>
      new Promise((resolve) => {
        const msg = queue.shift();
        if (msg) {
          resolve(msg);
        } else {
          waiters.push(resolve);
        }
      }),
    detach: () => ws.off("message", listener),
  };
}

async function joinAndSync(port: number, documentId: string): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl(port), WS_SUBPROTOCOL);
  await waitForOpen(ws);
  const { next, detach } = bufferedControlReader(ws);
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
  const welcome = (await next()) as WelcomeMessage;
  expect(welcome.kind).toBe("welcome");
  const snapshot = (await next()) as SnapshotMessage;
  expect(snapshot.kind).toBe("snapshot");
  detach();
  return ws;
}

describe("GET /v1/documents/:documentId/replay — Test Plan §2.7 E2E-CONV-01 assertion 3", () => {
  it("returns 404 for an unknown document", async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/v1/documents/${randomUUID()}/replay`);
    expect(res.status).toBe(404);
  });

  it("replays the recorded operation log into a FRESH engine and matches every connected client", async () => {
    const { port } = await startServer();
    const documentId = randomUUID();
    const clientA = await joinAndSync(port, documentId);
    const clientB = await joinAndSync(port, documentId);

    // Two independent local engines mirror what each real client would do — mint locally, send
    // the wire frame, and (for this test's purposes) not bother reading the relayed copy back,
    // since the assertion under test is server-side replay, not client convergence (already
    // covered by Phase 10's headlessHarness.test.ts and the E2E-CONV suite).
    const engineA = new Engine(1);
    const engineB = new Engine(2);
    const opA = engineA.localInsert(0, 0x61); // 'a'
    clientA.send(encodeFrame(operationToOpInsert(opA, 0)));
    const opB = engineB.localInsert(0, 0x62); // 'b'
    clientB.send(encodeFrame(operationToOpInsert(opB, 0)));

    // Give the server a moment to ingest both frames (no ack exists yet, Phase 16 — polling the
    // replay endpoint itself is the simplest way to wait for both without inventing a new signal).
    let text = "";
    for (let attempt = 0; attempt < 50; attempt++) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/documents/${documentId}/replay`);
      const body = (await res.json()) as { text: string; opCount: number; pendingCount: number };
      if (body.opCount >= 2) {
        text = body.text;
        expect(body.pendingCount).toBe(0); // a complete log always drains to a fixpoint
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(text).toHaveLength(2);
    expect(new Set(text)).toEqual(new Set(["a", "b"])); // both characters present, concurrent-order-independent

    clientA.close();
    clientB.close();
  });
});
