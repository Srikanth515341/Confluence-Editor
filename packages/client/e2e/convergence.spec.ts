// Milestone M1 — Test Plan §2.7, E2E-CONV-01..04. Runs against the REAL
// app (packages/client/scripts/serveApp.mjs serving the real index.html +
// src/app/main.tsx bundle) and a REAL @collab-editor/server instance
// (e2e/support/testServer.ts), through an in-process delay relay
// (e2e/support/delayRelay.ts — see that file's own header for why it
// substitutes for toxiproxy in this phase, and what it deliberately does
// NOT do).
//
// "Three independent browser contexts (Chromium, Firefox, WebKit) — not
// three tabs" (Test Plan §2.7's own harness-design line) means launching
// three DIFFERENT BROWSER ENGINES from inside ONE test, not relying on
// playwright.config.ts's three per-engine PROJECTS (which would run this
// file three times, once per engine, never together) — so this file is
// excluded from the chromium/firefox/webkit projects and instead runs
// under its own `convergence` project (playwright.config.ts).
//
// Typing methodology: every character in every test below is delivered by
// dispatching a real `beforeinput` `InputEvent` (`element.dispatchEvent`)
// rather than `page.keyboard.type()`. This is the same documented,
// defensible call Phase 12 made for untestable OS triggers, applied here
// for a different reason: real per-character CDP round-trips (~150-1500ms
// observed per keystroke on Firefox in this project's own earlier phases)
// would make a 60-second/~5-char/s/browser stress test take many real
// minutes per run — and, per the DoD, this suite needs to pass 20/20 runs.
// What is under test here — convergence under real concurrent WebSocket
// traffic, real ~150ms network delay, and real timing races across three
// browser engines — does not depend on the keystroke's OS origin, only on
// the real input pipeline, real DomWriter, real MutationSentinel, real
// wire protocol, and real server actually processing it, all of which this
// dispatch exercises identically to a real keystroke.

import { chromium, expect, firefox, test, webkit, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createCollabServer } from "@collab-editor/server";
import { startDelayRelay, type DelayRelay } from "./support/delayRelay.js";
import { startTestAppServer, type TestAppServerHandle } from "./support/testAppServer.js";
import { startTestServer, type TestServerHandle } from "./support/testServer.js";

/** ~150ms round trip = ~75ms delay applied by the relay in EACH direction. */
const ONE_WAY_DELAY_MS = 75;
const TYPING_INTERVAL_MS = 200; // ~5 characters/second
const HOT_REGION_WIDTH_CONV01 = 20;
const HOT_REGION_SEED = "the quick brown fox!"; // exactly 20 characters

// Overridable for fast local iteration; the DoD's own numbers are the defaults.
const CONV01_DURATION_MS = Number(process.env.E2E_CONV01_DURATION_MS ?? 60_000);
const CONV02_DURATION_MS = Number(process.env.E2E_CONV02_DURATION_MS ?? 60_000);
const CONV02_DISCONNECT_MS = Number(process.env.E2E_CONV02_DISCONNECT_MS ?? 30_000);
const CONV03_DURATION_MS = Number(process.env.E2E_CONV03_DURATION_MS ?? 60_000);
const CONV03_KILL_AT_MS = Number(process.env.E2E_CONV03_KILL_AT_MS ?? 30_000);
const CONV04_DURATION_MS = Number(process.env.E2E_CONV04_DURATION_MS ?? 30_000);

interface Fixture {
  readonly server: TestServerHandle;
  readonly appServer: TestAppServerHandle;
  readonly relay: DelayRelay;
  readonly documentId: string;
  urlFor(documentId: string): string;
}

async function setupFixture(): Promise<Fixture> {
  const server = await startTestServer();
  const appServer = await startTestAppServer();
  const relay = await startDelayRelay(server.wsUrl, ONE_WAY_DELAY_MS);
  return {
    server,
    appServer,
    relay,
    documentId: randomUUID(),
    urlFor: (documentId) => `${appServer.url}?doc=${documentId}&server=${relay.url}/v1/rt`,
  };
}

async function teardownFixture(fx: Fixture): Promise<void> {
  await fx.relay.close();
  await fx.appServer.stop();
  await fx.server.server.close();
}

const BROWSER_TYPES = [chromium, firefox, webkit] as const;

