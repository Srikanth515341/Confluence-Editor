import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLE_PATH = path.join(here, ".bundle", "binding.js");

/** Loads a blank page with a bare contenteditable root and injects the prebuilt binding bundle (`window.Binding`, see build-bundle.mjs). */
export async function setupPage(page: Page): Promise<void> {
  await page.setContent('<div id="editor" contenteditable="true"></div>');
  await page.addScriptTag({ path: BUNDLE_PATH });
}
