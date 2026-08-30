// @vitest-environment jsdom
//
// jsdom implements MutationObserver (including the async, microtask-
// scheduled callback timing this whole mechanism depends on) reliably
// enough for MUT-02's "one direct mutation, reverted" scenario and a basic
// no-false-positives sanity check. MUT-03's full "1,000 keystrokes, three
// real browser engines" requirement — the one that actually distinguishes
// a correct takeRecords()-based implementation from the broken flag-based
// one described in this project's own required comment — needs REAL
// browser task/microtask scheduling under REAL separate keystrokes and
// lives in e2e/mutationSentinel.spec.ts instead; see that file's own
// comment for why a synchronous jsdom loop can't reproduce the same race.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Engine } from "@collab-editor/engine";
import { DomWriter, domToVis, visToDom } from "../binding/index.js";
import { SyncClient } from "../sync/syncClient.js";
import { MutationSentinel } from "./mutationSentinel.js";

beforeEach(() => {
  document.body.replaceChildren();
});

/** Yields exactly one microtask checkpoint — enough for a MutationObserver callback queued during the current synchronous block to run. */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

/** Yields a full macrotask boundary — what separates two genuinely distinct browser tasks (e.g. two real keystrokes), unlike a microtask flush. */
function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("MutationSentinel — MUT-02: a direct DOM mutation is detected and reverted", () => {
  it("reverts a foreign mutation, increments reconciliation by exactly 1, restores the caret, and emits no operation", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const domWriter = new DomWriter();
    const sync = new SyncClient({ url: "ws://unused", documentId: "doc" });
    sync.engine = new Engine(1);
    sync.localInsertText(0, "hello");
    const sentinel = new MutationSentinel({
      root,
      domWriter,
      getEngineText: () => sync.engine?.text(),
    });
    sentinel.applyPatches(() => domWriter.mount(root, "hello"));
    sentinel.start();

    // Place a real caret at visible index 3 (between 'l' and 'l') before the foreign write.
    const pos = visToDom(domWriter.index, root, 3);
    const range = document.createRange();
    range.setStart(pos.node, pos.offset);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const insertSpy = vi.spyOn(sync, "localInsertText");
    const deleteSpy = vi.spyOn(sync, "localDelete");

    // A DIRECT DOM mutation, bypassing DomWriter/applyPatches entirely — exactly what MUT-02 means
    // by "from the test harness, bypassing DomWriter." Deliberately a ROGUE SIBLING NODE, not a
    // `.data =` replacement of the exact text node the caret sits in: per the DOM's own
    // "replace data" boundary-point-adjustment algorithm (which jsdom correctly implements), fully
    // replacing a Text node's `.data` collapses any live Range/Selection anchored inside it to
    // offset 0 as a side effect of the mutation itself — BEFORE this sentinel's (necessarily async,
    // MutationObserver-driven) callback ever runs. That's not a sentinel bug; it's the DOM's own
    // behavior, and it would defeat ANY reactive detector, not just this one. A rogue sibling leaves
    // the caret's own anchor node completely untouched, which is what actually lets "restores the
    // caret" be verified meaningfully here.
    root.appendChild(document.createTextNode("EVIL"));

    await flushMicrotasks();

    expect(domWriter.materializedText()).toBe("hello"); // reverted
    expect(sentinel.metrics.reconciliation).toBe(1); // exactly one revert
    expect(sentinel.metrics.desync_error).toBe(0); // reconciliation itself succeeded cleanly
    expect(insertSpy).not.toHaveBeenCalled(); // no engine operation emitted
    expect(deleteSpy).not.toHaveBeenCalled();

    // Caret restored to the same visible index it was captured at.
    const restoredSel = window.getSelection()!;
    const restoredVis = domToVis(
      domWriter.index,
      restoredSel.anchorNode!,
      restoredSel.anchorOffset,
    );
    expect(restoredVis).toBe(3);

    sentinel.stop();
  });

  it("a mutation that replaces the exact text node the caret sits in: the caret is restored to wherever the DOM's OWN boundary-point adjustment already left it, not necessarily its pre-mutation position — an inherent limit of any MutationObserver-based (reactive, async) detector, not a defect in reconcile() itself", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const domWriter = new DomWriter();
    const sync = new SyncClient({ url: "ws://unused", documentId: "doc" });
    sync.engine = new Engine(1);
    sync.localInsertText(0, "hello");
    const sentinel = new MutationSentinel({
      root,
      domWriter,
      getEngineText: () => sync.engine?.text(),
    });
    sentinel.applyPatches(() => domWriter.mount(root, "hello"));
    sentinel.start();

    const pos = visToDom(domWriter.index, root, 3);
    const range = document.createRange();
    range.setStart(pos.node, pos.offset);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const textNode = root.firstChild as Text;
    textNode.data = "hEllo!! corrupted"; // replaces the SAME node the caret is anchored in

    await flushMicrotasks();

    expect(domWriter.materializedText()).toBe("hello"); // still correctly reverted
    expect(sentinel.metrics.reconciliation).toBe(1);
    // The DOM's own "replace data" algorithm already collapsed the live Selection to offset 0
    // before reconcile() ever ran — captured (and thus restored) position is 0, not 3. Documented
    // here as expected, not silently accepted: see this test's own title.
    const restoredSel = window.getSelection()!;
    const restoredVis = domToVis(
      domWriter.index,
      restoredSel.anchorNode!,
      restoredSel.anchorOffset,
    );
    expect(restoredVis).toBe(0);

    sentinel.stop();
  });

  it("a legitimate write through applyPatches does NOT trigger reconciliation", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const domWriter = new DomWriter();
    const sync = new SyncClient({ url: "ws://unused", documentId: "doc" });
    sync.engine = new Engine(1);
    const sentinel = new MutationSentinel({
      root,
      domWriter,
      getEngineText: () => sync.engine?.text(),
    });
    sentinel.applyPatches(() => domWriter.mount(root, ""));
    sentinel.start();

    sentinel.applyPatches(() => domWriter.insertText(0, "hi"));
    await flushMicrotasks();

    expect(domWriter.materializedText()).toBe("hi");
    expect(sentinel.metrics.reconciliation).toBe(0);

    sentinel.stop();
  });
});

