import { expect, test } from "@playwright/test";
import { setupInputHarnessPage } from "./helpers.js";
// inputHarnessGlobal.d.ts is an ambient declaration file — picked up automatically via
// e2e/tsconfig.json's "include", no import needed.

/**
 * Phase 13 real-browser MutationSentinel coverage — Test Plan MUT-02 (a
 * direct DOM mutation is detected, reverted, and counted) and MUT-03
 * (1,000 keystrokes produce ZERO reconciliations), against real Chromium,
 * Firefox, AND WebKit.
 *
 * MUT-03 is the DoD's own "this is the test that catches the flag-based
 * implementation" — and it can only actually catch that bug with a REAL
 * task/microtask boundary between each write, the same shape a real
 * separate keystroke produces (each real key press is its own browser
 * task; the MutationObserver callback queued during one task's synchronous
 * work is delivered at THAT task's own microtask checkpoint, before the
 * next task/keystroke begins — this is exactly when a boolean flag that
 * was already cleared synchronously would cause a false positive). A tight
 * synchronous JS loop of 1,000 writes would never expose this: nothing
 * yields between iterations, so no microtask checkpoint (and thus no
 * MutationObserver callback) runs until the whole loop finishes, by which
 * point even the broken flag-based code would happen to see `records.length
 * === 0` every time — a false negative that would make the WRONG
 * implementation look correct. So each of the 1,000 writes here is
 * dispatched from inside its own `setTimeout(..., 0)` — a genuine macrotask
 * boundary — rather than real `page.keyboard.type()` (which would take
 * several real minutes for 1,000 characters against this project's
 * measured per-keystroke CDP round-trip time, and adds nothing a forced
 * macrotask boundary doesn't already provide: the race being tested is
 * about task/microtask ordering, not about genuine OS input). This is the
 * project's own documented, defensible test-methodology call, the same
 * shape as Phase 12's dispatchEvent-for-untestable-triggers decision.
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

async function setupHarness(page: import("@playwright/test").Page): Promise<void> {
  await setupInputHarnessPage(page);
  await page.evaluate(() => {
    const editor = document.getElementById("editor")!;
    const domWriter = new window.InputHarness.DomWriter();
    const sync = new window.InputHarness.SyncClient({ url: "ws://unused", documentId: "doc" });
    sync.engine = new window.InputHarness.Engine(1);
    const sentinel = new window.InputHarness.MutationSentinel({
      root: editor,
      domWriter,
      getEngineText: () => sync.engine?.text(),
    });
    sentinel.applyPatches(() => domWriter.mount(editor, ""));
    sentinel.start();
    window.InputHarness.attachInputPipeline(editor, { domWriter, sync, sentinel });
    window.__harness = { editor, domWriter, sync, sentinel };
  });
}

test("MUT-02: a direct DOM mutation, bypassing DomWriter, is detected, reverted, counted, and emits no operation", async ({
  page,
}) => {
  await setupHarness(page);
  await page.evaluate(() => {
    const { domWriter, editor, sentinel, sync } = window.__harness!;
    sync.localInsertText(0, "hello");
    sentinel.applyPatches(() => domWriter.mount(editor, "hello"));
  });

  const insertCallsBefore = await page.evaluate(() => window.__harness!.sync.engine!.stats());

  await page.evaluate(async () => {
    const { editor } = window.__harness!;
    // A direct DOM mutation, bypassing DomWriter/applyPatches — appending a rogue node, not
    // touching the existing text node's own data (see mutationSentinel.test.ts's own comment for
    // why: replacing a Text node's `.data` in place lets the DOM's own boundary-point-adjustment
    // algorithm collapse any live Selection anchored inside it BEFORE the async MutationObserver
    // callback ever runs — an inherent limit of any reactive detector, not specific to this one,
    // and not what this test is trying to isolate).
    editor.appendChild(document.createTextNode("EVIL"));
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the MutationObserver microtask run
  });

  const text = await page.evaluate(() => window.__harness!.domWriter.materializedText());
  const metrics = await page.evaluate(() => window.__harness!.sentinel.metrics);
  const insertCallsAfter = await page.evaluate(() => window.__harness!.sync.engine!.stats());

  expect(text).toBe("hello"); // reverted
  expect(metrics.reconciliation).toBe(1); // exactly one revert
  expect(metrics.desync_error).toBe(0);
  // No operation was emitted: the engine's own structural stats (total nodes) are unchanged by
  // the revert, since reconcile() only ever touches the DOM, never `sync.localInsertText`/`localDelete`.
  expect(insertCallsAfter.totalElements).toBe(insertCallsBefore.totalElements);
});

test("MUT-03: 1,000 keystrokes produce binding.reconciliation === 0", async ({ page }) => {
  await setupHarness(page);

  const result = await page.evaluate(async () => {
    const { editor, sync, sentinel } = window.__harness!;
    for (let i = 0; i < 1000; i++) {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          const value = 0x61 + (i % 26);
          const text = String.fromCodePoint(value);
          const event = new InputEvent("beforeinput", {
            inputType: "insertText",
            data: text,
            cancelable: true,
            bubbles: true,
          });
          editor.dispatchEvent(event);
          resolve();
        }, 0);
      });
    }
    return { reconciliation: sentinel.metrics.reconciliation, text: sync.engine!.text() };
  });

  expect(result.text).toHaveLength(1000);
  expect(result.reconciliation).toBe(0);
});
