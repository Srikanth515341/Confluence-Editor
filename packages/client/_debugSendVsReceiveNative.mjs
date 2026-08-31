import { chromium, firefox, webkit } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startTestServer } from "./e2e/support/testServer.js";
import { startTestAppServer } from "./e2e/support/testAppServer.js";

// Step 1 of the follow-up plan from the send-vs-receive finding
// (delayRelay.ts run: Firefox's server-received-frame count freezes
// permanently mid-run while its own send() count keeps climbing normally
// and bufferedAmount stays 0 — tests/regression/R0001-R0007). This is the
// SAME instrumentation (send-call counting via a WebSocket monkey-patch,
// bufferedAmount sampling, server-side per-connection receivedFrameCount)
// but run against Playwright's NATIVE routeWebSocket()/connectToServer()
// instead of delayRelay.ts, to determine whether the native-injection
// failures (R0002/R0003/R0005/R0006) show the SAME frozen-received-count
// signature, or a different one — critical for knowing whether there is
// one shared root cause or two separate injection-mechanism-specific bugs.

let lastUncaught = null;
process.on("uncaughtException", (err) => {
  lastUncaught = String(err && err.stack ? err.stack.split("\n")[0] : err);
});

const DELAY_MS = 75;

const SEND_DIAG_INIT_SCRIPT = `
(function () {
  window.__wsSendDiag = { sendCount: 0, bufferedSamples: [] };
  const OrigWS = window.WebSocket;
  const origSend = OrigWS.prototype.send;
  OrigWS.prototype.send = function (data) {
    window.__wsSendDiag.sendCount += 1;
    return origSend.call(this, data);
  };
  window.WebSocket = new Proxy(OrigWS, {
    construct(target, args) {
      const inst = new target(...args);
      window.__wsSendDiag.instance = inst;
      return inst;
    },
  });
  setInterval(() => {
    const inst = window.__wsSendDiag.instance;
    if (inst) {
      window.__wsSendDiag.bufferedSamples.push({
        t: Date.now(),
        bufferedAmount: inst.bufferedAmount,
        readyState: inst.readyState,
        sendCount: window.__wsSendDiag.sendCount,
      });
    }
  }, 1000);
})();
`;

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
      if (isOpen()) send(item.data);
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
  const url = `${appServer.url}?doc=${documentId}&server=${server.wsUrl}`;

  const order = ["chromium", "firefox", "webkit"];
  const browsers = await Promise.all([chromium.launch(), firefox.launch(), webkit.launch()]);
  const contexts = await Promise.all(browsers.map((b) => b.newContext()));
  await Promise.all(contexts.map((ctx) => installDelay(ctx, server.wsUrl)));
  await Promise.all(contexts.map((ctx) => ctx.addInitScript(SEND_DIAG_INIT_SCRIPT)));
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

  const samples = [];
  const sampleStart = Date.now();
  const sampleTimer = setInterval(async () => {
    try {
      const nodeCounts = await Promise.all(
        pages.map((p) => p.evaluate(() => window.__collabDebug.getEngineNodes?.()?.length ?? -1).catch(() => -2)),
      );
      const sendCounts = await Promise.all(
        pages.map((p) => p.evaluate(() => window.__wsSendDiag?.sendCount ?? -1).catch(() => -1)),
      );
      const bufferedNow = await Promise.all(
        pages.map((p) => p.evaluate(() => window.__wsSendDiag?.instance?.bufferedAmount ?? -1).catch(() => -1)),
      );
      let serverNodeCount = -1;
      let frameCounts = [];
      try {
        const [nodesRes, countsRes] = await Promise.all([
          fetch(`http://127.0.0.1:${server.port}/v1/documents/${documentId}/replay-nodes`),
          fetch(`http://127.0.0.1:${server.port}/v1/documents/${documentId}/session-frame-counts`),
        ]);
        serverNodeCount = (await nodesRes.json()).nodes.length;
        frameCounts = (await countsRes.json()).sessions;
      } catch {}
      samples.push({ tMs: Date.now() - sampleStart, nodeCounts, sendCounts, bufferedNow, serverNodeCount, frameCounts });
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
  let finalSendCounts = [-1, -1, -1];
  let finalFrameCounts = [];
  let finalReplicaIds = [-1, -1, -1];
  let replay = { text: "", pendingCount: -1 };
  let evalError = null;
  try {
    domTexts = await Promise.all(pages.map((p) => p.evaluate(() => document.querySelector('[contenteditable="true"]')?.textContent ?? "")));
    const engineTexts = await Promise.all(pages.map((p) => p.evaluate(() => window.__collabDebug.getEngineText() ?? "")));
    pendingCounts = await Promise.all(pages.map((p) => p.evaluate(() => window.__collabDebug.getPendingCount() ?? -1)));
    finalSendCounts = await Promise.all(pages.map((p) => p.evaluate(() => window.__wsSendDiag?.sendCount ?? -1)));
    finalReplicaIds = await Promise.all(pages.map((p) => p.evaluate(() => window.__collabDebug?.getReplicaId?.() ?? -1)));
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
    const countsRes = await fetch(`http://127.0.0.1:${server.port}/v1/documents/${documentId}/session-frame-counts`);
    finalFrameCounts = (await countsRes.json()).sessions;
  } catch (e) {
    evalError = String(e);
  }

  const crashLabel = lastUncaught ?? serverCrash;
  const failed = !!crashLabel || !ok || !replayOk;

  console.log(
    `[SENDVSRECV-NATIVE] iter ${iter} order=${JSON.stringify(order)}:`,
    crashLabel ? `SERVER-CRASH: ${crashLabel}` : ok && replayOk ? "OK" : "MISMATCH",
    `domLen=${JSON.stringify(domTexts.map((t) => t.length))} pending=${JSON.stringify(pendingCounts)}`,
    `finalSendCounts(chromium,firefox,webkit)=${JSON.stringify(finalSendCounts)}`,
    `finalReplicaIds(chromium,firefox,webkit)=${JSON.stringify(finalReplicaIds)}`,
    `finalServerFrameCounts=${JSON.stringify(finalFrameCounts)}`,
    evalError ? `evalError=${evalError}` : "",
  );

  if (failed) {
    console.log(`  --- sample timeline (t_ms, nodeCounts, sendCounts[chromium,firefox,webkit], bufferedAmountNow, serverNodeCount, serverFrameCounts) ---`);
    for (const s of samples) {
      console.log(
        `  t=${s.tMs}ms nodes=${JSON.stringify(s.nodeCounts)} sendCounts=${JSON.stringify(s.sendCounts)} buffered=${JSON.stringify(s.bufferedNow)} server=${s.serverNodeCount} serverFrameCounts=${JSON.stringify(s.frameCounts)}`,
      );
    }
  }

  await Promise.all(browsers.map((b) => b.close()));
  await appServer.stop();
  try {
    await server.server.close();
  } catch {}
  return !failed;
}

const DURATION_MS = Number(process.argv[2] ?? 60000);
const RUNS = Number(process.argv[3] ?? 10);
let passed = 0;
for (let i = 0; i < RUNS; i++) {
  let ok = false;
  try {
    ok = await runOnce(i, DURATION_MS);
  } catch (e) {
    console.log(`[SENDVSRECV-NATIVE] iter ${i}: HARD-CRASH ${e}`);
  }
  if (ok) passed++;
}
console.log(`\n${passed}/${RUNS} passed (SENDVSRECV-NATIVE diagnostic run)`);