async function launchThreeBrowsers(): Promise<{ browsers: Browser[]; pages: Page[] }> {
  const browsers = await Promise.all(BROWSER_TYPES.map((bt) => bt.launch()));
  const pages = await Promise.all(
    browsers.map(async (browser) => (await browser.newContext()).newPage()),
  );
  return { browsers, pages };
}

async function closeBrowsers(browsers: readonly Browser[]): Promise<void> {
  await Promise.all(browsers.map((b) => b.close()));
}

async function waitForSynced(page: Page, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('[role="status"]')?.textContent === "Synced",
    undefined,
    { timeout },
  );
}

async function getEngineText(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      (
        window as unknown as { __collabDebug: { getEngineText(): string | undefined } }
      ).__collabDebug.getEngineText() ?? "",
  );
}

async function getPendingCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        window as unknown as { __collabDebug: { getPendingCount(): number | undefined } }
      ).__collabDebug.getPendingCount() ?? -1,
  );
}

async function getDomText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('[contenteditable="true"]')?.textContent ?? "");
}

async function seedHotRegion(page: Page, text: string): Promise<void> {
  await page.evaluate((seedText) => {
    const editor = document.querySelector('[contenteditable="true"]') as HTMLElement;
    editor.focus();
    const event = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: seedText,
      cancelable: true,
      bubbles: true,
    });
    editor.dispatchEvent(event);
  }, text);
}

/**
 * Continuously dispatches synthetic `insertText` `beforeinput` events at a
 * position drawn from `[hotStart, hotStart + hotWidth)` (clamped to the
 * document's current length), for `durationMs`, at one character every
 * `intervalMs`. `hotWidth: 1` (E2E-CONV-04) always targets the SAME single
 * position — the fuzz harness's own `hotRegionWidth` semantics
 * (packages/testkit/src/fuzz/configs.ts), reused here for the same reason.
 */
async function typeIntoHotRegion(
  page: Page,
  marker: string,
  hotStart: number,
  hotWidth: number,
  durationMs: number,
  intervalMs: number,
): Promise<void> {
  await page.evaluate(
    ({
      marker: m,
      hotStart: start,
      hotWidth: width,
      durationMs: duration,
      intervalMs: interval,
    }) => {
      return new Promise<void>((resolve) => {
        const editor = document.querySelector('[contenteditable="true"]') as HTMLElement;
        const deadline = Date.now() + duration;

        function placeCaretAtOffset(offset: number): void {
          let remaining = offset;
          for (const node of Array.from(editor.childNodes)) {
            if (node.nodeType === Node.TEXT_NODE) {
              const len = (node as Text).data.length;
              if (remaining <= len) {
                const range = document.createRange();
                range.setStart(node, remaining);
                range.collapse(true);
                const sel = window.getSelection()!;
                sel.removeAllRanges();
                sel.addRange(range);
                return;
              }
              remaining -= len;
            }
          }
          const range = document.createRange();
          const last = editor.lastChild;
          if (last && last.nodeType === Node.TEXT_NODE) {
            range.setStart(last, (last as Text).data.length);
          } else {
            range.setStart(editor, editor.childNodes.length);
          }
          range.collapse(true);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(range);
        }

        function tick(): void {
          if (Date.now() >= deadline) {
            resolve();
            return;
          }
          const textLen = editor.textContent?.length ?? 0;
          const span = Math.max(1, Math.min(width, textLen + 1 - start));
          const offset = Math.min(textLen, start + Math.floor(Math.random() * span));
          placeCaretAtOffset(offset);
          const event = new InputEvent("beforeinput", {
            inputType: "insertText",
            data: m,
            cancelable: true,
            bubbles: true,
          });
          editor.dispatchEvent(event);
          setTimeout(tick, interval);
        }
        tick();
      });
    },
    { marker, hotStart, hotWidth, durationMs, intervalMs },
  );
}

/** Waits for `pendingCount() === 0` on every page — Engine Spec §4.2's causal-buffer quiescence, checked per-client before the four convergence assertions. */
async function waitForQuiescence(pages: readonly Page[], timeout = 30_000): Promise<void> {
  await expect
    .poll(async () => Math.max(...(await Promise.all(pages.map(getPendingCount)))), { timeout })
    .toBe(0);
}

