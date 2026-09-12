import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLE_PATH = path.join(here, ".bundle", "binding.js");
export const INPUT_HARNESS_BUNDLE_PATH = path.join(here, ".bundle", "inputHarness.js");

/** Loads a blank page with a bare contenteditable root and injects the prebuilt binding bundle (`window.Binding`, see build-bundle.mjs). */
export async function setupPage(page: Page): Promise<void> {
  await page.setContent('<div id="editor" contenteditable="true"></div>');
  await page.addScriptTag({ path: BUNDLE_PATH });
}

/** Loads a blank page with a bare contenteditable root and injects the Phase 12 input-pipeline bundle (`window.InputHarness`, see build-bundle.mjs). */
export async function setupInputHarnessPage(page: Page): Promise<void> {
  await page.setContent('<div id="editor" contenteditable="true"></div>');
  await page.addScriptTag({ path: INPUT_HARNESS_BUNDLE_PATH });
}

/**
 * Phase 33 (Test Plan PRES-02/PRES-07) — loads a page shaped like the REAL production layout
 * `EditorView.tsx` renders: a `position: relative` wrapper containing the contenteditable `#editor`
 * (sibling) and a `#overlay` div (`position: absolute; inset: 0; pointer-events: none`), matching
 * that component's own structure exactly, so a real browser's real text layout/scroll/resize
 * behavior is measured against the SAME shape production actually uses, not an approximation.
 * `#editor` is given a fixed width/height and `overflow-y: auto` — real constraints needed for
 * real multi-line wrapping (PRES-02) and real scrolling (PRES-07) to be meaningful at all.
 */
export async function setupPresenceHarnessPage(page: Page): Promise<void> {
  await page.setContent(`
    <div id="wrapper" style="position: relative; width: 300px; height: 150px;">
      <div id="editor" contenteditable="true" style="width: 300px; height: 150px; overflow-y: auto; box-sizing: border-box; font: 16px/1.5 monospace; white-space: pre-wrap; word-break: break-all; margin: 0; padding: 4px;"></div>
      <div id="overlay" style="position: absolute; inset: 0; pointer-events: none; overflow: hidden;"></div>
    </div>
  `);
  await page.addScriptTag({ path: INPUT_HARNESS_BUNDLE_PATH });
}
