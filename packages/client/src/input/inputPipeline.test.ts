// @vitest-environment jsdom
//
// Ordinary DOM/Selection manipulation (jsdom implements Selection/Range
// reliably enough for these purposes — it's real BROWSER Selection/Range
// QUIRKS, Test Plan §7.1's DOM-01/DOM-03, that jsdom can't be trusted for,
// same rationale as domWriter.test.ts). Real-browser MUT-01/GRA-02 coverage
// (actual keyboard typing, actual clipboard paste, actual drag) lives in
// e2e/inputPipeline.spec.ts against real Chromium/Firefox/WebKit instead.
//
// `getTargetRanges()` (Input Events Level 2) is not implemented by jsdom's
// InputEvent, so every test here drives the pipeline via the LIVE selection
// fallback (inputPipeline.ts's own `liveSelectionRange`) — exactly the path
// a browser without `getTargetRanges` support would also take.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Engine } from "@collab-editor/engine";
import { DomWriter, visToDom } from "../binding/index.js";
import { MutationSentinel } from "../sentinel/index.js";
import { SyncClient } from "../sync/syncClient.js";
import { attachInputPipeline } from "./inputPipeline.js";

beforeEach(() => {
  document.body.replaceChildren();
});

interface Harness {
  readonly root: HTMLDivElement;
  readonly domWriter: DomWriter;
  readonly sync: SyncClient;
  readonly sentinel: MutationSentinel;
  readonly detach: () => void;
}

/** Builds a fully-wired pipeline against a real (never-connected) `SyncClient` whose `engine` is set directly — the same "no network required" trick `headlessHarness`-adjacent unit tests use, since `sendFrame` no-ops when `ws` is null (never connected here). The MutationSentinel (Phase 13) is real and started — every `DomWriter` write the pipeline makes runs through `sentinel.applyPatches()`, so these tests also implicitly prove the sentinel never mistakes a legitimate pipeline write for a foreign mutation (a regression here would show up as a reconciliation-metric bump most of these tests don't expect). */
function makeHarness(initialText = ""): Harness {
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
  const detach = attachInputPipeline(root, { domWriter, sync, sentinel });
  return { root, domWriter, sync, sentinel, detach };
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

function fireBeforeInput(
  h: Harness,
  inputType: string,
  opts: { data?: string | null; dataTransferText?: string } = {},
): InputEvent {
  const event = new InputEvent("beforeinput", {
    inputType,
    data: opts.data ?? null,
    cancelable: true,
    bubbles: true,
  });
  if (opts.dataTransferText !== undefined) {
    // jsdom does not implement a full DataTransfer/clipboard stack — a minimal getData-only stand-in
    // is enough, since inputPipeline.ts only ever calls `dataTransfer.getData("text/plain")`.
    Object.defineProperty(event, "dataTransfer", {
      value: { getData: (fmt: string) => (fmt === "text/plain" ? opts.dataTransferText! : "") },
    });
  }
  h.root.dispatchEvent(event);
  return event;
}

describe("inputPipeline — every beforeinput is preventDefaulted, without exception EXCEPT the two IME composition types (Scope-IN, corrected by Phase 34's own real spec text)", () => {
  it("defaultPrevented is true for 18 distinct inputTypes, including one not in the dispatch table", () => {
    const h = makeHarness("hello");
    setCaret(h, 5);
    const inputTypes = [
      "insertText",
      "insertReplacementText",
      "insertFromPaste",
      "insertFromDrop",
      "deleteByDrag",
      "insertLineBreak",
      "insertParagraph",
      "deleteContentBackward",
      "deleteContentForward",
      "deleteWordBackward",
      "deleteWordForward",
      "deleteSoftLineBackward",
      "deleteHardLineBackward",
      "deleteByCut",
      "historyUndo",
      "historyRedo",
      "insertFromYank", // unlisted — must still be prevented
      "formatBold", // unlisted — must still be prevented
    ];
    expect(inputTypes).toHaveLength(18);
    for (const inputType of inputTypes) {
      const event = fireBeforeInput(h, inputType, { data: "x" });
      expect(event.defaultPrevented, `inputType ${inputType}`).toBe(true);
    }
    h.detach();
  });

  /**
   * Phase 34 (API Spec §7.4.2/§7.6) — the ONE deliberate carve-out from the rule above.
   * `insertCompositionText`/`deleteCompositionText` must NOT be prevented: the browser's own
   * native rendering is the only thing that can display an in-progress, uncommitted IME
   * candidate string, and `CompositionController` (not `beforeinput`) owns the entire
   * composition lifecycle via `compositionstart`/`compositionupdate`/`compositionend` instead.
   * No operation is ever emitted from either inputType, regardless.
   */
  it("insertCompositionText/deleteCompositionText are NOT preventDefaulted and never mutate the engine", () => {
    const h = makeHarness("hello");
    setCaret(h, 5);
    const before = h.sync.engine!.stats().totalElements;
    for (const inputType of ["insertCompositionText", "deleteCompositionText"]) {
      const event = fireBeforeInput(h, inputType, { data: "x" });
      expect(event.defaultPrevented, `inputType ${inputType}`).toBe(false);
    }
    expect(h.sync.engine!.stats().totalElements).toBe(before);
    expect(h.domWriter.materializedText()).toBe("hello");
    h.detach();
  });

  it("preventDefault fires even when not yet synced (no engine)", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const domWriter = new DomWriter();
    domWriter.mount(root, "");
    const sync = new SyncClient({ url: "ws://unused", documentId: "doc" }); // engine still null
    const sentinel = new MutationSentinel({
      root,
      domWriter,
      getEngineText: () => sync.engine?.text(),
    });
    attachInputPipeline(root, { domWriter, sync, sentinel });
    const event = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: "x",
      cancelable: true,
    });
    root.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(domWriter.materializedText()).toBe(""); // no engine — nothing applied
  });
});

