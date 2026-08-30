import { expect, test } from "@playwright/test";
import { DOM01_FIXTURES } from "./fixtures.js";
import { setupPage } from "./helpers.js";
// bindingGlobal.d.ts is an ambient declaration file (no runtime module) — TypeScript picks it up
// automatically from e2e/tsconfig.json's "include", no import needed.

/**
 * Test Plan §7.1, DOM-01: for each fixture string, for every visible index
 * v in [0, len], domToVis(visToDom(v)) === v, and the caret placed at
 * visToDom(v) is never inside a surrogate pair. Run in real Chromium AND
 * real WebKit (playwright.config.ts) — jsdom does not implement real
 * Selection/Range quirks, so this phase's DoD requires actual browsers.
 */
for (const [name, text] of DOM01_FIXTURES) {
  test(`DOM-01 round trip: ${name}`, async ({ page }) => {
    await setupPage(page);

    const result = await page.evaluate((fixtureText) => {
      const root = document.getElementById("editor")!;
      const writer = new window.Binding.DomWriter();
      writer.mount(root, fixtureText);

      const scalarLen = Array.from(fixtureText).length;
      const failures: string[] = [];

      for (let v = 0; v <= scalarLen; v++) {
        const pos = window.Binding.visToDom(writer.index, root, v);

        if (pos.node.nodeType === Node.TEXT_NODE) {
          const data = (pos.node as Text).data;
          if (window.Binding.isInsideSurrogatePair(data, pos.offset)) {
            failures.push(
              `v=${v}: caret lands inside a surrogate pair at UTF-16 offset ${pos.offset}`,
            );
            continue;
          }
        }

        const roundTripped = window.Binding.domToVis(writer.index, pos.node, pos.offset);
        if (roundTripped !== v) {
          failures.push(`v=${v}: domToVis(visToDom(${v})) = ${roundTripped}`);
        }
      }

      return { failures, scalarLen };
    }, text);

    expect(result.failures).toEqual([]);
    expect(result.scalarLen).toBe(Array.from(text).length);
  });
}

test("DOM-01: a real Selection placed via visToDom reports back the same offset via window.getSelection()", async ({
  page,
}) => {
  // Extra cross-check beyond the DoD's literal requirement: not just that our own domToVis agrees
  // with our own visToDom, but that a REAL browser Selection object, collapsed at the position
  // visToDom computed, reports exactly that (node, offset) back — proving the position is one a
  // real caret can actually occupy, not just one our two functions happen to agree on.
  await setupPage(page);
  const [, text] = DOM01_FIXTURES[2]!; // "hello 👋 world" — the astral-character fixture

  const mismatches = await page.evaluate((fixtureText) => {
    const root = document.getElementById("editor")!;
    const writer = new window.Binding.DomWriter();
    writer.mount(root, fixtureText);
    const scalarLen = Array.from(fixtureText).length;
    const bad: string[] = [];
    const selection = window.getSelection()!;
    for (let v = 0; v <= scalarLen; v++) {
      const pos = window.Binding.visToDom(writer.index, root, v);
      const range = document.createRange();
      range.setStart(pos.node, pos.offset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      if (selection.anchorNode !== pos.node || selection.anchorOffset !== pos.offset) {
        bad.push(
          `v=${v}: selection reports (${String(selection.anchorNode)}, ${selection.anchorOffset})`,
        );
      }
    }
    return bad;
  }, text);

  expect(mismatches).toEqual([]);
});
