import { expect, test, type Page } from "@playwright/test";
import { setupInputHarnessPage } from "./helpers.js";
// inputHarnessGlobal.d.ts is an ambient declaration file — picked up automatically via
// e2e/tsconfig.json's "include", no import needed.

/**
 * Phase 34 real-browser IME composition coverage — Test Plan §7.3, IME-01 through IME-05,
 * against real Chromium, Firefox, AND WebKit (playwright.config.ts's three single-engine
 * projects). IME-06 is automated separately, at the Vitest/jsdom + `fake-indexeddb` layer
 * (`packages/client/src/input/compositionController.durableQueue.test.ts`) — see that file's own
 * header comment for the full, disclosed reasoning.
 *
 * METHODOLOGY, per this phase's own explicit instruction: real OS-level IME engines
 * (Japanese/Korean/Chinese/Vietnamese input) cannot be reliably driven headlessly across all
 * three browser engines in CI. Every test below drives `CompositionController` via REAL
 * `CompositionEvent` dispatch (`compositionstart`/`compositionupdate`/`compositionend`) — this
 * IS reliably scriptable cross-engine, and exercises the actual production code paths (the state
 * machine, the remote-operation buffer, the watchdog) exactly as a genuine OS IME session would
 * drive them, even though no real OS IME is involved. A REAL, actually-typed Japanese IME
 * session in real macOS Safari is a separate, MANUAL verification step — see this phase's own
 * end-of-phase report for the exact steps, not automated here or anywhere in this repo.
 */

interface HarnessState {
  readonly editor: HTMLElement;
  readonly domWriter: import("./inputHarnessGlobal.js").HarnessDomWriter;
  readonly sync: import("./inputHarnessGlobal.js").HarnessSyncClient;
  readonly sentinel: import("./inputHarnessGlobal.js").HarnessMutationSentinel;
  readonly composition: import("./inputHarnessGlobal.js").HarnessCompositionController;
}

declare global {
  interface Window {
    __harness?: HarnessState;
  }
}

/** Builds the harness (DomWriter + a never-connected SyncClient with its engine seeded directly + MutationSentinel + the input pipeline + CompositionController, all attached to one root) — the same "no network needed" shape `inputPipeline.spec.ts` already established, extended with Phase 34's composition wiring. */
async function setupHarness(page: Page, initialText = "", watchdogMs?: number): Promise<void> {
  await setupInputHarnessPage(page);
  await page.evaluate(
    ({ text, watchdog }) => {
      const editor = document.getElementById("editor")!;
      const domWriter = new window.InputHarness.DomWriter();
      const sync = new window.InputHarness.SyncClient({ url: "ws://unused", documentId: "doc" });
      sync.seedForTesting(new window.InputHarness.Engine(1));
      if (text.length > 0) {
        sync.localInsertText(0, text);
      }
      const sentinel = new window.InputHarness.MutationSentinel({
        root: editor,
        domWriter,
        getEngineText: () => sync.engine?.text(),
      });
      sentinel.applyPatches(() => domWriter.mount(editor, text));
      sentinel.start();
      window.InputHarness.attachInputPipeline(editor, { domWriter, sync, sentinel });
      const composition = new window.InputHarness.CompositionController(
        watchdog === undefined
          ? { domWriter, sync, sentinel, root: editor }
          : { domWriter, sync, sentinel, root: editor, watchdogMs: watchdog },
      );
      window.InputHarness.attachCompositionHandlers(editor, composition);
      window.__harness = { editor, domWriter, sync, sentinel, composition };
    },
    { text: initialText, watchdog: watchdogMs },
  );
}

async function engineText(page: Page): Promise<string> {
  return page.evaluate(() => window.__harness!.sync.engine!.text());
}

async function domText(page: Page): Promise<string> {
  return page.evaluate(() => window.__harness!.domWriter.materializedText());
}

async function isComposing(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__harness!.composition.isComposing);
}

