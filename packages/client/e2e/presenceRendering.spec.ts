import { expect, test } from "@playwright/test";
import { setupPresenceHarnessPage } from "./helpers.js";

/**
 * Phase 33 real-browser presence-rendering coverage (API Spec §8.2/§8.3, Test Plan PRES-02/PRES-07)
 * — the TWO claims that genuinely require real text layout/reflow, which jsdom cannot provide (see
 * `packages/client/src/presence/presenceOverlay.test.ts`'s own header comment for exactly what
 * that file mocks instead, and why everything BESIDES real geometry is already proven there): a
 * real multi-line selection producing MULTIPLE real rectangles (not one enclosing box), and real
 * `scroll`/`resize`-triggered reflow being genuinely re-measured, not just re-triggered.
 *
 * Deliberately does NOT hardcode an exact "N characters per line" expectation — real monospace
 * font metrics can differ slightly across Chromium/Firefox/WebKit. Instead, each assertion
 * compares this project's OWN rendered rect count/position against a SECOND, independently-taken
 * real browser measurement (a fresh `Range.getClientRects()`/`getBoundingClientRect()` call at
 * assertion time, never reusing whatever `PresenceOverlay` itself computed) — proving fidelity to
 * whatever the real browser's real layout engine actually reports, on whichever engine is running
 * this spec, rather than asserting a number this project derived on ONE engine and might not hold
 * on another.
 */

declare global {
  interface Window {
    __presenceHarness?: {
      readonly editor: HTMLElement;
      readonly overlay: HTMLElement;
      readonly domWriter: import("./inputHarnessGlobal.js").HarnessDomWriter;
      readonly engine: import("./inputHarnessGlobal.js").HarnessEngine;
      readonly overlayInstance: import("./inputHarnessGlobal.js").HarnessPresenceOverlay;
      readonly sentinel: import("./inputHarnessGlobal.js").HarnessMutationSentinel;
    };
  }
}

