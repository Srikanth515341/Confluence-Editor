import { chromium, firefox, webkit } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startTestServer } from "./e2e/support/testServer.js";
import { startTestAppServer } from "./e2e/support/testAppServer.js";

// Isolation experiment: inject the SAME ~150ms RTT (~75ms each way) using
// Playwright's OWN native context.routeWebSocket()/connectToServer() API
// instead of the hand-rolled delayRelay.ts. No separate relay process, no
// upstream WebSocket management, no readiness/flush/teardown logic of our
// own — Playwright owns the actual connection to the real server; we only
// delay when each side's message is forwarded. This removes ~280 lines of
// our own relay code as a variable entirely, per the user's explicit ask,
// to help separate "bug in delayRelay.ts" from "real timing-dependent bug
// in the actual sync/reconnect logic that higher latency exposes."

let lastUncaught = null;
process.on("uncaughtException", (err) => {
  lastUncaught = String(err && err.stack ? err.stack.split("\n")[0] : err);
});

const DELAY_MS = 75;

/**
 * Minimal strict-FIFO delay queue — order-preserving. `isOpen()` guards each
 * send so a route that has already closed (a real client-initiated
 * reconnect, or the peer tearing down) is never sent to — mirroring
 * delayRelay.ts's own already-fixed "never crash on a closed destination"
 * handling, kept out of the first draft of this script purely to stay
 * minimal, which was itself the bug that produced iteration 0's crash.
 */
function makeQueue(send, isOpen, delayMs) {
  const q = [];
  let timer;
  let stopped = false;
  function armForHead() {
    if (stopped || timer !== undefined || q.length === 0) return;
    const delay = Math.max(0, q[0].dueAt - Date.now());
    timer = setTimeout(drain, delay);
  }
  function drain() {
    timer = undefined;
    if (stopped) return;
    const now = Date.now();
    while (q.length > 0 && q[0].dueAt <= now) {
      const item = q.shift();
      if (isOpen()) {
        send(item.data);
      }
      // If not open, drop silently (the connection is closing/closed — there is no
      // "later" for this specific message to still be deliverable to).
    }
    armForHead();
  }
  return {
    push(data) {
      if (stopped) return;
      q.push({ data, dueAt: Date.now() + delayMs });
      armForHead();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

async function installDelay(context, wsUrl) {
  await context.routeWebSocket(wsUrl, (ws) => {
    const server = ws.connectToServer();
    let clientOpen = true;
    let serverOpen = true;
    const toServer = makeQueue((msg) => server.send(msg), () => clientOpen && serverOpen, DELAY_MS);
    const toClient = makeQueue((msg) => ws.send(msg), () => clientOpen && serverOpen, DELAY_MS);
    ws.onMessage((msg) => toServer.push(msg));
    server.onMessage((msg) => toClient.push(msg));
    ws.onClose(() => {
      clientOpen = false;
      toServer.stop();
      toClient.stop();
      try {
        server.close();
      } catch {}
    });
    server.onClose(() => {
      serverOpen = false;
      toServer.stop();
      toClient.stop();
      try {
        ws.close();
      } catch {}
    });
  });
}

async function runOnce(iter, durationMs) {
  lastUncaught = null;
  const server = await startTestServer();
  const appServer = await startTestAppServer();
  const documentId = randomUUID();
  // Point directly at the REAL server — no relay process at all. Playwright's
  // routeWebSocket intercepts the browser's own WebSocket transparently.
  const url = `${appServer.url}?doc=${documentId}&server=${server.wsUrl}`;

  const browsers = await Promise.all([chromium.launch(), firefox.launch(), webkit.launch()]);
  const contexts = await Promise.all(browsers.map((b) => b.newContext()));
  await Promise.all(contexts.map((ctx) => installDelay(ctx, server.wsUrl)));
  const pages = await Promise.all(contexts.map((ctx) => ctx.newPage()));

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
    `[NATIVE routeWebSocket ~150ms] iter ${iter} duration=${durationMs}ms:`,
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
    console.log(`[NATIVE routeWebSocket ~150ms] iter ${i} duration=${DURATION_MS}ms: HARD-CRASH ${e}`);
  }
  if (ok) passed++;
}
console.log(`\n${passed}/${RUNS} passed at duration=${DURATION_MS}ms (NATIVE routeWebSocket ~150ms RTT)`);
