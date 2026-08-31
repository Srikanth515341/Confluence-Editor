import { expect, test } from "@playwright/test";
import { setupInputHarnessPage } from "./helpers.js";
// inputHarnessGlobal.d.ts is an ambient declaration file — picked up automatically via
// e2e/tsconfig.json's "include", no import needed.

/**
 * Phase 12 real-browser input-pipeline coverage — Test Plan MUT-01 (the
 * inputType sweep) and GRA-02 (grapheme-cluster backspace), against real
 * Chromium, Firefox, AND WebKit (playwright.config.ts) — jsdom cannot be
 * trusted for real Selection/InputEvent/contenteditable behavior, same
 * rationale as Phase 11's DOM-01/DOM-03 suites.
 *
 * Methodology, stated explicitly per-test below rather than uniformly,
 * since MUT-01's own text asks for "real browser interaction rather than
 * synthetic events" but this project has no OS-level automation and no
 * live server yet (no dev server exists in this repo, Phase 12 does not
 * add one):
 *  - Typing and backspace/Ctrl+Backspace: REAL key presses via Playwright's
 *    `page.keyboard`, which a real contenteditable turns into real,
 *    browser-generated `beforeinput` events — genuinely not synthetic.
 *  - Autocorrect, spellcheck-via-context-menu, paste, drag, and cut: no
 *    headless-automatable OS/clipboard trigger exists for these, so each
 *    is exercised by directly dispatching a real `InputEvent` (via
 *    `element.dispatchEvent`, still a REAL event object handled by REAL
 *    browser event-dispatch machinery and this project's REAL listener —
 *    only its origin is synthetic, not its handling) carrying the
 *    `inputType` a genuine trigger would have produced. This is the
 *    project's own documented, defensible call for this phase (in the
 *    same vein as Phase 8's `documentId` interim binding or Phase 9's
 *    WELCOME participant-list scoping) — not a byte-layout invention, and
 *    only a testing-methodology decision.
 */

interface HarnessState {
  readonly editor: HTMLElement;
  readonly domWriter: import("./inputHarnessGlobal.js").HarnessDomWriter;
  readonly sync: import("./inputHarnessGlobal.js").HarnessSyncClient;
  readonly sentinel: import("./inputHarnessGlobal.js").HarnessMutationSentinel;
}

declare global {
  interface Window {
    __harness?: HarnessState;
  }
}

/** Builds the harness (DomWriter + a never-connected SyncClient with its engine seeded directly + the Phase 13 MutationSentinel + the input pipeline attached) and stashes it on `window.__harness` for later `page.evaluate` calls in the same test. */
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
    window.InputHarness.attachInputPipeline(editor, { domWriter, sync, sentinel });
    window.__harness = { editor, domWriter, sync, sentinel };
  }, initialText);
}

async function engineText(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => window.__harness!.sync.engine!.text());
}

async function domText(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => window.__harness!.domWriter.materializedText());
}

