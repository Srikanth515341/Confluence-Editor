import { defineConfig, devices } from "@playwright/test";

/**
 * Real-browser tests (Test Plan §7.1's own requirement: "Use Playwright
 * with real Chromium and real WebKit browser contexts to run these tests —
 * not jsdom, since jsdom does not implement real Selection/Range quirks").
 * First Playwright usage in this project — Phase 11.
 *
 * No dev server exists in this project yet, so these tests don't navigate
 * to a running app; each spec loads a blank page and injects the prebuilt
 * binding bundle directly (`e2e/build-bundle.mjs`, run automatically by
 * `pnpm test:e2e` before Playwright starts) via `page.addScriptTag`.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