describe("MutationSentinel — a burst of legitimate writes produces zero reconciliations (basic MUT-03 sanity; the authoritative 3-browser/1,000-keystroke check lives in e2e)", () => {
  it("50 sequential applyPatches-wrapped inserts, each separated by a real macrotask boundary, never reconcile", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const domWriter = new DomWriter();
    const sync = new SyncClient({ url: "ws://unused", documentId: "doc" });
    sync.engine = new Engine(1);
    const sentinel = new MutationSentinel({
      root,
      domWriter,
      getEngineText: () => sync.engine?.text(),
    });
    sentinel.applyPatches(() => domWriter.mount(root, ""));
    sentinel.start();

    for (let i = 0; i < 50; i++) {
      const value = 0x61 + (i % 26);
      const op = sync.engine!.localInsert(i, value);
      sentinel.applyPatches(() => domWriter.insertText(i, String.fromCodePoint(op.value)));
      // A real macrotask boundary between writes — the same shape as separate real keystrokes,
      // which is exactly the scenario the boolean-flag bug (see mutationSentinel.ts's own comment)
      // fails under: the flag is already cleared by the time the queued microtask callback runs.
      await flushMacrotask();
    }

    expect(domWriter.materializedText()).toHaveLength(50);
    expect(sentinel.metrics.reconciliation).toBe(0);

    sentinel.stop();
  });
});

describe("MutationSentinel — desync_error (Scope-IN: renderIndex disagrees with materialize())", () => {
  it("increments when a reconciliation's own re-render fails to restore parity with engine.text()", async () => {
    // Fault injection: a DomWriter whose mount() deliberately does not faithfully reproduce the
    // text it's given. This can't happen with the REAL mount() (it builds the render index
    // directly from the given string), so desync_error is not expected to ever fire in practice —
    // this test exists purely to prove the check itself is live, the same "confirm the assertion
    // actually fires" discipline this project's other invariant checks use (e.g. Phase 4's I0).
    class BrokenDomWriter extends DomWriter {
      override mount(root: Element, text: string): void {
        super.mount(root, `${text}!`); // corrupts every re-render
      }
    }

    const root = document.createElement("div");
    document.body.appendChild(root);
    const domWriter = new BrokenDomWriter();
    const sync = new SyncClient({ url: "ws://unused", documentId: "doc" });
    sync.engine = new Engine(1);
    sync.localInsertText(0, "ok");
    const sentinel = new MutationSentinel({
      root,
      domWriter,
      getEngineText: () => sync.engine?.text(),
    });
    sentinel.applyPatches(() => domWriter.mount(root, "ok!")); // pre-corrupted to match what reconcile will produce
    sentinel.start();

    const textNode = root.firstChild as Text;
    textNode.data = "tampered";
    await flushMicrotasks();

    expect(sentinel.metrics.reconciliation).toBe(1);
    expect(sentinel.metrics.desync_error).toBe(1); // BrokenDomWriter's mount("ok") produced "ok!" != "ok"

    sentinel.stop();
  });
});
