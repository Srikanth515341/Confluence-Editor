import { expect, test } from "@playwright/test";
import { setupPage } from "./helpers.js";
// bindingGlobal.d.ts is an ambient declaration file — picked up automatically via e2e/tsconfig.json.

/**
 * Test Plan §7.1, DOM-03 (API Spec §7.2.3's element-node selection cases).
 * Scope for this phase: empty editor in both Chromium and WebKit,
 * selection after a `<br>`, and selection at a run boundary. (Selection
 * after triple-click-select-all-then-typing is deferred to Phase 12 — it
 * involves input events, not just static positioning.)
 *
 * Run in real Chromium AND real WebKit (playwright.config.ts) specifically
 * because Chromium and WebKit disagree on what an empty, focused
 * contenteditable's DOM/selection looks like — jsdom cannot exercise this
 * at all, per the phase brief.
 */

test("DOM-03: empty editor — a real click places the caret, and domToVis normalizes it to index 0", async ({
  page,
  browserName,
}) => {
  await setupPage(page);
  await page.evaluate(() => {
    const root = document.getElementById("editor")!;
    const writer = new window.Binding.DomWriter();
    writer.mount(root, "");
    window.__writer = writer;
  });

  await page.click("#editor");

  const observed = await page.evaluate(() => {
    const writer = window.__writer!;
    const sel = window.getSelection();
    const root = document.getElementById("editor")!;
    return {
      childCount: root.childNodes.length,
      firstChildTag: root.firstChild ? ((root.firstChild as Element).tagName ?? "#text") : null,
      anchorIsRoot: sel?.anchorNode === root,
      vis: sel ? window.Binding.domToVis(writer.index, sel.anchorNode!, sel.anchorOffset) : null,
    };
  });

  // Document the actual per-engine DOM shape this test observed — Chromium inserts a <br>,
  // WebKit does not (API Spec §7.2.3) — without asserting on it beyond what DOM-03 requires.
  test
    .info()
    .annotations.push({
      type: "browser-shape",
      description: `${browserName}: ${JSON.stringify(observed)}`,
    });

  expect(observed.vis).toBe(0);
});

test("DOM-03: selection immediately after a browser-inserted <br>", async ({ page }) => {
  await setupPage(page);
  const vis = await page.evaluate(() => {
    const root = document.getElementById("editor")!;
    const writer = new window.Binding.DomWriter();
    writer.mount(root, "");
    const br = document.createElement("br");
    root.appendChild(br);

    const range = document.createRange();
    range.setStartAfter(br);
    range.collapse(true);

    // A position "after" an element among its parent's children is itself an element-node
    // position (per the DOM Range spec) — exactly §7.2.3's case, exercised via normalizeElementPosition.
    return window.Binding.domToVis(writer.index, range.startContainer, range.startOffset);
  });
  expect(vis).toBe(0); // a <br> contributes no scalars; there is nothing else in this document
});

test("DOM-03: selection at the boundary between two renderIndex runs (>512 scalars)", async ({
  page,
}) => {
  await setupPage(page);
  const result = await page.evaluate(() => {
    const root = document.getElementById("editor")!;
    const writer = new window.Binding.DomWriter();
    const text = "a".repeat(600); // > RUN_MAX_SCALARS (512) -> forces a second run
    writer.mount(root, text);

    if (writer.index.length !== 2) {
      throw new Error(`expected exactly 2 runs for 600 scalars, got ${writer.index.length}`);
    }
    const run0 = writer.index[0]!;
    const run1 = writer.index[1]!;

    const viaEndOfRun0 = window.Binding.domToVis(
      writer.index,
      run0.textNode,
      run0.textNode.data.length,
    );
    const viaStartOfRun1 = window.Binding.domToVis(writer.index, run1.textNode, 0);
    // Also exercise the element-node path at the same boundary: root's children are [run0.textNode,
    // run1.textNode], so offset 1 (an element-node position) means "right after run0's text node".
    const viaElementBoundary = window.Binding.normalizeElementPosition(writer.index, root, 1);

    return { boundary: run0.scalarLen, viaEndOfRun0, viaStartOfRun1, viaElementBoundary };
  });

  expect(result.viaEndOfRun0).toBe(result.boundary);
  expect(result.viaStartOfRun1).toBe(result.boundary);
  expect(result.viaElementBoundary).toBe(result.boundary);
});
