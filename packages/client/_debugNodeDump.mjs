import { chromium, firefox, webkit } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startTestServer } from "./e2e/support/testServer.js";
import { startTestAppServer } from "./e2e/support/testAppServer.js";

// Root-cause diagnostic: reproduce the divergence found by
// _debugNativeRelay60s.mjs's iteration 0 (client 2/webkit ended up 3 chars
// short, and differing mid-string, from clients 0/1 AND the server's own
// independent operation-log replay), and this time dump full node structure
// (ids/origins/bind/tombstone) from every client plus the server's
// replay-nodes endpoint on ANY failure (canary crash OR text mismatch), so
// the exact divergent operation/node can be identified, not just "the
// strings differ starting at index 98."

let lastUncaught = null;
process.on("uncaughtException", (err) => {
  lastUncaught = String(err && err.stack ? err.stack.split("\n")[0] : err);
});

const DELAY_MS = 75;

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

function idKey(id) {
  return id ? `${id.c ?? id.counter}:${id.r ?? id.replica}` : "null";
}

function diffNodes(label, a, b) {
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const na = a[i];
    const nb = b[i];
    const sa = na ? JSON.stringify(na) : "<missing>";
    const sb = nb ? JSON.stringify(nb) : "<missing>";
    if (sa !== sb) {
      console.log(`  [${label}] first structural diff at index ${i}:`);
      console.log(`    a: ${sa}`);
      console.log(`    b: ${sb}`);
      console.log("    context (a):", a.slice(Math.max(0, i - 2), i + 3).map((n) => n && idKey(n.id)));
      console.log("    context (b):", b.slice(Math.max(0, i - 2), i + 3).map((n) => n && idKey(n.id)));
      return i;
    }
  }
  console.log(`  [${label}] no structural diff found (identical node arrays)`);
  return -1;
}

async function runOnce(iter, durationMs) {
  lastUncaught = null;
  const server = await startTestServer();
  const appServer = await startTestAppServer();
  const documentId = randomUUID();
  const url = `${appServer.url}?doc=${documentId}&server=${server.wsUrl}`;

  const browserNames = ["chromium", "firefox", "webkit"];
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
  const failed = !!crashLabel || !ok || !replayOk;

  console.log(
    `[NODEDUMP] iter ${iter}:`,
    crashLabel ? `SERVER-CRASH: ${crashLabel}` : ok && replayOk ? "OK" : "MISMATCH",
    `len=${JSON.stringify(domTexts.map((t) => t.length))} pending=${JSON.stringify(pendingCounts)} replayOk=${replayOk}`,
    evalError ? `evalError=${evalError}` : "",
  );

  if (failed) {
    console.log(`\n=== FAILURE DETAIL, iter ${iter} (doc ${documentId}, port ${server.port}) ===`);
    try {
      const clientNodes = await Promise.all(
        pages.map((p) => p.evaluate(() => window.__collabDebug.getEngineNodes?.() ?? null)),
      );
      const nodesRes = await fetch(`http://127.0.0.1:${server.port}/v1/documents/${documentId}/replay-nodes`);
      const serverNodes = (await nodesRes.json()).nodes;
      for (let i = 0; i < 3; i++) {
        console.log(`  client ${i} (${browserNames[i]}): ${clientNodes[i] ? clientNodes[i].length : "N/A"} nodes`);
      }
      console.log(`  server replay: ${serverNodes.length} nodes`);
      for (let i = 0; i < 3; i++) {
        if (clientNodes[i]) {
          diffNodes(`server vs client${i}(${browserNames[i]})`, serverNodes, clientNodes[i]);
        }
      }
    } catch (e) {
      console.log("  (failed to collect node-level diagnostic detail):", String(e));
    }
    console.log("=== END FAILURE DETAIL ===\n");
  }

  await Promise.all(browsers.map((b) => b.close()));
  await appServer.stop();
  try {
    await server.server.close();
  } catch {}
  return !failed;
}

const DURATION_MS = Number(process.argv[2] ?? 60000);
const RUNS = Number(process.argv[3] ?? 8);
let passed = 0;
for (let i = 0; i < RUNS; i++) {
  let ok = false;
  try {
    ok = await runOnce(i, DURATION_MS);
  } catch (e) {
    console.log(`[NODEDUMP] iter ${i}: HARD-CRASH ${e}`);
  }
  if (ok) passed++;
}
console.log(`\n${passed}/${RUNS} passed at duration=${DURATION_MS}ms (NODEDUMP diagnostic run)`);