/** Collapses the caret at visible (scalar) index `v` — ASCII-only fixtures here, so scalar === UTF-16 offset. */
async function placeCaret(page: Page, v: number): Promise<void> {
  await page.evaluate((visIndex) => {
    const { domWriter, editor } = window.__harness!;
    const runs = domWriter.index;
    let node: Node = editor;
    let offset = 0;
    for (const run of runs) {
      if (visIndex <= run.startVis + run.scalarLen) {
        node = run.textNode;
        offset = visIndex - run.startVis;
        break;
      }
    }
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, v);
}

/** Selects the visible ASCII range [start, end). */
async function selectRange(page: Page, start: number, end: number): Promise<void> {
  await page.evaluate(
    ({ start: s, end: e }) => {
      const { domWriter, editor } = window.__harness!;
      const runs = domWriter.index;
      function locate(v: number): { node: Node; offset: number } {
        for (const run of runs) {
          if (v <= run.startVis + run.scalarLen) {
            return { node: run.textNode, offset: v - run.startVis };
          }
        }
        return { node: editor, offset: 0 };
      }
      const a = locate(s);
      const b = locate(e);
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { start, end },
  );
}

/** Dispatches a REAL `CompositionEvent` of the given type on the harness's editor root. */
async function fireComposition(
  page: Page,
  type: "compositionstart" | "compositionupdate" | "compositionend",
  data = "",
): Promise<void> {
  await page.evaluate(
    ({ t, d }) => {
      window.__harness!.editor.dispatchEvent(new CompositionEvent(t, { data: d, bubbles: true }));
    },
    { t: type, d: data },
  );
}

test.describe("IME-01 — no operations during composition, exactly one commit", () => {
  test("8 intermediate compositionupdate states mint nothing; compositionend commits the final text as one insert", async ({
    page,
  }) => {
    await setupHarness(page);
    await placeCaret(page, 0);

    await fireComposition(page, "compositionstart");
    expect(await isComposing(page)).toBe(true);

    const beforeCount = await page.evaluate(
      () => window.__harness!.sync.engine!.stats().totalElements,
    );
    for (const data of ["k", "ka", "kan", "kanj", "kanji", "かんじ", "漢字", "感じ"]) {
      await fireComposition(page, "compositionupdate", data);
    }
    expect(await page.evaluate(() => window.__harness!.sync.engine!.stats().totalElements)).toBe(
      beforeCount,
    );
    expect(await engineText(page)).toBe(""); // nothing minted yet

    await fireComposition(page, "compositionend", "感じ");
    expect(await isComposing(page)).toBe(false);
    expect(await engineText(page)).toBe("感じ");
    expect(await domText(page)).toBe("感じ");
    const afterCount = await page.evaluate(
      () => window.__harness!.sync.engine!.stats().totalElements,
    );
    expect(afterCount - beforeCount).toBe(2); // "感じ" — one commit, 2 characters
  });
});

test.describe("IME-04 — composition replacing a selection", () => {
  test("the selection is deleted as an ordinary operation before composition begins; the committed text lands where the selection was", async ({
    page,
  }) => {
    await setupHarness(page, "0123456789");
    await selectRange(page, 2, 5); // "234"

    await fireComposition(page, "compositionstart");
    // The deletion has ALREADY happened — before any composition text exists.
    expect(await engineText(page)).toBe("0156789");
    expect(await domText(page)).toBe("0156789");

    await fireComposition(page, "compositionupdate", "X");
    await fireComposition(page, "compositionend", "XYZ");

    expect(await engineText(page)).toBe("01XYZ56789");
    expect(await domText(page)).toBe("01XYZ56789");
  });
});

test.describe("IME-02/03 — a remote operation arriving mid-composition", () => {
  /** Mints `text` on a SECOND, independent engine seeded to the SAME starting content, then relays the resulting operations directly into the harness's own engine via `applyRemote` — the "two simulated clients, no real network" technique this project's DUR-01/audit tests already use, run entirely inside the page. */
  async function relayRemoteInsert(
    page: Page,
    atVisibleIndex: number,
    text: string,
  ): Promise<void> {
    await page.evaluate(
      ({ at, t }) => {
        const h = window.__harness!;
        const peer = new window.InputHarness.SyncClient({ url: "ws://unused", documentId: "doc" });
        const peerEngine = new window.InputHarness.Engine(2);
        peer.seedForTesting(peerEngine);
        for (const node of h.sync.engine!.nodes) {
          peerEngine.applyRemote({
            kind: "insert",
            id: node.id,
            value: node.value,
            parent: node.parent,
            side: node.side,
            bind: node.bind,
          });
        }
        const ops = peer.localInsertText(at, t);
        for (const op of ops) {
          h.sync.engine!.applyRemote(op);
        }
      },
      { at: atVisibleIndex, t: text },
    );
  }

  /** Mirrors EditorView.tsx's own `onRemoteOpsApplied` handler (capture/composition-gate/mount/restore) — there is no React component in this harness to wire it through automatically. */
  async function reactToRemoteOps(page: Page): Promise<void> {
    await page.evaluate(() => {
      const h = window.__harness!;
      const engine = h.sync.engine!;
      if (h.composition.noteRemoteOpsApplied()) {
        return;
      }
      const snapshot = window.InputHarness.captureCaret(h.domWriter.index, engine);
      h.sentinel.applyPatches(() => h.domWriter.mount(h.editor, engine.text()));
      if (snapshot) {
        window.InputHarness.restoreCaret(snapshot, h.editor, h.domWriter.index, engine);
      }
    });
  }

  test("IME-02: A's composition survives a peer's 20-character insert elsewhere; A's DOM is undisturbed until compositionend; both converge afterward", async ({
    page,
  }) => {
    await setupHarness(page, "hello world");
    await placeCaret(page, 11);

    await fireComposition(page, "compositionstart");
    await fireComposition(page, "compositionupdate", "k");

    await relayRemoteInsert(page, 0, "PEER-TWENTY-CHARS!!!"); // 20 characters
    await reactToRemoteOps(page);

    expect(await isComposing(page)).toBe(true); // NOT aborted
    expect(await domText(page)).toBe("hello world"); // peer's text not yet rendered
    expect(await engineText(page)).toContain("PEER-TWENTY-CHARS!!!"); // already in the engine
    const buffered = await page.evaluate(
      () => window.__harness!.composition.bufferedRemoteOpsCount,
    );
    expect(buffered).toBeGreaterThan(0);

    await fireComposition(page, "compositionend", "kanji");

    expect(await isComposing(page)).toBe(false);
    expect(await domText(page)).toBe(await engineText(page)); // converged
    expect(await engineText(page)).toBe("PEER-TWENTY-CHARS!!!hello worldkanji");
  });

  test("IME-03: a remote insert landing exactly at the composition anchor still commits correctly and converges", async ({
    page,
  }) => {
    await setupHarness(page, "ab");
    await placeCaret(page, 1); // between "a" and "b"

    await fireComposition(page, "compositionstart");
    await fireComposition(page, "compositionupdate", "x");

    await relayRemoteInsert(page, 1, "B-INSERT");
    await reactToRemoteOps(page);
    expect(await domText(page)).toBe("ab"); // still buffered

    await fireComposition(page, "compositionend", "X");

    expect(await engineText(page)).toBe("aXB-INSERTb");
    expect(await domText(page)).toBe("aXB-INSERTb");
  });
});

test.describe("IME-05 — the composition watchdog force-ends a stuck composition", () => {
  test("a composition left open past its configured threshold is force-committed, flushing whatever was observed and logging", async ({
    page,
  }) => {
    const messages: string[] = [];
    page.on("console", (msg) => messages.push(msg.text()));

    // A short, injected threshold (test-only override — see CompositionControllerDeps's own doc
    // comment) exercises the IDENTICAL code path as the real, shipped 10-second default without
    // this test needing to wait 15+ real seconds per Test Plan IME-05's own literal scenario; the
    // shipped default itself is verified boundary-exact, with fake timers, in
    // compositionController.test.ts.
    await setupHarness(page, "", 300);
    await placeCaret(page, 0);

    await fireComposition(page, "compositionstart");
    await fireComposition(page, "compositionupdate", "stuck-candidate");
    expect(await isComposing(page)).toBe(true);

    await page.waitForTimeout(500); // comfortably past the 300ms threshold, real wall-clock wait
    expect(await isComposing(page)).toBe(false);
    expect(await engineText(page)).toBe("stuck-candidate");
    expect(await domText(page)).toBe("stuck-candidate");
    expect(messages.some((m) => m.includes("force-committing"))).toBe(true);

    // The editor is usable again afterward — a genuine LATER composition works normally.
    await fireComposition(page, "compositionstart");
    await fireComposition(page, "compositionend", "-more");
    expect(await engineText(page)).toBe("stuck-candidate-more");
  });
});
