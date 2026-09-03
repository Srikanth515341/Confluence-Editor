import { defineConfig, devices } from "@playwright/test";

/**
 * Real-browser tests (Test Plan §7.1's own requirement: "Use Playwright
 * with real Chromium and real WebKit browser contexts to run these tests —
 * not jsdom, since jsdom does not implement real Selection/Range quirks").
 * First Playwright usage in this project — Phase 11. Phase 12 (Scope-IN:
 * "Runs in Chromium, Firefox and WebKit") added the `firefox` project.
 *
 * Most specs don't navigate to a running app; each loads a blank page and
 * injects a prebuilt bundle directly (`e2e/build-bundle.mjs`, run
 * automatically by `pnpm test:e2e` before Playwright starts) via
 * `page.addScriptTag`. Phase 14's `convergence.spec.ts` is the exception:
 * it navigates real browsers to the REAL app (packages/client/scripts/
 * serveApp.mjs) against a REAL server (e2e/support/testServer.ts).
 *
 * `convergence.spec.ts` gets its OWN project rather than running under
 * `chromium`/`firefox`/`webkit`: Test Plan §2.7's harness design is THREE
 * DIFFERENT ENGINES together in ONE test ("not three tabs; not one page
 * with three engine instances"), which the file achieves by launching all
 * three itself (`import { chromium, firefox, webkit } from
 * "@playwright/test"`) — running it a second, third, and fourth time under
 * the single-engine projects below would be redundant (each run is
 * already exercising all three engines) and needlessly slow (each run
 * takes tens of seconds to minutes). `testIgnore` on the three single-
 * engine projects and a matching `testMatch` on `convergence` keep this
 * file running exactly once.
 */
// Each project sets its OWN testMatch/testIgnore explicitly, rather than relying on a top-level
// default plus per-project overrides — Playwright's merge behavior between the two is not worth
// depending on when correctness here matters (running convergence.spec.ts exactly once).
const SINGLE_ENGINE_MATCH = {
  testMatch: /.*\.spec\.ts/,
  testIgnore: [/convergence\.spec\.ts/, /durableQueue\.spec\.ts/],
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, ...SINGLE_ENGINE_MATCH },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, ...SINGLE_ENGINE_MATCH },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, ...SINGLE_ENGINE_MATCH },
    {
      name: "convergence",
      testMatch: /convergence\.spec\.ts/,
      timeout: 300_000, // E2E-CONV-01..03 each run for up to ~60s of real typing plus setup/teardown
    },
    {
      name: "durableQueue",
      testMatch: /durableQueue\.spec\.ts/,
      timeout: 60_000,
      // Chromium-only (Phase 22, Test Plan §3.6 DUR-07): this file manages its own real, on-disk
      // browser profile directly via chromium.launchPersistentContext() rather than using
      // Playwright's `page`/`context` fixtures (see the file's own header comment for exactly
      // what real Playwright API this needed, what it does NOT do — a literal SIGKILL turned out
      // not to be achievable through any supported combination of Playwright APIs — and why that
      // doesn't weaken the claim under test), so the `use` block below is unused and the
      // single-engine projects above explicitly ignore this file to avoid running it redundantly
      // three times under three unrelated `devices` configs — the same reasoning
      // `convergence.spec.ts` already established for its own dedicated project.
    },
  ],
});
