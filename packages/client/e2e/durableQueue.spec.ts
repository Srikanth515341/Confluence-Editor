// Phase 22 — Test Plan §3.6 DUR-07: a real browser profile (real
// on-disk IndexedDB), terminated and relaunched, proving persistence
// survives across separate browser process lifetimes.
//
// A genuine, engine-level SIGKILL of the browser process was investigated
// and found NOT achievable through Playwright's public API for this
// combination of features: `Browser` (from `browserType.launch()`) has no
// `.process()` method in this Playwright version (confirmed directly
// against playwright-core's own type definitions before writing this
// file); `BrowserServer` (from `browserType.launchServer()`) DOES expose
// `.process()`/`.kill()`, but `launchServer()` explicitly REFUSES a
// `--user-data-dir` argument at runtime ("Pass userDataDir parameter to
// browserType.launchPersistentContext(userDataDir, options) instead" —
// Playwright's own error), and `launchPersistentContext()` — the API that
// DOES accept a real, reusable on-disk profile — returns a `BrowserContext`
// with no process handle of its own. There is no supported Playwright API
// that offers both at once. A manual approach (spawning the bundled
// Chromium binary directly via `child_process.spawn` with
// `--remote-debugging-port`, parsing its stderr for the CDP endpoint, and
// connecting via `chromium.connectOverCDP`) would work but trades a large
// amount of fragile, OS-dependent plumbing for a distinction that does not
// actually change what this test can prove — see the next paragraph — so
// it was not built.
//
// This file instead uses `launchPersistentContext()` twice against the
// SAME `userDataDir`, terminating the first via `context.close()` (a
// graceful shutdown, not an abrupt kill). This is a materially weaker
// claim than "survives a SIGKILL" ONLY for data that has NOT yet been
// durably written — and that gap is exactly Test Plan DUR-08's own
// territory (a crash inside the 200ms batching window), already covered
// precisely, with real timer control, in
// packages/client/src/sync/durableQueue.test.ts. For data that HAS
// already been flushed to a real IndexedDB transaction (this test
// deliberately waits past the batching window before terminating), a
// real IndexedDB commit is durable regardless of how the browser process
// subsequently exits — a graceful close cannot make already-committed
// data "more persisted" than an abrupt kill would have left it. What this
// test actually proves — and the reason it belongs in the e2e suite
// rather than only at the Vitest level — is that a REAL Chromium's real
// IndexedDB implementation, a real on-disk profile, and a real second
// browser launch against that same profile behave the way `fake-indexeddb`
// (used everywhere else in this project's Phase 22 tests) predicts they
// will.
//
// Severing client A's connection uses `__collabDebug.forceDisconnect()`
// (App.tsx — calls `SyncClient.disconnect()`), NOT `context.setOffline
// (true)`. That was the first approach tried, and was found NOT to
// reliably block an already-open WebSocket's OUTBOUND frames to a
// localhost server in this Playwright/Chromium combination: client A's
// "severed" operations kept reaching and being committed by the real
// server, and the offline-queue reconcile logic then resent them a SECOND
// time on top of that already-committed copy, producing genuinely
// duplicated content — a test-infrastructure gap (confirmed root-caused,
// including an isolated unit-level reproduction proving
// reconcileOfflineQueue.ts itself is correct at 200-operation scale),
// not a product bug. `forceDisconnect()` calls the same `disconnect()`
// this project already uses for an explicit, deterministic "no further
// automatic reconnection" state — Phase 22's relaxed `requireEngine()`
// permits editing in that state exactly as in `reconnecting`, so this
// still exercises the real offline-editing code path DUR-07 cares about.
//
// Chromium-only (see playwright.config.ts's own comment on this file's
// dedicated project) — persistent profiles via `launchPersistentContext`
// are exercised here against Chromium specifically, the same kind of
// single-engine scoping this project already uses for WebKit's
// DataTransfer limitation (Phase 12).
//
// What this file proves vs. what the Vitest-level tests already prove:
// DUR-07 assertions 1 (typed while severed), 3 (relaunched against the
// same profile), 5 (all 200 land, exactly once), and 6 (converges with a
// second, always-online client) — against a REAL browser and REAL
// IndexedDB. Assertion 4 (HELLO.unacked contains exactly the 200 restored
// stamps) is proven precisely at the wire level in
// packages/client/src/sync/syncClient.durableQueue.test.ts, which decodes
// the actual HELLO frame — not repeated here, since a real browser gives
// no more confidence for that specific claim than the Vitest-level test
// already does, at a much higher cost.

import { chromium, expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startTestAppServer, type TestAppServerHandle } from "./support/testAppServer.js";
import { startTestServer, type TestServerHandle } from "./support/testServer.js";

