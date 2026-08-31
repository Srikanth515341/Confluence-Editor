import { chromium, firefox, webkit } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startTestServer } from "./e2e/support/testServer.js";
import { startTestAppServer } from "./e2e/support/testAppServer.js";
import { startDelayRelay } from "./e2e/support/delayRelay.js";

// Follow-up to R0007 (tests/regression/): Firefox is now confirmed (4/4
// node-dumped failures, 2 independent injection mechanisms, independent of
// slot) as the client that silently ends up ahead of server ground truth.
// This script samples each client's node count, SyncClient.state, and
// reconnectAttemptCount every 3s during the 60s run, so a divergence can be
// correlated against exactly when it started and whether a reconnect/state
// change preceded it — rather than only knowing the final before/after
// totals.

let lastUncaught = null;
process.on("uncaughtException", (err) => {
  lastUncaught = String(err && err.stack ? err.stack.split("\n")[0] : err);
});

async function runOnce(iter, durationMs) {
  lastUncaught = null;
  const server = await startTestServer();
  const appServer = await startTestAppServer();
  const relay = await startDelayRelay(server.wsUrl, 75);
  const documentId = randomUUID();
  const url = `${appServer.url}?doc=${documentId}&server=${relay.url}/v1/rt`;

  const order = ["chromium", "firefox", "webkit"];
  const browsers = await Promise.all([chromium.launch(), firefox.launch(), webkit.launch()]);
  const pages = await Promise.all(browsers.map(async (b) => (await b.newContext()).newPage()));

  await Promise.all(pages.map((p) => p.goto(url)));
  await Promise.all(
    pages.map((p) =>
      p.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === "Synced", undefined, {
        timeout: 20000,
      }),
    ),
  );

  const seed = "the quick brown fox!";
  await pages[0].evaluate((text) => {
    const editor = document.querySelector('[contenteditable="true"]');
    editor.focus();
    editor.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, cancelable: true, bubbles: true }));
  }, seed);

  for (let i = 1; i < 3; i++) {
    await pages[i].waitForFunction((s) => window.__collabDebug.getEngineText() === s, seed, { timeout: 10000 });
  }

  const markers = ["A", "B", "C"];
  let serverCrash = null;

  // Sampling loop, runs concurrently with typing.
  const samples = [];
  const sampleStart = Date.now();
  const sampleTimer = setInterval(async () => {
    try {
      const [nodeCounts, states, reconnects] = await Promise.all([
        Promise.all(pages.map((p) => p.evaluate(() => window.__collabDebug.getEngineNodes?.()?.length ?? -1).catch(() => -2))),
        Promise.all(pages.map((p) => p.evaluate(() => window.__collabDebug.getConnectionState?.() ?? "?").catch(() => "?"))),
        Promise.all(pages.map((p) => p.evaluate(() => window.__collabDebug.getReconnectAttemptCount?.() ?? -1).catch(() => -1))),
      ]);
      let serverNodeCount = -1;
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/v1/documents/${documentId}/replay-nodes`);
        serverNodeCount = (await res.json()).nodes.length;
      } catch {}
      samples.push({ tMs: Date.now() - sampleStart, nodeCounts, states, reconnects, serverNodeCount });
    } catch {}
  }, 3000);

  try {
    await Promise.all(
      pages.map((page, i) =>
        page.evaluate(
          ({ marker, durationMs: dMs, intervalMs }) => {
            return new Promise((resolve) => {
              const editor = document.querySelector('[contenteditable="true"]');
              const deadline = Date.now() + dMs;
              function placeCaretAtOffset(offset) {
                let remaining = offset;
                for (const node of Array.from(editor.childNodes)) {
                  if (node.nodeType === Node.TEXT_NODE) {
                    const len = node.data.length;
                    if (remaining <= len) {
                      const range = document.createRange();
                      range.setStart(node, remaining);
                      range.collapse(true);
                      const sel = window.getSelection();
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
                  range.setStart(last, last.data.length);
                } else {
                  range.setStart(editor, editor.childNodes.length);
                }
                range.collapse(true);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
              }
              function tick() {
                if (Date.now() >= deadline) {
                  resolve();
                  return;
                }
                const textLen = editor.textContent?.length ?? 0;
                const span = Math.max(1, Math.min(20, textLen + 1));
                const offset = Math.min(textLen, Math.floor(Math.random() * span));
                placeCaretAtOffset(offset);
                editor.dispatchEvent(
                  new InputEvent("beforeinput", { inputType: "insertText", data: marker, cancelable: true, bubbles: true }),
                );
                setTimeout(tick, intervalMs);
              }
              tick();
            });
          },
          { marker: markers[i], durationMs, intervalMs: 200 },
        ),
      ),
    );
  } catch (e) {
    serverCrash = String(e);
  }

  clearInterval(sampleTimer);
  await new Promise((r) => setTimeout(r, 3000));

  let ok = false;
  let replayOk = false;
  let domTexts = ["", "", ""];
  let pendingCounts = [-1, -1, -1];
  let replay = { text: "", pendingCount: -1 };
  let evalError = null;
  try {
    domTexts = await Promise.all(pages.map((p) => p.evaluate(() => document.querySelector('[contenteditable="true"]')?.textContent ?? "")));
    const engineTexts = await Promise.all(pages.map((p) => p.evaluate(() => window.__collabDebug.getEngineText() ?? "")));
    pendingCounts = await Promise.all(pages.map((p) => p.evaluate(() => window.__collabDebug.getPendingCount() ?? -1)));
    ok =
      domTexts[0] === domTexts[1] &&
      domTexts[1] === domTexts[2] &&
      domTexts[0] === engineTexts[0] &&
      domTexts[1] === engineTexts[1] &&
      domTexts[2] === engineTexts[2] &&
      pendingCounts.every((c) => c === 0);
    const replayRes = await fetch(`http://127.0.0.1:${server.port}/v1/documents/${documentId}/replay`);
    replay = await replayRes.json();
    replayOk = replay.text === domTexts[0] && replay.pendingCount === 0;
  } catch (e) {
    evalError = String(e);
  }

  const crashLabel = lastUncaught ?? serverCrash;
  const failed = !!crashLabel || !ok || !replayOk;

  console.log(
    `[TIMELINE] iter ${iter} order=${JSON.stringify(order)}:`,
    crashLabel ? `SERVER-CRASH: ${crashLabel}` : ok && replayOk ? "OK" : "MISMATCH",
    `domLen=${JSON.stringify(domTexts.map((t) => t.length))} pending=${JSON.stringify(pendingCounts)}`,
    evalError ? `evalError=${evalError}` : "",
  );

  if (failed) {
    console.log(`  --- sample timeline (t_ms, nodeCounts[chromium,firefox,webkit], states, reconnectCounts, serverNodeCount) ---`);
    for (const s of samples) {
      console.log(`  t=${s.tMs}ms nodes=${JSON.stringify(s.nodeCounts)} states=${JSON.stringify(s.states)} reconnects=${JSON.stringify(s.reconnects)} server=${s.serverNodeCount}`);
    }
  }

  await Promise.all(browsers.map((b) => b.close()));
  await relay.close();
  await appServer.stop();
  try {
    await server.server.close();
  } catch {}
  return !failed;
}

const DURATION_MS = Number(process.argv[2] ?? 60000);
const RUNS = Number(process.argv[3] ?? 6);
let passed = 0;
for (let i = 0; i < RUNS; i++) {
  let ok = false;
  try {
    ok = await runOnce(i, DURATION_MS);
  } catch (e) {
    console.log(`[TIMELINE] iter ${i}: HARD-CRASH ${e}`);
  }
  if (ok) passed++;
}
console.log(`\n${passed}/${RUNS} passed (TIMELINE diagnostic run)`);