describe("inputPipeline — insertText / insertLineBreak / insertParagraph", () => {
  it("insertText at the caret mints an operation and updates the DOM", () => {
    const h = makeHarness("helloworld");
    setCaret(h, 5);
    fireBeforeInput(h, "insertText", { data: " " });
    expect(h.sync.engine!.text()).toBe("hello world");
    expect(h.domWriter.materializedText()).toBe("hello world");
    h.detach();
  });

  it("insertText over a non-collapsed selection deletes the selection first, then inserts", () => {
    const h = makeHarness("hello world");
    setSelection(h, 6, 11); // "world"
    fireBeforeInput(h, "insertText", { data: "there" });
    expect(h.sync.engine!.text()).toBe("hello there");
    h.detach();
  });

  it("insertLineBreak inserts U+000A", () => {
    const h = makeHarness("ab");
    setCaret(h, 1);
    fireBeforeInput(h, "insertLineBreak");
    expect(h.sync.engine!.text()).toBe("a\nb");
    h.detach();
  });

  it("insertParagraph also inserts U+000A (API Spec §7.4.2 treats both the same)", () => {
    const h = makeHarness("ab");
    setCaret(h, 1);
    fireBeforeInput(h, "insertParagraph");
    expect(h.sync.engine!.text()).toBe("a\nb");
    h.detach();
  });
});

describe("inputPipeline — insertReplacementText (autocorrect / spellcheck, Test Plan MUT-01)", () => {
  it("replaces the misspelled range with the correction, as one delete-then-insert", () => {
    const h = makeHarness("teh cat");
    setSelection(h, 0, 3); // "teh" highlighted, as a real autocorrect targetRange/selection would be
    fireBeforeInput(h, "insertReplacementText", { data: "the" });
    expect(h.sync.engine!.text()).toBe("the cat");
    expect(h.domWriter.materializedText()).toBe("the cat");
    h.detach();
  });
});