/**
 * Test Plan §2.7's four E2E-CONV-01 assertions, reused by every test in
 * this file (each of -02/-03/-04 ends in the same convergence check).
 * Assertion 3 — comparing against the server's OWN independent replay of
 * its recorded operation log (documentCoordinator.ts's `operationLog`,
 * httpApp.ts's `/v1/documents/:id/replay`) — is the one that matters:
 * assertions 1 and 2 only compare clients to EACH OTHER (or to themselves)
 * and would pass even if all three shared one identical binding bug.
 */
async function assertConverged(
  pages: readonly Page[],
  serverPort: number,
  documentId: string,
): Promise<void> {
  await waitForQuiescence(pages);
  // The relay's own ~150ms RTT plus any frame already in flight when quiescence was observed —
  // give both a moment to fully settle before reading final state.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const domTexts = await Promise.all(pages.map(getDomText));
  const engineTexts = await Promise.all(pages.map(getEngineText));
  const pendingCounts = await Promise.all(pages.map(getPendingCount));

  // Assertion 1: all DOM textContent values are byte-identical.
  for (let i = 1; i < domTexts.length; i++) {
    expect(domTexts[i], `browser ${i} DOM vs browser 0 DOM`).toBe(domTexts[0]);
  }
  // Assertion 2: each browser's DOM equals its OWN engine.materialize().
  for (let i = 0; i < domTexts.length; i++) {
    expect(domTexts[i], `browser ${i} DOM vs its own engine.text()`).toBe(engineTexts[i]);
  }
  // Assertion 3 — the one that matters: an independent server-side replay of the operation log.
  const replayRes = await fetch(`http://127.0.0.1:${serverPort}/v1/documents/${documentId}/replay`);
  expect(replayRes.status).toBe(200);
  const replay = (await replayRes.json()) as { text: string; pendingCount: number };
  expect(replay.pendingCount).toBe(0);
  expect(domTexts[0], "browser 0 DOM vs independent server-side replay").toBe(replay.text);
  // Assertion 4: pendingCount() === 0 in all three.
  for (const count of pendingCounts) {
    expect(count).toBe(0);
  }
}

test.describe.configure({ mode: "serial" }); // heavy (3 real browser engines + a real server) — run one at a time

test("E2E-CONV-01: three real browser engines, 60s of concurrent typing in a 20-char hot region, converge", async () => {
  test.setTimeout(CONV01_DURATION_MS + 60_000);
  const fx = await setupFixture();
  const { browsers, pages } = await launchThreeBrowsers();
  try {
    const url = fx.urlFor(fx.documentId);
    await Promise.all(pages.map((page) => page.goto(url)));
    await Promise.all(pages.map((page) => waitForSynced(page)));

    await seedHotRegion(pages[0]!, HOT_REGION_SEED);
    await expect.poll(() => getEngineText(pages[1]!), { timeout: 10_000 }).toBe(HOT_REGION_SEED);
    await expect.poll(() => getEngineText(pages[2]!), { timeout: 10_000 }).toBe(HOT_REGION_SEED);

    const markers = ["A", "B", "C"];
    await Promise.all(
      pages.map((page, i) =>
        typeIntoHotRegion(
          page,
          markers[i]!,
          0,
          HOT_REGION_WIDTH_CONV01,
          CONV01_DURATION_MS,
          TYPING_INTERVAL_MS,
        ),
      ),
    );

    await assertConverged(pages, fx.server.port, fx.documentId);
  } finally {
    await closeBrowsers(browsers);
    await teardownFixture(fx);
  }
});

test("E2E-CONV-02: one browser disconnected for 30s mid-run, still converges", async () => {
  test.setTimeout(CONV02_DURATION_MS + 60_000);
  const fx = await setupFixture();
  const { browsers, pages } = await launchThreeBrowsers();
  try {
    const url = fx.urlFor(fx.documentId);
    await Promise.all(pages.map((page) => page.goto(url)));
    await Promise.all(pages.map((page) => waitForSynced(page)));

    await seedHotRegion(pages[0]!, HOT_REGION_SEED);
    await expect.poll(() => getEngineText(pages[1]!), { timeout: 10_000 }).toBe(HOT_REGION_SEED);
    await expect.poll(() => getEngineText(pages[2]!), { timeout: 10_000 }).toBe(HOT_REGION_SEED);

    const markers = ["A", "B", "C"];
    const typingDone = Promise.all(
      pages.map((page, i) =>
        typeIntoHotRegion(
          page,
          markers[i]!,
          0,
          HOT_REGION_WIDTH_CONV01,
          CONV02_DURATION_MS,
          TYPING_INTERVAL_MS,
        ),
      ),
    );

    // Disconnect browser 1 (a REAL network-level offline, Playwright's own context API — not a
    // simulated event) partway through, for the DoD's own 30 seconds, then bring it back.
    const disconnectAt = Math.max(0, CONV02_DURATION_MS / 2 - CONV02_DISCONNECT_MS / 2);
    await new Promise((resolve) => setTimeout(resolve, disconnectAt));
    await pages[1]!.context().setOffline(true);
    await new Promise((resolve) => setTimeout(resolve, CONV02_DISCONNECT_MS));
    await pages[1]!.context().setOffline(false);

    await typingDone;
    await waitForSynced(pages[1]!); // real backoff/reconnect (Phase 10) must complete before quiescence can even be checked

    await assertConverged(pages, fx.server.port, fx.documentId);
  } finally {
    await closeBrowsers(browsers);
    await teardownFixture(fx);
  }
});

