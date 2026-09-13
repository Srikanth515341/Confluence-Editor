import { expect, test } from "@playwright/test";
import { setupInputHarnessPage } from "./helpers.js";
// inputHarnessGlobal.d.ts is an ambient declaration file — picked up automatically via
// e2e/tsconfig.json's "include", no import needed.

/**
 * Phase 36 real-browser undo/redo coverage — Test Plan UWIRE-02/UWIRE-03, against real
 * Chromium, Firefox, AND WebKit (playwright.config.ts). UNDO-01..11's own CONVERGENCE/semantic
 * claims (does undo revert only the invoking user's own op, does the OQ-3 no-op rule hold,
 * etc.) are proven at the engine level (packages/engine/src/engine.test.ts) — nothing about
 * those claims depends on real browser DOM/event behavior, so re-proving them here would add
 * browser-startup cost for zero additional fidelity. What DOES genuinely need a real browser:
 *  - UWIRE-02: whether a real browser's own native undo accelerator (Ctrl+Z/Cmd+Z) dispatches
 *    BOTH a `beforeinput(historyUndo)` AND triggers our own `keydown` fallback for the SAME
 *    physical keystroke — only a real browser's own internal event-dispatch behavior can show
 *    this; jsdom's own `undoRedoController.test.ts` already proves the DEDUP LOGIC itself
 *    (given two synchronous triggers, exactly one action results) but cannot prove whether a
 *    real browser actually produces two triggers for one keystroke in the first place.
 *  - UWIRE-03: whether a real browser's own native undo manager (`document.execCommand('undo')`)
 *    genuinely finds nothing to undo after 100 real keystrokes — this is a claim about the
 *    browser's OWN internal undo-stack bookkeeping, which only a real browser has at all.
 */

interface HarnessState {
  readonly editor: HTMLElement;
  readonly domWriter: import("./inputHarnessGlobal.js").HarnessDomWriter;
  readonly sync: import("./inputHarnessGlobal.js").HarnessSyncClient;
  readonly sentinel: import("./inputHarnessGlobal.js").HarnessMutationSentinel;
  readonly undoRedo: import("./inputHarnessGlobal.js").HarnessUndoRedoController;
}

declare global {
  interface Window {
    __harness?: HarnessState;
  }
}

async function setupHarness(
  page: import("@playwright/test").Page,
  initialText = "",
): Promise<void> {
  await setupInputHarnessPage(page);
  await page.evaluate((text) => {
    const editor = document.getElementById("editor")!;
    const domWriter = new window.InputHarness.DomWriter();
    const sync = new window.InputHarness.SyncClient({ url: "ws://unused", documentId: "doc" });
    sync.seedForTesting(new window.InputHarness.Engine(1));
    if (text.length > 0) {
      sync.localInsertText(0, text);
    }
    const sentinel = new window.InputHarness.MutationSentinel({
      root: editor,
      domWriter,
      getEngineText: () => sync.engine?.text(),
    });
    sentinel.applyPatches(() => domWriter.mount(editor, text));
    sentinel.start();
    const undoRedo = new window.InputHarness.UndoRedoController({ sync });
    window.InputHarness.attachInputPipeline(editor, { domWriter, sync, sentinel, undoRedo });
    window.InputHarness.attachUndoRedoKeydownFallback(editor, undoRedo);
    window.__harness = { editor, domWriter, sync, sentinel, undoRedo };
  }, initialText);
}

async function engineText(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => window.__harness!.sync.engine!.text());
}