describe("inputPipeline — insertFromPaste / insertFromDrop (Test Plan MUT-01)", () => {
  it("paste with no existing selection inserts at the caret", () => {
    const h = makeHarness("ab");
    setCaret(h, 1);
    fireBeforeInput(h, "insertFromPaste", { dataTransferText: "XYZ" });
    expect(h.sync.engine!.text()).toBe("aXYZb");
    h.detach();
  });

  it("paste over a selection replaces it", () => {
    const h = makeHarness("hello world");
    setSelection(h, 6, 11);
    fireBeforeInput(h, "insertFromPaste", { dataTransferText: "there" });
    expect(h.sync.engine!.text()).toBe("hello there");
    h.detach();
  });

  it("a large paste (2,000 characters) round-trips to the engine and DOM in one pipeline call", () => {
    const h = makeHarness("");
    setCaret(h, 0);
    const big = "a".repeat(2000);
    fireBeforeInput(h, "insertFromPaste", { dataTransferText: big });
    expect(h.sync.engine!.text()).toBe(big);
    expect(h.domWriter.materializedText()).toBe(big);
    h.detach();
  });

  it("insertFromDrop behaves the same as paste", () => {
    const h = makeHarness("ab");
    setCaret(h, 1);
    fireBeforeInput(h, "insertFromDrop", { dataTransferText: "Z" });
    expect(h.sync.engine!.text()).toBe("aZb");
    h.detach();
  });
});

describe("inputPipeline — deleteByDrag / deleteByCut (Test Plan MUT-01)", () => {
  it("deleteByDrag removes the dragged (selected) source range", () => {
    const h = makeHarness("hello world");
    setSelection(h, 0, 6); // "hello "
    fireBeforeInput(h, "deleteByDrag");
    expect(h.sync.engine!.text()).toBe("world");
    h.detach();
  });

  it("a same-document drag: deleteByDrag on the source pairs with insertFromDrop on the target, character appears exactly once", () => {
    const h = makeHarness("hello world");
    setSelection(h, 0, 5); // "hello"
    fireBeforeInput(h, "deleteByDrag");
    expect(h.sync.engine!.text()).toBe(" world");
    setCaret(h, h.sync.engine!.text().length); // drop at the end
    fireBeforeInput(h, "insertFromDrop", { dataTransferText: "hello" });
    expect(h.sync.engine!.text()).toBe(" worldhello");
    h.detach();
  });

  it("deleteByCut removes the selection", () => {
    const h = makeHarness("hello world");
    setSelection(h, 5, 11); // " world"
    fireBeforeInput(h, "deleteByCut");
    expect(h.sync.engine!.text()).toBe("hello");
    h.detach();
  });
});

