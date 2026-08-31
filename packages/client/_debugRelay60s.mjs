import { chromium, firefox, webkit } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startTestServer } from "./e2e/support/testServer.js";
import { startTestAppServer } from "./e2e/support/testAppServer.js";
import { startDelayRelay } from "./e2e/support/delayRelay.js";

// The engine's Case C canary throws from inside a WS message handler, which runs IN THIS SAME
// process (testServer.ts's createCollabServer() is in-process, not a subprocess) — an uncaught
// exception there would otherwise crash this whole script. Catch it, record it, let the current
// iteration report as a failure, and continue to the next one.
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
  console.log(
    `[RELAY ~150ms] iter ${iter} duration=${durationMs}ms:`,
    crashLabel ? `SERVER-CRASH: ${crashLabel}` : ok && replayOk ? "OK" : "MISMATCH",
    `len=${domTexts[0].length} pending=${JSON.stringify(pendingCounts)} replayOk=${replayOk}`,
    evalError ? `evalError=${evalError}` : "",
  );
  if ((!ok || !replayOk) && !crashLabel) {
    console.log("  dom0", JSON.stringify(domTexts[0]));
    console.log("  dom1", JSON.stringify(domTexts[1]));
    console.log("  dom2", JSON.stringify(domTexts[2]));
    console.log("  replay.text", JSON.stringify(replay.text));
  }

  await Promise.all(browsers.map((b) => b.close()));
  await relay.close();
  await appServer.stop();
  try {
    await server.server.close();
  } catch {}
  return !crashLabel && ok && replayOk;
}

const DURATION_MS = Number(process.argv[2] ?? 60000);
const RUNS = Number(process.argv[3] ?? 5);
let passed = 0;
for (let i = 0; i < RUNS; i++) {
  let ok = false;
  try {
    ok = await runOnce(i, DURATION_MS);
  } catch (e) {
    console.log(`[RELAY ~150ms] iter ${i} duration=${DURATION_MS}ms: HARD-CRASH ${e}`);
  }
  if (ok) passed++;
}
console.log(`\n${passed}/${RUNS} passed at duration=${DURATION_MS}ms (RELAY ~150ms RTT)`);
