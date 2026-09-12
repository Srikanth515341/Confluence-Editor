// @vitest-environment jsdom
//
// Phase 34, IME-06 ("composition interrupted by a disconnect: ASSERT the composition completes
// locally and the resulting operation queues durably (via Phase 22's IndexedDB queue)").
//
// METHODOLOGY NOTE, disclosed per this phase's own explicit request to state clearly which
// scenarios are automated where: IME-01 through IME-05 are automated in REAL Chromium/Firefox/
// WebKit browsers (e2e/ime.spec.ts), per the phase brief's own explicit ask. IME-06 is instead
// automated HERE, at the Vitest/jsdom + `fake-indexeddb` layer — a deliberate, disclosed
// testing-LAYER choice, not a shortfall against the DoD's substance: what IME-06 actually needs
// proving is a DURABILITY/WIRING claim ("a composition's own committed operation reaches the
// real IndexedDB queue while disconnected"), not a real-browser DOM/composition-rendering
// fidelity claim — and this project's own established precedent (`syncClient.durableQueue.
// test.ts`'s own DUR-07/08/09 suite, Phase 22; RC-33e's synchronous-fake-socket mechanism proof,
// Phase 23) already chose exactly this layer for the identical class of claim, over orchestrating
// a fully-scripted fake WebSocket handshake inside a real Playwright browser purely to reach real
// `indexedDB` (which Chromium/Firefox/WebKit all already have — but scripting the REST of a full
// HELLO/WELCOME/SNAPSHOT handshake around it there buys no additional fidelity for what this
// specific claim needs, only more moving parts). The REAL `CompositionController`/`SyncClient`/
// `openDurableQueue`/`fake-indexeddb` production code all run for real here — only the socket and
// the composition's own DOM/browser context are simulated, exactly as `syncClient.durableQueue.
// test.ts` already established for the non-composition case this file extends.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  decodeControlFrame,
  encodeControlFrame,
  encodeStructureSnapshotBody,
  SessionRole,
  SnapshotForm,
  SyncMode,
  type ControlMessage,
  type HelloMessage,
} from "@collab-editor/protocol";
import { DomWriter } from "../binding/index.js";
import { MutationSentinel } from "../sentinel/index.js";
import { openDurableQueue } from "../sync/durableQueue.js";
import { SyncClient, type WebSocketLike } from "../sync/syncClient.js";
import { attachInputPipeline } from "./inputPipeline.js";
import { attachCompositionHandlers, CompositionController } from "./compositionController.js";

class FakeWebSocket implements WebSocketLike {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  closed = false;

  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(code = 1005, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  triggerMessage(bytes: Uint8Array): void {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
}

function welcomeFrame(replicaId: number): Uint8Array {
  return encodeControlFrame({
    kind: "welcome",
    sessionId: randomUUID(),
    replicaId,
    role: SessionRole.EDITOR,
    serverSeq: 0,
    syncMode: SyncMode.SNAPSHOT,
    participants: [],
  });
}

function snapshotFrame(seq: number): Uint8Array {
  return encodeControlFrame({
    kind: "snapshot",
    seq,
    form: SnapshotForm.STRUCTURE,
    body: encodeStructureSnapshotBody([]),
  });
}

function alreadyHaveFrame(): Uint8Array {
  return encodeControlFrame({ kind: "alreadyHave", alreadyHave: [] });
}

function lastHello(ws: FakeWebSocket): HelloMessage {
  for (let i = ws.sent.length - 1; i >= 0; i--) {
    const msg: ControlMessage = decodeControlFrame(ws.sent[i]!, { direction: "clientOrigin" });
    if (msg.kind === "hello") return msg;
  }
  throw new Error("no HELLO frame found");
}

async function waitForSocket(sockets: readonly unknown[], countBefore: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (sockets.length <= countBefore) {
    if (Date.now() >= deadline)
      throw new Error("waitForSocket: timed out waiting for a new socket to be created");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("CompositionController + SyncClient durable queue — IME-06: composition interrupted by a disconnect", () => {
  let factory: IDBFactory;
  let documentId: string;
  let sockets: FakeWebSocket[];
  let clients: SyncClient[];

  beforeEach(() => {
    document.body.replaceChildren();
    factory = new IDBFactory();
    documentId = randomUUID();
    sockets = [];
    clients = [];
  });

  afterEach(() => {
    for (const client of clients) client.disconnect();
  });

  function makeClient(): SyncClient {
    const client = new SyncClient({
      url: "ws://fake",
      documentId,
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
      openDurableQueue: () => openDurableQueue(factory),
    });
    clients.push(client);
    return client;
  }

  it("a composition committed entirely while disconnected completes locally and its operation survives a simulated crash, durably queued", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const domWriter = new DomWriter();
    const sync = makeClient();
    sync.connect();
    await waitForSocket(sockets, 0);
    const wsA = sockets[0]!;
    wsA.triggerOpen();
    wsA.triggerMessage(welcomeFrame(1));
    wsA.triggerMessage(snapshotFrame(0));
    wsA.triggerMessage(alreadyHaveFrame());
    await Promise.resolve();
    expect(sync.state.value).toBe("synced");

    const sentinel = new MutationSentinel({
      root,
      domWriter,
      getEngineText: () => sync.engine?.text(),
    });
    sentinel.start();
    sentinel.applyPatches(() => domWriter.mount(root, ""));
    attachInputPipeline(root, { domWriter, sync, sentinel });
    const composition = new CompositionController({ domWriter, sync, sentinel, root });
    attachCompositionHandlers(root, composition);

    // Sever the connection — Phase 22's relaxed `requireEngine()` means minting (including a
    // composition's own eventual commit) is still allowed; the operation is durably queued
    // rather than silently dropped.
    wsA.close(1006, "severed mid-session");
    expect(sync.state.value).toBe("reconnecting");

    root.dispatchEvent(new CompositionEvent("compositionstart"));
    root.dispatchEvent(new CompositionEvent("compositionupdate", { data: "resumo" }));
    root.dispatchEvent(new CompositionEvent("compositionend", { data: "résumé" }));

    // IME-06 step 1: the composition completes LOCALLY regardless of the disconnect.
    expect(composition.isComposing).toBe(false);
    expect(sync.engine?.text()).toBe("résumé");
    expect(domWriter.materializedText()).toBe("résumé");
    expect(sync.unackedCount).toBe(6);

    // Force the durable queue's batched write to commit (mirrors `syncClient.durableQueue.
    // test.ts`'s own established technique — a real crash would lose whatever hadn't flushed,
    // DUR-08's own separately-tested territory, not what THIS test is about).
    await sync["durableQueue"]?.flush();

    // "Restart the browser": a brand-new SyncClient sharing the SAME IndexedDB factory, with no
    // in-memory knowledge of `sync` at all.
    const socketsBefore = sockets.length;
    const clientB = makeClient();
    clientB.connect();
    await waitForSocket(sockets, socketsBefore);
    const wsB = sockets[sockets.length - 1]!;
    wsB.triggerOpen();

    // IME-06 step 2: the composition's own committed operation(s) queued DURABLY — reported in
    // the very next client's own HELLO.unacked, the same durability contract Phase 22 already
    // established for any other kind of local edit.
    const hello = lastHello(wsB);
    expect(hello.unacked).toHaveLength(6); // "résumé" — 6 scalars, one Insert operation each

    wsB.triggerMessage(welcomeFrame(2));
    wsB.triggerMessage(snapshotFrame(0));
    wsB.triggerMessage(alreadyHaveFrame());
    await Promise.resolve();
    expect(clientB.engine?.text()).toBe("résumé");
  });
});