test("E2E-CONV-03: server killed and restarted at t=30s, all three reconnect and converge", async () => {
  test.setTimeout(CONV03_DURATION_MS + 60_000);
  const fx = await setupFixture();
  const { browsers, pages } = await launchThreeBrowsers();
  try {
    const url = fx.urlFor(fx.documentId);
    await Promise.all(pages.map((page) => page.goto(url)));
    await Promise.all(pages.map((page) => waitForSynced(page)));

    await seedHotRegion(pages[0]!, HOT_REGION_SEED);
    await expect.poll(() => getEngineText(pages[1]!), { timeout: 10_000 }).toBe(HOT_REGION_SEED);
    await expect.poll(() => getEngineText(pages[2]!), { timeout: 10_000 }).toBe(HOT_REGION_SEED);

    const markers = ["A", "B", "C"];
    const typingDone = Promise.all(
      pages.map((page, i) =>
        typeIntoHotRegion(
          page,
          markers[i]!,
          0,
          HOT_REGION_WIDTH_CONV01,
          CONV03_DURATION_MS,
          TYPING_INTERVAL_MS,
        ),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, CONV03_KILL_AT_MS));
    // Kill the REAL server process handle this spec file itself owns (accessible directly —
    // see e2e/support/testServer.ts's own comment for why this is per-file, not globalSetup) and
    // restart a FRESH one on the EXACT SAME port. No persistence exists yet (Phases 15-17): the
    // restarted document is legitimately empty, exactly as Phase 10's own kill-and-restart test
    // documents — the assertion here is "all three detect the drop, reconnect automatically, and
    // resume converging," not "content survives a restart."
    await fx.server.server.close();
    const freshServer = createCollabServer();
    await freshServer.listen(fx.server.port);

    await Promise.all(pages.map((page) => waitForSynced(page, 30_000))); // real backoff + a fresh SNAPSHOT from the new server

    // Post-restart content is fresh/empty; let the still-running typing loops (which keep
    // dispatching against whatever the DOM currently shows, oblivious to the restart) continue
    // until they finish, then converge on THAT post-restart state.
    await typingDone;

    await assertConverged(pages, fx.server.port, fx.documentId);
    await freshServer.close();
  } finally {
    await closeBrowsers(browsers);
    await teardownFixture(fx);
  }
});

test("E2E-CONV-04: w=1 maximum collision — three browsers type at the exact same position for 30s", async () => {
  test.setTimeout(CONV04_DURATION_MS + 60_000);
  const fx = await setupFixture();
  const { browsers, pages } = await launchThreeBrowsers();
  try {
    const url = fx.urlFor(fx.documentId);
    await Promise.all(pages.map((page) => page.goto(url)));
    await Promise.all(pages.map((page) => waitForSynced(page)));

    // No seeded hot region here — w=1 means every insert targets position 0 from an EMPTY
    // document, the fuzz harness's own C2_COLLISION shape (packages/testkit/src/fuzz/configs.ts,
    // hotRegionWidth: 1), maximizing Case A collisions (Engine Spec §4.3) for the full run.
    const markers = ["A", "B", "C"];
    await Promise.all(
      pages.map((page, i) =>
        typeIntoHotRegion(page, markers[i]!, 0, 1, CONV04_DURATION_MS, TYPING_INTERVAL_MS),
      ),
    );

    await assertConverged(pages, fx.server.port, fx.documentId);
  } finally {
    await closeBrowsers(browsers);
    await teardownFixture(fx);
  }
});
