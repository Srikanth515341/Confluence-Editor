// @vitest-environment jsdom
//
// Phase 34 (API Spec §7.4.2/§7.6, Test Plan IME-01..IME-06). Composition is
// simulated via synthetic `CompositionEvent` dispatch (jsdom implements
// these reliably enough — it's real BROWSER Selection/Range QUIRKS that
// jsdom can't be trusted for, same rationale as inputPipeline.test.ts), per
// the phase brief's own explicitly sanctioned methodology: "Simulate
// composition via Playwright's own synthetic compositionstart/
// compositionupdate/compositionend event dispatch... this exercises the
// actual code paths (state machine, buffering, watchdog) correctly." These
// jsdom tests exercise the identical production code the real-browser
// e2e/ime.spec.ts suite does, at a faster, more deterministic layer
// (fake timers for the watchdog's own exact-boundary behavior, no real
// browser startup) — the real-browser suite is what actually proves this
// works across Chromium/Firefox/WebKit, per this phase's own DoD.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "@collab-editor/engine";
import {
  decodeFrame,
  encodeControlFrame,
  encodeStructureSnapshotBody,
  SessionRole,
  SnapshotForm,
  SyncMode,
  type WelcomeMessage,
} from "@collab-editor/protocol";
import { DomWriter, visToDom } from "../binding/index.js";
import { MutationSentinel } from "../sentinel/index.js";
import { SyncClient, type WebSocketLike } from "../sync/syncClient.js";
import {
  attachCompositionHandlers,
  CompositionController,
  type CompositionControllerDeps,
} from "./compositionController.js";
import { attachInputPipeline } from "./inputPipeline.js";

beforeEach(() => {
  document.body.replaceChildren();
});

/** A single microtask turn — MutationObserver callbacks are queued as microtasks, so a reconciliation triggered by a mutation made outside `applyPatches()` is not yet reflected in `sentinel.metrics` until this resolves (same helper shape as `mutationSentinel.test.ts`'s own `flushMicrotasks`). */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

interface Harness {
  readonly root: HTMLDivElement;
  readonly domWriter: DomWriter;
  readonly sync: SyncClient;
  readonly sentinel: MutationSentinel;
  readonly composition: CompositionController;
  readonly detach: () => void;
}

/**
 * The same "no network required" harness `inputPipeline.test.ts` already established
 * (`seedForTesting` — `sendFrame` no-ops while `ws` is null), extended with a real,
 * fully-wired `CompositionController` attached to the SAME root — mirroring exactly what
 * `EditorView.tsx` assembles, minus React itself.
 */
function makeHarness(initialText = "", watchdogMs?: number): Harness {
  const root = document.createElement("div");
  document.body.appendChild(root); // jsdom's Selection API expects live-document nodes
  const domWriter = new DomWriter();
  const sync = new SyncClient({ url: "ws://unused", documentId: "doc" });
  sync.seedForTesting(new Engine(1));
  const sentinel = new MutationSentinel({
    root,
    domWriter,
    getEngineText: () => sync.engine?.text(),
  });
  sentinel.start();
  if (initialText.length > 0) {
    sync.localInsertText(0, initialText);
  }
  sentinel.applyPatches(() => domWriter.mount(root, initialText));
  const detachInput = attachInputPipeline(root, { domWriter, sync, sentinel });
  const deps: CompositionControllerDeps =
    watchdogMs === undefined
      ? { domWriter, sync, sentinel, root }
      : { domWriter, sync, sentinel, root, watchdogMs };
  const composition = new CompositionController(deps);
  const detachComposition = attachCompositionHandlers(root, composition);
  const detach = (): void => {
    detachInput();
    detachComposition();
    composition.dispose();
  };
  return { root, domWriter, sync, sentinel, composition, detach };
}