/** Collapses the caret at visible (scalar) index `v` via a real Selection, inside the page. */
async function placeCaret(page: import("@playwright/test").Page, v: number): Promise<void> {
  await page.evaluate((visIndex) => {
    const { domWriter, editor } = window.__harness!;
    const runs = domWriter.index;
    // Minimal inline visToDom equivalent — the full function isn't exported on this bundle to keep
    // it small; runs are always ASCII in these fixtures, so scalar === UTF-16 offset here.
    let node: Node = editor;
    let offset = 0;
    for (const run of runs) {
      if (visIndex <= run.startVis + run.scalarLen) {
        node = run.textNode;
        offset = visIndex - run.startVis;
        break;
      }
    }
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, v);
}

/** Selects the visible ASCII range [start, end) via a real Selection. */
async function selectRange(
  page: import("@playwright/test").Page,
  start: number,
  end: number,
): Promise<void> {
  await page.evaluate(
    ({ start: s, end: e }) => {
      const { domWriter, editor } = window.__harness!;
      const runs = domWriter.index;
      function locate(v: number): { node: Node; offset: number } {
        for (const run of runs) {
          if (v <= run.startVis + run.scalarLen) {
            return { node: run.textNode, offset: v - run.startVis };
          }
        }
        return { node: editor, offset: 0 };
      }
      const a = locate(s);
      const b = locate(e);
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { start, end },
  );
}

async function dispatchBeforeInput(
  page: import("@playwright/test").Page,
  inputType: string,
  opts: { data?: string; pasteText?: string } = {},
): Promise<void> {
  await page.evaluate(
    ({ inputType: type, data, pasteText }) => {
      const { editor } = window.__harness!;
      const init: InputEventInit = { inputType: type, cancelable: true, bubbles: true };
      if (data !== undefined) {
        init.data = data;
      }
      let event: InputEvent;
      if (pasteText !== undefined) {
        const dt = new DataTransfer();
        dt.setData("text/plain", pasteText);
        event = new InputEvent("beforeinput", { ...init, dataTransfer: dt });
      } else {
        event = new InputEvent("beforeinput", init);
      }
      editor.dispatchEvent(event);
    },
    { inputType, data: opts.data, pasteText: opts.pasteText },
  );
}

test("MUT-01: typing real keystrokes emits operations and renders correctly", async ({ page }) => {
  await setupHarness(page);
  await page.click("#editor");
  await page.keyboard.type("hello");
  expect(await engineText(page)).toBe("hello");
  expect(await domText(page)).toBe("hello");
  const editorText = await page.evaluate(() => document.getElementById("editor")!.textContent);
  expect(editorText).toBe("hello");
});

test("MUT-01: autocorrect fires (insertReplacementText) — delete + insert emitted", async ({
  page,
}) => {
  await setupHarness(page, "teh cat");
  await selectRange(page, 0, 3); // "teh" — what a real autocorrect targetRange/selection covers
  await dispatchBeforeInput(page, "insertReplacementText", { data: "the" });
  expect(await engineText(page)).toBe("the cat");
});

test("MUT-01: spellcheck replacement via context menu (insertReplacementText)", async ({
  page,
}) => {
  await setupHarness(page, "recieve soon");
  await selectRange(page, 0, 7); // "recieve"
  await dispatchBeforeInput(page, "insertReplacementText", { data: "receive" });
  expect(await engineText(page)).toBe("receive soon");
});

test("MUT-01: paste 2,000 characters — content lands correctly in one pipeline call", async ({
  page,
  browserName,
}) => {
  // Real WebKit runs a synthetically-constructed `DataTransfer` (one never produced by an actual
  // native paste) in "protected mode": `getData()` returns "" outside a genuinely browser-initiated
  // clipboard event, even though `setData()` on the same object succeeds. Chromium and Firefox are
  // both lenient enough to allow this for testing; this is a WebKit-specific synthetic-dispatch
  // limitation, not a defect in inputPipeline.ts's own `dataTransfer.getData("text/plain")` call —
  // a REAL user paste in real WebKit populates it correctly, only this test's synthetic trigger
  // cannot reach it there. The frame-count half of this DoD item ("one frame, not 2,000") is
  // verified independently and browser-independently in syncClient.test.ts, not here.
  test.skip(
    browserName === "webkit",
    "WebKit: DataTransfer.getData() is empty for a synthetic beforeinput dispatch (protected mode) — see comment above",
  );
  await setupHarness(page);
  const big = "a".repeat(2000);
  await dispatchBeforeInput(page, "insertFromPaste", { pasteText: big });
  expect(await engineText(page)).toBe(big);
  expect(await domText(page)).toBe(big);
});

test("MUT-01: drag within the document — deleteByDrag + insertFromDrop, character appears exactly once", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "WebKit: DataTransfer.getData() is empty for a synthetic beforeinput dispatch (protected mode) — see the paste test's comment above",
  );
  await setupHarness(page, "hello world");
  await selectRange(page, 0, 5); // "hello"
  await dispatchBeforeInput(page, "deleteByDrag");
  expect(await engineText(page)).toBe(" world");
  await placeCaret(page, (await engineText(page)).length); // drop at the end
  await dispatchBeforeInput(page, "insertFromDrop", { pasteText: "hello" });
  const finalText = await engineText(page);
  expect(finalText).toBe(" worldhello");
  expect(finalText.split("hello")).toHaveLength(2); // exactly one occurrence
});

test("MUT-01: cut (deleteByCut) removes the selection", async ({ page }) => {
  await setupHarness(page, "hello world");
  await selectRange(page, 5, 11); // " world"
  await dispatchBeforeInput(page, "deleteByCut");
  expect(await engineText(page)).toBe("hello");
});

test("MUT-01 / GRA-02: Backspace at a grapheme-cluster boundary removes the whole cluster in one real keystroke", async ({
  page,
}) => {
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // family ZWJ emoji, 7 scalars
  await setupHarness(page, "");
  // Seed the cluster via a real insertText beforeinput (an emoji-picker insertion is exactly this
  // shape) rather than page.keyboard.type, which sends individual key events not guaranteed to
  // reconstruct a multi-codepoint ZWJ sequence faithfully across all three browsers.
  await dispatchBeforeInput(page, "insertText", { data: `x${family}` });
  expect(await engineText(page)).toBe(`x${family}`);

  const before = await page.evaluate(() => window.__harness!.sync.engine!.stats().tombstones);
  await page.click("#editor"); // real focus, required for a real keyboard event to reach the element
  // Move the real caret to the very end via keyboard (End) rather than only Selection API, since
  // this test's whole point is a REAL Backspace keystroke, not a synthetic beforeinput.
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");

  expect(await engineText(page)).toBe("x");
  const after = await page.evaluate(() => window.__harness!.sync.engine!.stats().tombstones);
  expect(after - before).toBe(7); // GRA-02: one Delete operation per scalar in the cluster
});

test("MUT-01: Ctrl+Backspace deletes a whole word via a real keystroke", async ({ page }) => {
  await setupHarness(page, "hello world");
  await page.click("#editor");
  await page.keyboard.press("End");
  await page.keyboard.press("Control+Backspace");
  expect(await engineText(page)).toBe("hello ");
});

test("every beforeinput is preventDefaulted for 20 distinct inputTypes (Scope-IN)", async ({
  page,
}) => {
  await setupHarness(page, "hello");
  await placeCaret(page, 5);
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
    "insertCompositionText",
    "deleteCompositionText",
    "historyUndo",
    "historyRedo",
    "insertFromYank",
    "formatBold",
  ];
  expect(inputTypes).toHaveLength(20);
  const results = await page.evaluate((types) => {
    const { editor } = window.__harness!;
    return types.map((inputType) => {
      const event = new InputEvent("beforeinput", { inputType, data: "x", cancelable: true });
      editor.dispatchEvent(event);
      return event.defaultPrevented;
    });
  }, inputTypes);
  expect(results).toEqual(inputTypes.map(() => true));
});