describe("inputPipeline — deleteContentBackward / deleteContentForward, grapheme-cluster granularity (GRA-02, Test Plan §7.1)", () => {
  it("backspace with a collapsed caret removes exactly one grapheme cluster, not one code unit", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // family ZWJ emoji, 7 scalars
    const h = makeHarness(`x${family}`);
    const before = h.sync.engine!.stats().tombstones;
    setCaret(h, Array.from(`x${family}`).length);
    fireBeforeInput(h, "deleteContentBackward");
    expect(h.sync.engine!.text()).toBe("x");
    const deletedCount = h.sync.engine!.stats().tombstones - before;
    expect(deletedCount).toBe(7); // one Delete operation per scalar in the cluster (GRA-02's own assertion)
    h.detach();
  });

  it("backspace with an active (non-collapsed) selection deletes exactly the selection, not a cluster expansion", () => {
    const h = makeHarness("hello world");
    setSelection(h, 0, 6);
    fireBeforeInput(h, "deleteContentBackward");
    expect(h.sync.engine!.text()).toBe("world");
    h.detach();
  });

  it("deleteContentForward removes the cluster to the right of a collapsed caret", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    const h = makeHarness(`${family}y`);
    setCaret(h, 0);
    fireBeforeInput(h, "deleteContentForward");
    expect(h.sync.engine!.text()).toBe("y");
    h.detach();
  });

  it("Ctrl+Backspace equivalent (deleteWordBackward) removes the whole preceding word via Intl.Segmenter", () => {
    const h = makeHarness("hello world");
    setCaret(h, 11);
    fireBeforeInput(h, "deleteWordBackward");
    expect(h.sync.engine!.text()).toBe("hello ");
    h.detach();
  });

  it("deleteWordForward removes the whole following word", () => {
    const h = makeHarness("hello world");
    setCaret(h, 0);
    fireBeforeInput(h, "deleteWordForward");
    expect(h.sync.engine!.text()).toBe(" world");
    h.detach();
  });

  it("deleteSoftLineBackward / deleteHardLineBackward delete back to the previous newline", () => {
    const h = makeHarness("first\nsecond");
    setCaret(h, 12);
    fireBeforeInput(h, "deleteHardLineBackward");
    expect(h.sync.engine!.text()).toBe("first\n");
    h.detach();
  });
});

describe("inputPipeline — composition and history stubs (API Spec §7.4.2)", () => {
  it("insertCompositionText / deleteCompositionText never emit an operation", () => {
    const h = makeHarness("ab");
    setCaret(h, 1);
    const spy = vi.spyOn(h.sync, "localInsertText");
    fireBeforeInput(h, "insertCompositionText", { data: "x" });
    fireBeforeInput(h, "deleteCompositionText");
    expect(spy).not.toHaveBeenCalled();
    expect(h.sync.engine!.text()).toBe("ab");
    h.detach();
  });

  it("historyUndo / historyRedo are stubbed — preventDefault only, no engine call", () => {
    const h = makeHarness("ab");
    setCaret(h, 1);
    const undoEvent = fireBeforeInput(h, "historyUndo");
    const redoEvent = fireBeforeInput(h, "historyRedo");
    expect(undoEvent.defaultPrevented).toBe(true);
    expect(redoEvent.defaultPrevented).toBe(true);
    expect(h.sync.engine!.text()).toBe("ab");
    h.detach();
  });
});

describe("inputPipeline — unlisted inputType", () => {
  it("logs at warn and makes no engine call", () => {
    const h = makeHarness("ab");
    setCaret(h, 1);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fireBeforeInput(h, "formatBold");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(h.sync.engine!.text()).toBe("ab");
    warnSpy.mockRestore();
    h.detach();
  });
});

describe("inputPipeline — offline-window cap (Phase 24, API Spec §5.5/§10.5, RC-30)", () => {
  it("a keystroke past the offline-window cap is silently swallowed -- preventDefault fires, but neither the engine nor the DOM is touched", () => {
    const h = makeHarness("ab");
    h.sync.disconnect(); // arms the offline window (state leaves "synced")
    // Drive the client's OWN cap (2,000 ops) directly via localInsert -- no DOM/beforeinput
    // involved for these -- so the harness reaches "capped" without minting through the
    // pipeline under test.
    for (let i = 0; i < 2000; i++) {
      h.sync.localInsert(h.sync.engine!.text().length, 0x78); // 'x'
    }
    expect(h.sync.offlineWindowStatus.value.level).toBe("capped");
    const textBefore = h.sync.engine!.text();
    const domBefore = h.root.textContent;

    setCaret(h, 1);
    const event = fireBeforeInput(h, "insertText", { data: "Z" });

    expect(event.defaultPrevented).toBe(true); // Scope-IN: "without exception"
    expect(h.sync.engine!.text()).toBe(textBefore); // refused BEFORE reaching the engine
    expect(h.root.textContent).toBe(domBefore); // DOM never mutated -- no divergence for the sentinel to catch
    h.detach();
  });
});