async function waitTwoFrames(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

async function setup(page: import("@playwright/test").Page, text: string): Promise<void> {
  await setupPresenceHarnessPage(page);
  await page.evaluate((docText) => {
    const editor = document.getElementById("editor")!;
    const overlay = document.getElementById("overlay") as HTMLElement;
    const domWriter = new window.InputHarness.DomWriter();
    const engine = new window.InputHarness.Engine(1);
    for (let i = 0; i < docText.length; i++) {
      engine.localInsert(i, docText.codePointAt(i)!);
    }
    domWriter.mount(editor, engine.text());
    const sentinel = new window.InputHarness.MutationSentinel({
      root: editor,
      domWriter,
      getEngineText: () => engine.text(),
    });
    sentinel.start();
    const overlayInstance = new window.InputHarness.PresenceOverlay({
      editorRoot: editor,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
    });
    overlayInstance.start();
    window.__presenceHarness = { editor, overlay, domWriter, engine, overlayInstance, sentinel };
  }, text);
}

test("PRES-02: a selection wrapping across multiple real visual lines renders ONE rectangle per real line, matching the browser's own getClientRects() count exactly -- never a single enclosing box", async ({
  page,
}) => {
  // 120 unbroken characters -- word-break: break-all (helpers.ts's own page shape) guarantees this
  // wraps across several real visual lines at the harness's fixed 300px width, on every engine.
  await setup(page, "a".repeat(120));

  const result = await page.evaluate(() => {
    const { editor, overlay, engine, overlayInstance } = window.__presenceHarness!;
    const anchorVis = 0;
    const focusVis = 110; // near the document end -- spans several real wrapped lines
    const anchor = anchorVis <= 0 ? null : engine.visible()[anchorVis - 1]!.id;
    const focus = engine.visible()[focusVis - 1]!.id;

    overlayInstance.handlePresenceEvent({
      kind: "join",
      replicaId: 2,
      userId: "peer-user-id",
      displayName: "Peer",
      role: 1,
    });
    overlayInstance.handlePresenceEvent({
      kind: "update",
      replicaId: 2,
      anchor,
      focus,
      collapsed: false,
    });

    // An INDEPENDENT real measurement, taken separately from whatever PresenceOverlay itself
    // computed internally -- a fresh Range over the identical visible-index span.
    const startPos = window.InputHarness.visToDom(window.__presenceHarness!.domWriter.index, editor, anchorVis);
    const endPos = window.InputHarness.visToDom(window.__presenceHarness!.domWriter.index, editor, focusVis);
    const independentRange = document.createRange();
    independentRange.setStart(startPos.node, startPos.offset);
    independentRange.setEnd(endPos.node, endPos.offset);
    const independentRectCount = independentRange.getClientRects().length;

    return { independentRectCount, overlay, editor };
  });

  await waitTwoFrames(page);

  const washCount = await page.evaluate(
    () => document.querySelectorAll('[data-presence-kind="selection"]').length,
  );
  const containment = await page.evaluate(() => {
    const { editor, overlay } = window.__presenceHarness!;
    return { editorContainsOverlay: editor.contains(overlay), overlayContainsEditor: overlay.contains(editor) };
  });
  const reconciliation = await page.evaluate(() => window.__presenceHarness!.sentinel.metrics.reconciliation);

  expect(result.independentRectCount).toBeGreaterThanOrEqual(2); // genuinely multi-line on this engine
  expect(washCount).toBe(result.independentRectCount); // exactly matches the real browser's own count
  expect(containment.editorContainsOverlay).toBe(false); // presence renders OUTSIDE the contenteditable subtree
  expect(containment.overlayContainsEditor).toBe(false);
  expect(reconciliation).toBe(0); // presence rendering never triggers the sentinel
});

test("PRES-07: a peer's rendered caret recomputes to the correct NEW position after a real scroll", async ({
  page,
}) => {
  // Enough lines to force real vertical scrolling within the harness's fixed 150px-tall editor.
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  await setup(page, lines);

  const before = await page.evaluate(() => {
    const { editor, engine, overlayInstance } = window.__presenceHarness!;
    const focusVis = engine.stats().visibleLength; // the very end of the document -- below the fold
    overlayInstance.handlePresenceEvent({ kind: "join", replicaId: 2, userId: "peer-id", displayName: "Peer", role: 1 });
    overlayInstance.handlePresenceEvent({
      kind: "update",
      replicaId: 2,
      anchor: engine.visible()[focusVis - 1]!.id,
      focus: engine.visible()[focusVis - 1]!.id,
      collapsed: true,
    });
    void editor;
    return focusVis;
  });
  await waitTwoFrames(page);
  const topBeforeScroll = await page.evaluate(
    () => (document.querySelector('[data-presence-kind="caret"]') as HTMLElement).style.top,
  );

  // A real scroll -- the editor's own overflow-y: auto is what actually scrolls (matching
  // production's `.editor-root` CSS, not `window`).
  await page.evaluate(() => {
    window.__presenceHarness!.editor.scrollTop = window.__presenceHarness!.editor.scrollHeight;
  });
  await waitTwoFrames(page);

  const after = await page.evaluate((focusVis: number) => {
    const { editor, domWriter } = window.__presenceHarness!;
    const caretTop = (document.querySelector('[data-presence-kind="caret"]') as HTMLElement).style.top;
    // An INDEPENDENT real measurement taken AFTER the scroll, against the overlay's own coordinate
    // origin (its parent's bounding rect, matching PresenceOverlay's own `toLocalRect` math).
    const pos = window.InputHarness.visToDom(domWriter.index, editor, focusVis);
    const range = document.createRange();
    range.setStart(pos.node, pos.offset);
    range.collapse(true);
    const rect = range.getClientRects()[0]!;
    const overlayRect = document.getElementById("overlay")!.getBoundingClientRect();
    return { caretTop, expectedTop: rect.top - overlayRect.top };
  }, before);

  expect(after.caretTop).not.toBe(topBeforeScroll); // genuinely recomputed, not stale
  expect(parseFloat(after.caretTop)).toBeCloseTo(after.expectedTop, 0); // matches a fresh real measurement
});

test("PRES-07: a peer's rendered caret recomputes to the correct NEW position after a real resize", async ({
  page,
}) => {
  // A single long unbroken line -- narrowing the editor's width changes WHERE it wraps, which
  // changes the real on-screen position of a caret placed near the end, giving resize something
  // genuine to recompute (unlike a scroll-only test, this exercises reflow, not just scroll offset).
  await setup(page, "b".repeat(80));

  await page.evaluate(() => {
    const { engine, overlayInstance } = window.__presenceHarness!;
    const focusVis = engine.stats().visibleLength;
    overlayInstance.handlePresenceEvent({ kind: "join", replicaId: 3, userId: "peer-id-2", displayName: "Peer2", role: 1 });
    overlayInstance.handlePresenceEvent({
      kind: "update",
      replicaId: 3,
      anchor: engine.visible()[focusVis - 1]!.id,
      focus: engine.visible()[focusVis - 1]!.id,
      collapsed: true,
    });
  });
  await waitTwoFrames(page);
  const topBeforeResize = await page.evaluate(
    () => (document.querySelector('[data-presence-kind="caret"]') as HTMLElement).style.top,
  );

  // A real reflow: narrow the wrapper AND the editor itself, then fire a real 'resize' event
  // (PresenceOverlay listens on `window`, matching API Spec §8.3's own literal wording).
  await page.evaluate(() => {
    const wrapper = document.getElementById("wrapper")!;
    const editor = window.__presenceHarness!.editor;
    wrapper.style.width = "120px";
    editor.style.width = "120px";
    window.dispatchEvent(new Event("resize"));
  });
  await waitTwoFrames(page);

  const after = await page.evaluate((focusVis: number) => {
    const { editor, domWriter } = window.__presenceHarness!;
    const caretTop = (document.querySelector('[data-presence-kind="caret"]') as HTMLElement).style.top;
    const pos = window.InputHarness.visToDom(domWriter.index, editor, focusVis);
    const range = document.createRange();
    range.setStart(pos.node, pos.offset);
    range.collapse(true);
    const rect = range.getClientRects()[0]!;
    const overlayRect = document.getElementById("overlay")!.getBoundingClientRect();
    return { caretTop, expectedTop: rect.top - overlayRect.top };
  }, await page.evaluate(() => window.__presenceHarness!.engine.stats().visibleLength));

  expect(after.caretTop).not.toBe(topBeforeResize); // the narrower width genuinely moved it
  expect(parseFloat(after.caretTop)).toBeCloseTo(after.expectedTop, 0);
});