async function placeCaretAtEnd(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const { editor } = window.__harness!;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

test("UWIRE-02: a real Ctrl+Z keypress performs EXACTLY ONE undo, regardless of how many event sources this browser fires for it", async ({
  page,
}) => {
  await setupHarness(page, "");
  await page.click("#editor");
  await page.keyboard.type("hello");
  expect(await engineText(page)).toBe("hello");

  // A single real physical keypress — whatever combination of `beforeinput(historyUndo)` and/or
  // `keydown` THIS browser actually dispatches for it, our shared microtask guard must collapse
  // into exactly one undo.
  await page.keyboard.press("Control+z");
  // Let any pending microtask/event dispatch settle.
  await page.waitForFunction(() => window.__harness!.sync.engine!.text() !== "hello");

  expect(await engineText(page)).toBe("hell"); // exactly ONE character undone, not two
});

test("UWIRE-02 (Mac accelerator): Cmd+Z performs exactly one undo", async ({ page }) => {
  await setupHarness(page, "");
  await page.click("#editor");
  await page.keyboard.type("ab");
  expect(await engineText(page)).toBe("ab");

  await page.keyboard.press("Meta+z");
  await page.waitForFunction(() => window.__harness!.sync.engine!.text() !== "ab");
  expect(await engineText(page)).toBe("a");
});

test("UWIRE-02: a real Ctrl+Shift+Z (redo) after Ctrl+Z (undo) performs exactly one redo", async ({
  page,
}) => {
  await setupHarness(page, "");
  await page.click("#editor");
  await page.keyboard.type("xy");
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => window.__harness!.sync.engine!.text() === "x");

  await page.keyboard.press("Control+Shift+z");
  await page.waitForFunction(() => window.__harness!.sync.engine!.text() === "xy");
  expect(await engineText(page)).toBe("xy");
});

test("Scope-IN: Ctrl+Y (Windows) performs redo", async ({ page }) => {
  await setupHarness(page, "");
  await page.click("#editor");
  await page.keyboard.type("m");
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => window.__harness!.sync.engine!.text() === "");

  await page.keyboard.press("Control+y");
  await page.waitForFunction(() => window.__harness!.sync.engine!.text() === "m");
  expect(await engineText(page)).toBe("m");
});

test("UWIRE-02 (deliberate double-fire simulation): a real beforeinput(historyUndo) dispatch AND a real keydown(Ctrl+Z) dispatch for the same tick still perform exactly one undo", async ({
  page,
}) => {
  // Even if this specific browser/OS combination happens NOT to naturally dispatch both event
  // sources for one physical keystroke, the guard itself must still be correct when a browser
  // DOES (documented browser variation is exactly why Scope-IN asks for BOTH a beforeinput
  // handler AND a keydown fallback in the first place) — this test drives both real event
  // objects directly, synchronously, in the same page.evaluate call (the same "same task, before
  // any microtask runs" shape a genuine double-dispatching browser would produce).
  await setupHarness(page, "hello");
  await placeCaretAtEnd(page);

  await page.evaluate(() => {
    const { editor } = window.__harness!;
    const beforeInputEvent = new InputEvent("beforeinput", {
      inputType: "historyUndo",
      cancelable: true,
      bubbles: true,
    });
    editor.dispatchEvent(beforeInputEvent);
    const keydownEvent = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    editor.dispatchEvent(keydownEvent);
  });
  await page.waitForFunction(() => window.__harness!.sync.engine!.text() !== "hello");

  expect(await engineText(page)).toBe("hell"); // exactly one character undone
});

test("UWIRE-03: after 100 real keystrokes, the browser's OWN native undo (document.execCommand) does NOT change the document — the native undo stack is empty by construction", async ({
  page,
}) => {
  await setupHarness(page, "");
  await page.click("#editor");
  const text = Array.from({ length: 100 }, (_, i) => String.fromCharCode(0x61 + (i % 26))).join("");
  await page.keyboard.type(text);
  expect(await engineText(page)).toBe(text);
  const domTextBefore = await page.evaluate(() => document.getElementById("editor")!.textContent);
  expect(domTextBefore).toBe(text);

  // The browser's OWN native undo, via the Edit-menu-equivalent API — not our own pipeline at
  // all. Every beforeinput this project ever sees is preventDefault()'d (Scope-IN, API Spec
  // §7.4.2), so the browser's own native editing command stack should never have accumulated
  // anything to undo, regardless of whether it even implements `execCommand('undo')` at all.
  const result = await page.evaluate(() => {
    try {
      return { supported: true, returned: document.execCommand("undo") };
    } catch (err) {
      return { supported: false, error: String(err) };
    }
  });

  // ASSERT the document does NOT change, regardless of what execCommand itself reports (a
  // browser may legitimately report `false`/throw for an unsupported or already-empty command —
  // the actual claim under test is "the content is unaffected," not "execCommand succeeds").
  expect(await engineText(page)).toBe(text);
  const domTextAfter = await page.evaluate(() => document.getElementById("editor")!.textContent);
  expect(domTextAfter).toBe(text);
  void result; // captured for debugging only — not part of the assertion, per this test's own reasoning above
});
