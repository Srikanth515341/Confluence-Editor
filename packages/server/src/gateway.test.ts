import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Engine } from "@collab-editor/engine";
import { decodeFrame, encodeFrame, type OpsMessage } from "@collab-editor/protocol";
import { createCollabServer, type CollabServer } from "./server.js";
import { WS_PATH, WS_SUBPROTOCOL } from "./gateway.js";

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
  const port = await s.listen(0); // ephemeral port
  return { port, server: s };
}

function wsUrl(port: number, documentId: string): string {
  return `ws://127.0.0.1:${port}${WS_PATH}?documentId=${encodeURIComponent(documentId)}`;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reasonBuf) => resolve({ code, reason: reasonBuf.toString() }));
  });
}

function waitForBinaryMessage(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data, isBinary) => {
      if (!isBinary) {
        reject(new Error("expected a binary message"));
        return;
      }
      resolve(new Uint8Array(data as Buffer));
    });
  });
}

describe("Health endpoint", () => {
  it("responds on GET /healthz", async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("WebSocket gateway — connection (API Spec §1.2, §3)", () => {
  it("a raw WebSocket client connects at /v1/rt with subprotocol obseq.v1 and exchanges a binary frame", async () => {
    const { port, server: s } = await startServer();
    const ws = new WebSocket(wsUrl(port, "doc-smoke"), WS_SUBPROTOCOL);
    await waitForOpen(ws);
    expect(ws.protocol).toBe(WS_SUBPROTOCOL);

    const insertMsg: OpsMessage = {
      kind: "opInsert",
      seq: 0,
      id: { c: 1, r: 1 },
      originLeft: null,
      originRight: null,
      bind: false,
      value: 0x61,
    };
    ws.send(encodeFrame(insertMsg), { binary: true });

    // Give the server a moment to process — no peer is connected, so nothing is relayed back;
    // this just proves the frame didn't crash the connection or the coordinator.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    const coordinator = s.gateway.coordinators.get("doc-smoke");
    expect(coordinator?.engine.text()).toBe("a");

    ws.close();
    await waitForClose(ws);
  });

  it("a text frame closes the socket with code 1003", async () => {
    const { port } = await startServer();
    const ws = new WebSocket(wsUrl(port, "doc-text"), WS_SUBPROTOCOL);
    await waitForOpen(ws);

    const closed = waitForClose(ws);
    ws.send("this is a text frame, not binary");

    const { code } = await closed;
    expect(code).toBe(1003);
  });

  it("rejects a connection missing the documentId query parameter", async () => {
    const { port } = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, WS_SUBPROTOCOL);
    await waitForOpen(ws);
    const { code } = await waitForClose(ws);
    expect(code).toBe(1008);
  });
});

describe("Two clients, one document — operations reach the other peer and both engines converge", () => {
  it("an insert from client A reaches client B, and their local engines converge", async () => {
    const { port } = await startServer();
    const documentId = "doc-convergence";

    const wsA = new WebSocket(wsUrl(port, documentId), WS_SUBPROTOCOL);
    const wsB = new WebSocket(wsUrl(port, documentId), WS_SUBPROTOCOL);
    await Promise.all([waitForOpen(wsA), waitForOpen(wsB)]);

    // Each client drives its own local Engine, exactly like a real client would (Phase 3's
    // localInsert/applyRemote) — replica ids are arbitrary here since the server allocates
    // its own ids; what matters is that each side's ENGINE state converges.
    const engineA = new Engine(101);
    const engineB = new Engine(202);

    const bReceipt = waitForBinaryMessage(wsB);

    const opA = engineA.localInsert(0, 0x68); // 'h'
    wsA.send(
      encodeFrame({
        kind: "opInsert",
        seq: 0,
        id: opA.id,
        originLeft: opA.originLeft,
        originRight: opA.originRight,
        bind: opA.bind,
        value: opA.value,
      }),
      { binary: true },
    );

    const relayedToB = await bReceipt;
    const relayedMsg = decodeFrame(relayedToB, { direction: "serverOrigin" });
    expect(relayedMsg.kind).toBe("opInsert");
    if (relayedMsg.kind === "opInsert") {
      engineB.applyRemote({
        kind: "insert",
        id: relayedMsg.id,
        value: relayedMsg.value,
        originLeft: relayedMsg.originLeft,
        originRight: relayedMsg.originRight,
        bind: relayedMsg.bind,
      });
      // The relay must be re-stamped with a server-assigned seq (API Spec §3.5.1) — never
      // the client's own seq: 0 sent on the wire.
      expect(relayedMsg.seq).toBeGreaterThan(0);
    }

    expect(engineA.text()).toBe("h");
    expect(engineB.text()).toBe("h");
    expect(engineA.text()).toBe(engineB.text());

    // The sender is never echoed its own operation back.
    let echoed = false;
    wsA.once("message", () => {
      echoed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(echoed).toBe(false);

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });

  it("concurrent inserts from both clients converge to the same text on both sides", async () => {
    const { port } = await startServer();
    const documentId = "doc-concurrent";

    const wsA = new WebSocket(wsUrl(port, documentId), WS_SUBPROTOCOL);
    const wsB = new WebSocket(wsUrl(port, documentId), WS_SUBPROTOCOL);
    await Promise.all([waitForOpen(wsA), waitForOpen(wsB)]);

    const engineA = new Engine(11);
    const engineB = new Engine(22);

    function wireRelay(ws: WebSocket, engine: Engine): void {
      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const msg = decodeFrame(new Uint8Array(data as Buffer), { direction: "serverOrigin" });
        if (msg.kind !== "opInsert") return;
        engine.applyRemote({
          kind: "insert",
          id: msg.id,
          value: msg.value,
          originLeft: msg.originLeft,
          originRight: msg.originRight,
          bind: msg.bind,
        });
      });
    }
    wireRelay(wsA, engineA);
    wireRelay(wsB, engineB);

    const opA = engineA.localInsert(0, 0x41); // 'A', concurrent with B's insert below
    const opB = engineB.localInsert(0, 0x42); // 'B'

    wsA.send(
      encodeFrame({
        kind: "opInsert",
        seq: 0,
        id: opA.id,
        originLeft: opA.originLeft,
        originRight: opA.originRight,
        bind: opA.bind,
        value: opA.value,
      }),
      { binary: true },
    );
    wsB.send(
      encodeFrame({
        kind: "opInsert",
        seq: 0,
        id: opB.id,
        originLeft: opB.originLeft,
        originRight: opB.originRight,
        bind: opB.bind,
        value: opB.value,
      }),
      { binary: true },
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(engineA.text()).toHaveLength(2);
    expect(engineA.text()).toBe(engineB.text());

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });
});