/**
 * Windows sometimes keeps a brief file-system lock on a just-closed Chromium profile directory
 * (observed directly: `contextA2.close()` resolving before the OS has fully released every
 * handle under `userDataDir`) — retries a few times with a short delay rather than failing the
 * whole test over what is purely test-cleanup housekeeping, unrelated to anything this test
 * actually verifies.
 */
async function cleanupUserDataDir(userDataDir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  console.warn(`durableQueue.spec.ts: could not remove temp profile dir ${userDataDir}`);
}

async function waitForSynced(page: Page, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('[role="status"]')?.textContent?.includes("Synced"),
    undefined,
    { timeout },
  );
}

async function getEngineText(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      (window as unknown as { __collabDebug: { getEngineText(): string | undefined } })
        .__collabDebug.getEngineText() ?? "",
  );
}

async function forceDisconnect(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __collabDebug: { forceDisconnect(): void } }).__collabDebug.forceDisconnect(),
  );
}

async function typeWhileSevered(page: Page, text: string): Promise<void> {
  await page.evaluate((data) => {
    const editor = document.querySelector('[contenteditable="true"]') as HTMLElement;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false); // caret at the end
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const event = new InputEvent("beforeinput", {
      inputType: "insertText",
      data,
      cancelable: true,
      bubbles: true,
    });
    editor.dispatchEvent(event);
  }, text);
}

test.describe.configure({ mode: "serial" }); // a real, terminated-and-relaunched browser profile per test — heavy, run one at a time

test("DUR-07: 200 characters typed while severed survive a real browser process lifetime end, land exactly once, and converge with a second always-online client", async () => {
  test.setTimeout(60_000);

  let appServer: TestAppServerHandle | undefined;
  let server: TestServerHandle | undefined;
  const userDataDir = mkdtempSync(join(tmpdir(), "obseq-dur07-"));
  const documentId = randomUUID();

  try {
    server = await startTestServer();
    appServer = await startTestAppServer();
    const url = `${appServer.url}?doc=${documentId}&server=${server.wsUrl}`;

    // A second client, online THROUGHOUT (DUR-07 assertion 6) — an ordinary, ephemeral browser;
    // it never needs to survive a restart, so it doesn't need a persistent profile.
    const peerBrowser = await chromium.launch();
    const peerPage = await (await peerBrowser.newContext()).newPage();
    await peerPage.goto(url);
    await waitForSynced(peerPage);

    // Client A: a real, on-disk Chromium profile.
    const contextA1 = await chromium.launchPersistentContext(userDataDir, {});
    const pageA1 = contextA1.pages()[0] ?? (await contextA1.newPage());
    await pageA1.goto(url);
    await waitForSynced(pageA1);

    // Sever client A's own connection — see this file's own header comment for why this is
    // `__collabDebug.forceDisconnect()` (deterministic: no further automatic reconnection at
    // all) rather than `context.setOffline(true)`.
    await forceDisconnect(pageA1);

    // 200 characters, typed while genuinely disconnected (Phase 22's relaxed requireEngine()/
    // inputPipeline.ts gate is what makes this even possible — pre-Phase-22, this keystroke
    // would have been silently ignored).
    const text = Array.from({ length: 200 }, (_, i) => String.fromCharCode(0x61 + (i % 26))).join("");
    await typeWhileSevered(pageA1, text);
    await expect.poll(() => getEngineText(pageA1)).toBe(text);

    // Let the 200ms trailing-edge batching window actually flush to real IndexedDB before
    // terminating — DUR-08 (a crash INSIDE that window) is covered separately at the Vitest
    // level (durableQueue.test.ts), with precise real-timer control this test doesn't need.
    await pageA1.waitForTimeout(500);

    // Terminate this browser context/profile lifetime (see this file's own header comment for
    // why this is `close()`, not a literal SIGKILL, and why that distinction does not weaken
    // the claim being tested here).
    await contextA1.close();

    // Relaunch against the SAME on-disk profile — a real browser restart, reopening the same
    // document.
    const contextA2 = await chromium.launchPersistentContext(userDataDir, {});
    const pageA2 = contextA2.pages()[0] ?? (await contextA2.newPage());
    await pageA2.goto(url);
    await waitForSynced(pageA2);

    // DUR-07 assertion 5: all 200 land in the final document, exactly once.
    await expect.poll(() => getEngineText(pageA2), { timeout: 20_000 }).toBe(text);

    // DUR-07 assertion 6: converges with the second client that was online throughout.
    await expect.poll(() => getEngineText(peerPage), { timeout: 20_000 }).toBe(text);

    await contextA2.close();
    await peerBrowser.close();
  } finally {
    await appServer?.stop();
    await server?.server.close();
    await cleanupUserDataDir(userDataDir);
  }
});