/** Places a collapsed caret at visible (scalar) index `v`. */
function setCaret(h: Harness, v: number): void {
  const pos = visToDom(h.domWriter.index, h.root, v);
  const range = document.createRange();
  range.setStart(pos.node, pos.offset);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Selects the visible (scalar) range [start, end). */
function setSelection(h: Harness, start: number, end: number): void {
  const a = visToDom(h.domWriter.index, h.root, start);
  const b = visToDom(h.domWriter.index, h.root, end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

function fireComposition(
  h: Harness,
  type: "compositionstart" | "compositionupdate" | "compositionend",
  data = "",
): void {
  h.root.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
}

/**
 * A fully synchronous, fully controllable stand-in for the DOM `WebSocket` — the same shape
 * `syncClient.test.ts` already establishes, reused here (not imported — this project's own
 * convention is each test file owns its own small copy rather than a shared test-helper module,
 * see e.g. `mutationSentinel.test.ts`'s own local `flushMicrotasks`) because THIS one specific
 * IME-01 test needs to inspect literal wire frames (Test Plan IME-01's own "ASSERT exactly ONE
 * OP_INSERT_RUN was sent"), which a `seedForTesting`-based harness (never connected, `ws` stays
 * null) cannot observe at all.
 */
class FakeWebSocket implements WebSocketLike {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: Uint8Array[] = [];

  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
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

/** Builds a fully-wired, REALLY-CONNECTED harness (real handshake over a fake socket, real DOM/composition wiring) — for the one assertion that needs literal wire frames. */
async function makeConnectedHarness(): Promise<Harness & { readonly ws: FakeWebSocket }> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const domWriter = new DomWriter();
  let ws!: FakeWebSocket;
  const sync = new SyncClient({
    url: "ws://fake",
    documentId: "11111111-1111-4111-8111-111111111111",
    createSocket: () => {
      ws = new FakeWebSocket();
      return ws;
    },
  });
  const sentinel = new MutationSentinel({
    root,
    domWriter,
    getEngineText: () => sync.engine?.text(),
  });
  sentinel.start();
  const detachInput = attachInputPipeline(root, { domWriter, sync, sentinel });
  const composition = new CompositionController({ domWriter, sync, sentinel, root });
  const detachComposition = attachCompositionHandlers(root, composition);

  sync.connect();
  ws.triggerOpen();
  const welcome: WelcomeMessage = {
    kind: "welcome",
    sessionId: "22222222-2222-4222-8222-222222222222",
    replicaId: 1,
    role: SessionRole.EDITOR,
    serverSeq: 0,
    syncMode: SyncMode.SNAPSHOT,
    participants: [],
  };
  ws.triggerMessage(encodeControlFrame(welcome));
  ws.triggerMessage(
    encodeControlFrame({
      kind: "snapshot",
      seq: 0,
      form: SnapshotForm.STRUCTURE,
      body: encodeStructureSnapshotBody([]),
    }),
  );
  ws.triggerMessage(encodeControlFrame({ kind: "alreadyHave", alreadyHave: [] }));
  await Promise.resolve(); // finishHandshakeAfterAlreadyHave runs as a chained microtask — see syncClient.test.ts's own comment
  sentinel.applyPatches(() => domWriter.mount(root, ""));

  const detach = (): void => {
    detachInput();
    detachComposition();
    composition.dispose();
  };
  return { root, domWriter, sync, sentinel, composition, detach, ws };
}

describe("CompositionController — IME-01: no operations during composition, exactly one commit", () => {
  it("sends ZERO OPS frames during composition, then exactly ONE OP_INSERT_RUN containing the committed text", async () => {
    const h = await makeConnectedHarness();
    setCaret(h, 0);

    fireComposition(h, "compositionstart");
    const sentBeforeComposing = h.ws.sent.length;
    for (const data of ["s", "su", "sus", "sushi"]) {
      fireComposition(h, "compositionupdate", data);
    }
    // ZERO new frames of any kind while composing (Test Plan IME-01 step 3).
    expect(h.ws.sent.length).toBe(sentBeforeComposing);

    fireComposition(h, "compositionend", "sushi");

    const newFrames = h.ws.sent.slice(sentBeforeComposing);
    expect(newFrames).toHaveLength(1); // exactly ONE frame
    const decoded = decodeFrame(newFrames[0]!, { direction: "clientOrigin" });
    expect(decoded.kind).toBe("opInsertRun"); // exactly one OP_INSERT_RUN (5 chars -> a run, Phase 12)
    if (decoded.kind === "opInsertRun") {
      // §3.5.2's own run encoding round-trips the scalars as UTF-8 text — reconstructing it here
      // is the literal "containing the committed text" assertion, at the wire-byte level.
      expect(String.fromCodePoint(...decoded.values)).toBe("sushi");
    }
    expect(h.sync.engine!.text()).toBe("sushi");
  });
});

describe("CompositionController — IME-01: no operations during composition, exactly one commit (structure-only)", () => {
  it("emits zero ops across 8 intermediate compositionupdate states, then exactly one insert of the committed text", () => {
    const h = makeHarness();
    setCaret(h, 0);

    fireComposition(h, "compositionstart");
    expect(h.composition.isComposing).toBe(true);

    const before = h.sync.engine!.stats().totalElements;
    // 8 intermediate romaji->kanji candidate states (Test Plan IME-01's own "8 intermediate
    // states"), none of which may mint anything.
    const candidates = ["k", "ka", "kan", "kanj", "kanji", "かんじ", "漢字", "感じ"];
    for (const data of candidates) {
      fireComposition(h, "compositionupdate", data);
    }
    // Zero ops minted during composition — the engine's own node count is unchanged.
    expect(h.sync.engine!.stats().totalElements).toBe(before);

    fireComposition(h, "compositionend", "感じ"); // the final committed candidate, 2 characters
    expect(h.composition.isComposing).toBe(false);
    expect(h.sync.engine!.text()).toBe("感じ");
    expect(h.domWriter.materializedText()).toBe("感じ");
    // Exactly one commit's worth of nodes (2 characters) — a single OP_INSERT_RUN's worth,
    // confirmed at the engine-structure level; the exact wire-frame-count assertion (was it
    // literally ONE OP_INSERT_RUN on the wire) is `syncClient.localInsertText`'s own already-
    // established, separately-tested contract (Phase 12's own "2,000 chars -> ONE frame" proof,
    // `syncClient.test.ts`) — this commit path calls that exact same method.
    expect(h.sync.engine!.stats().totalElements - before).toBe(2);
  });
});

describe("CompositionController — IME-04: composition replacing a selection", () => {
  it("emits the selection deletion as an ordinary operation BEFORE composition begins, and the committed text lands where the selection was", () => {
    const h = makeHarness("0123456789");
    setSelection(h, 2, 5); // selects "234"

    fireComposition(h, "compositionstart");
    // The selection is deleted IMMEDIATELY, as an ordinary operation — before any composition
    // text exists at all.
    expect(h.sync.engine!.text()).toBe("0156789");
    expect(h.domWriter.materializedText()).toBe("0156789");

    fireComposition(h, "compositionupdate", "X");
    fireComposition(h, "compositionend", "XYZ");

    expect(h.sync.engine!.text()).toBe("01XYZ56789");
    expect(h.domWriter.materializedText()).toBe("01XYZ56789");
  });
});

describe("CompositionController — IME-02/03: a remote operation mid-composition", () => {
  /** Mints `text` on a SECOND, independent engine seeded identically to `h`'s, then relays the resulting operations directly into `h`'s own engine via `applyRemote` — the same "two simulated clients, no real network" technique this project's own DUR-01/audit tests use (Phase 18). */
  function relayRemoteInsert(h: Harness, atVisibleIndex: number, text: string): void {
    const peer = new SyncClient({ url: "ws://unused", documentId: "doc" });
    const peerEngine = new Engine(2);
    peer.seedForTesting(peerEngine);
    // Seed the peer to the SAME starting content by replaying h's own current visible sequence —
    // simplest correct approach at this fixture's own small scale: apply h's engine's own nodes.
    for (const node of h.sync.engine!.nodes) {
      peerEngine.applyRemote({
        kind: "insert",
        id: node.id,
        value: node.value,
        parent: node.parent,
        side: node.side,
        bind: node.bind,
      });
      if (node.deleted && node.deletedBy) {
        peerEngine.applyRemote({ kind: "delete", id: node.deletedBy, target: node.id });
      }
    }
    const ops = peer.localInsertText(atVisibleIndex, text);
    for (const op of ops) {
      h.sync.engine!.applyRemote(op);
    }
  }

  /** Mirrors EditorView.tsx's own `onRemoteOpsApplied` handler exactly (composition/capture/mount/restore), since this harness has no React component to wire it through automatically. */
  function reactToRemoteOps(h: Harness): void {
    const engine = h.sync.engine!;
    if (h.composition.noteRemoteOpsApplied()) {
      return;
    }
    h.sentinel.applyPatches(() => h.domWriter.mount(h.root, engine.text()));
  }

  it("IME-02: A's composition survives a peer's 20-character insert elsewhere; A's DOM is not disturbed until compositionend; both converge afterward", () => {
    const h = makeHarness("hello world");
    setCaret(h, 11); // end of the document — composing a NEW word after it

    fireComposition(h, "compositionstart");
    fireComposition(h, "compositionupdate", "k");

    relayRemoteInsert(h, 0, "PEER-TWENTY-CHARS!!!"); // 20 chars, inserted at the very start
    reactToRemoteOps(h);

    // The composition survives — not aborted by the remote arrival.
    expect(h.composition.isComposing).toBe(true);
    // The peer's text is NOT yet rendered into A's DOM (it IS already in the engine, per
    // Scope-IN's "buffered at the BINDING layer, not the engine").
    expect(h.domWriter.materializedText()).toBe("hello world");
    expect(h.sync.engine!.text()).toContain("PEER-TWENTY-CHARS!!!");
    expect(h.composition.bufferedRemoteOpsCount).toBeGreaterThan(0);

    fireComposition(h, "compositionend", "kanji");

    // Flushed: A's DOM now reflects BOTH the peer's insert and A's own committed composition.
    expect(h.composition.isComposing).toBe(false);
    expect(h.domWriter.materializedText()).toBe(h.sync.engine!.text());
    expect(h.sync.engine!.text()).toBe("PEER-TWENTY-CHARS!!!hello worldkanji");
    expect(h.composition.bufferedRemoteOpsCount).toBe(0);
  });

  it("IME-03: a remote insert landing EXACTLY at the composition anchor still commits correctly (anchor is identifier-based, not a stale numeric index)", () => {
    const h = makeHarness("ab");
    setCaret(h, 1); // between "a" and "b" — A will compose right here

    fireComposition(h, "compositionstart");
    fireComposition(h, "compositionupdate", "x");

    // B inserts exactly at A's own composing position (visible index 1 — the same spot A's
    // anchor resolves to). A raw numeric anchor captured as "1" would now be WRONG: A's intended
    // insertion point is still "immediately after the original 'a'", not "visible index 1",
    // which now names the FIRST character of B's own insert instead.
    relayRemoteInsert(h, 1, "B-INSERT");
    reactToRemoteOps(h);
    expect(h.domWriter.materializedText()).toBe("ab"); // still buffered, not yet shown

    fireComposition(h, "compositionend", "X");

    // Correct result: A's committed "X" lands right after "a" and before B's insert — the
    // anchor (originally the identifier for "a") resolved correctly regardless of what got
    // inserted in between.
    expect(h.sync.engine!.text()).toBe("aXB-INSERTb");
    expect(h.domWriter.materializedText()).toBe("aXB-INSERTb");
  });
});

describe("CompositionController — MutationSentinel is suspended for the duration of a composition", () => {
  it("does not reconcile (revert) a foreign-looking mutation while composing, but resumes reconciling immediately after commit", async () => {
    const h = makeHarness("hi");
    setCaret(h, 2);
    fireComposition(h, "compositionstart");
    expect(h.sentinel.metrics.reconciliation).toBe(0);

    // A mutation NOT routed through applyPatches — exactly the shape MutationSentinel would
    // ordinarily revert. While composing, this must be left alone (the real browser performs
    // mutations exactly like this one for its own native composition preview). `sentinel.stop()`
    // means the underlying MutationObserver is disconnected, so there is no async callback to
    // even wait for here — the absence is provable synchronously.
    const textNode = h.root.firstChild as Text;
    textNode.data = "hi-native-preview";
    expect(h.sentinel.metrics.reconciliation).toBe(0); // NOT reverted — sentinel is suspended

    fireComposition(h, "compositionend", "!");
    expect(h.sync.engine!.text()).toBe("hi!");
    expect(h.domWriter.materializedText()).toBe("hi!");

    // Sentinel is resumed: a genuinely foreign mutation AFTER commit is caught again. Its own
    // MutationObserver callback is a microtask — flush one before asserting (same pattern
    // `mutationSentinel.test.ts` itself already establishes).
    const textNode2 = h.root.firstChild as Text;
    textNode2.data = "corrupted";
    await flushMicrotasks();
    expect(h.sentinel.metrics.reconciliation).toBe(1);
    expect(h.domWriter.materializedText()).toBe("hi!"); // reverted back
  });
});

describe("CompositionController — IME-05: the 10-second watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT fire at 9,999ms but force-commits at exactly 10,000ms (the real, shipped default)", () => {
    const h = makeHarness();
    setCaret(h, 0);
    fireComposition(h, "compositionstart");
    fireComposition(h, "compositionupdate", "watchdog-text");

    vi.advanceTimersByTime(9_999);
    expect(h.composition.isComposing).toBe(true);
    expect(h.sync.engine!.text()).toBe("");

    vi.advanceTimersByTime(1);
    expect(h.composition.isComposing).toBe(false);
    expect(h.sync.engine!.text()).toBe("watchdog-text");
    expect(h.domWriter.materializedText()).toBe("watchdog-text");
  });

  it("a genuine compositionend arriving right after a force-commit is a no-op (composing is already false)", () => {
    const h = makeHarness();
    setCaret(h, 0);
    fireComposition(h, "compositionstart");
    fireComposition(h, "compositionupdate", "x");
    vi.advanceTimersByTime(10_000);
    expect(h.sync.engine!.text()).toBe("x");

    fireComposition(h, "compositionend", "SHOULD-NOT-APPLY");
    expect(h.sync.engine!.text()).toBe("x"); // unchanged — the composition was already force-ended
  });

  it("honors an injected, shorter watchdog threshold (test-only override, matches Phase 17's own snapshotThresholds precedent)", () => {
    const h = makeHarness("", 50);
    setCaret(h, 0);
    fireComposition(h, "compositionstart");
    fireComposition(h, "compositionupdate", "fast");

    vi.advanceTimersByTime(49);
    expect(h.composition.isComposing).toBe(true);
    vi.advanceTimersByTime(1);
    expect(h.composition.isComposing).toBe(false);
    expect(h.sync.engine!.text()).toBe("fast");
  });

  it("dispose() clears an armed watchdog so it can never fire after unmount", () => {
    const h = makeHarness();
    setCaret(h, 0);
    fireComposition(h, "compositionstart");
    h.detach();
    vi.advanceTimersByTime(10_000);
    // No throw, and (since the controller is detached) nothing observable changed.
    expect(h.sync.engine!.text()).toBe("");
  });
});

describe("CompositionController — defensive/no-op paths", () => {
  it("compositionupdate/compositionend with no open composition are no-ops", () => {
    const h = makeHarness("x");
    fireComposition(h, "compositionupdate", "stray");
    fireComposition(h, "compositionend", "stray");
    expect(h.sync.engine!.text()).toBe("x");
    expect(h.composition.isComposing).toBe(false);
  });

  it("compositionstart before the engine exists (never synced) is inert", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const domWriter = new DomWriter();
    const sync = new SyncClient({ url: "ws://unused", documentId: "doc" });
    const sentinel = new MutationSentinel({
      root,
      domWriter,
      getEngineText: () => sync.engine?.text(),
    });
    const composition = new CompositionController({ domWriter, sync, sentinel, root });
    attachCompositionHandlers(root, composition);
    root.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(composition.isComposing).toBe(false);
  });
});
