// @vitest-environment jsdom
//
// Phase 36 (Test Plan UWIRE-02, API Spec §7.8). Unit-level coverage of `UndoRedoController`'s
// own microtask-guard logic and `attachUndoRedoKeydownFallback`'s key-combination mapping —
// deterministic and layer-appropriate here (no real browser needed to prove "a second
// synchronous trigger within the same tick is a no-op" or "Ctrl+Y maps to redo"). The REAL,
// cross-browser claim UWIRE-02 makes ("a browser firing BOTH historyUndo and keydown performs
// EXACTLY ONE undo") is additionally verified against real Chromium/Firefox/WebKit in
// e2e/undoRedo.spec.ts, since only a real browser can show whether it ACTUALLY fires both.

import { describe, expect, it, vi } from "vitest";
import { Engine } from "@collab-editor/engine";
import { NoWriteAccessError, SyncClient } from "../sync/syncClient.js";
import { OfflineWindowExceededError } from "../sync/offlineWindow.js";
import {
  attachUndoRedoKeydownFallback,
  runIgnoringGuardErrors,
  UndoRedoController,
} from "./undoRedoController.js";

function makeSync(initialText = ""): SyncClient {
  const sync = new SyncClient({ url: "ws://unused", documentId: "doc" });
  sync.seedForTesting(new Engine(1));
  if (initialText.length > 0) {
    sync.localInsertText(0, initialText);
  }
  return sync;
}

describe("UndoRedoController — microtask guard (UWIRE-02)", () => {
  it("two synchronous scheduleUndo() calls in the same tick perform exactly one undo", async () => {
    const sync = makeSync("ab");
    const undoSpy = vi.spyOn(sync, "undo");
    const controller = new UndoRedoController({ sync });

    // Simulates a browser firing BOTH a `beforeinput` (historyUndo) AND a `keydown` handler for
    // the SAME physical keystroke, synchronously, in the same task.
    controller.scheduleUndo();
    controller.scheduleUndo();
    expect(undoSpy).not.toHaveBeenCalled(); // deferred to a microtask, not called synchronously

    await Promise.resolve();
    expect(undoSpy).toHaveBeenCalledTimes(1); // exactly one undo, not two
    expect(sync.engine!.text()).toBe("a");
  });

  it("two synchronous scheduleRedo() calls in the same tick perform exactly one redo", async () => {
    const sync = makeSync("a");
    sync.undo();
    const redoSpy = vi.spyOn(sync, "redo");
    const controller = new UndoRedoController({ sync });

    controller.scheduleRedo();
    controller.scheduleRedo();
    await Promise.resolve();
    expect(redoSpy).toHaveBeenCalledTimes(1);
    expect(sync.engine!.text()).toBe("a");
  });

  it("a SEPARATE tick's scheduleUndo() (after the microtask queue has drained) performs a genuinely SECOND undo", async () => {
    const sync = makeSync("abc");
    const controller = new UndoRedoController({ sync });

    controller.scheduleUndo();
    await Promise.resolve();
    expect(sync.engine!.text()).toBe("ab");

    controller.scheduleUndo(); // a NEW tick, NOT a duplicate of the first
    await Promise.resolve();
    expect(sync.engine!.text()).toBe("a");
  });

  it("undo and redo guards are independent — scheduling both in the same tick performs both exactly once", async () => {
    const sync = makeSync("a");
    sync.localInsertText(1, "b"); // "ab", so there's something to undo
    const controller = new UndoRedoController({ sync });

    controller.scheduleUndo(); // will undo the 'b'
    await Promise.resolve();
    expect(sync.engine!.text()).toBe("a");

    controller.scheduleRedo(); // redo it back
    controller.scheduleRedo(); // duplicate in the same tick -- must not double-redo
    await Promise.resolve();
    expect(sync.engine!.text()).toBe("ab");
  });
});

describe("UndoRedoController — guard-error handling (a real gap found and fixed the same day it was introduced)", () => {
  // SyncClient.undo()/redo() throw the SAME two guard errors localInsert/localDelete do
  // (assertHasWriteAccess/assertOfflineWindowNotExceeded) — a VIEWER pressing Ctrl+Z, or a
  // client past the offline-window cap, must be silently ignored, exactly like
  // inputPipeline.ts's own insertTextAt/deleteRangeAt already do for ordinary typing, NOT left
  // to escape as an unhandled exception inside the controller's own bare `queueMicrotask`
  // callback. Constructing a real VIEWER-role SyncClient requires a full real handshake
  // (`roleValue` is private, set only from a real WELCOME/PERMISSION_CHANGED message) — mocking
  // `sync.undo`/`sync.redo` to throw the exact same error classes tests the CONTROLLER's own
  // catch logic directly, which is where this fix actually lives.
  it("NoWriteAccessError from sync.undo() is swallowed, never becomes an unhandled rejection", async () => {
    const sync = makeSync("a");
    vi.spyOn(sync, "undo").mockImplementation(() => {
      throw new NoWriteAccessError();
    });
    const controller = new UndoRedoController({ sync });
    const onUnhandled = vi.fn();
    process.once("unhandledRejection", onUnhandled);

    controller.scheduleUndo();
    await Promise.resolve();
    await Promise.resolve(); // let the microtask's own thrown error fully settle

    expect(onUnhandled).not.toHaveBeenCalled();
    process.removeListener("unhandledRejection", onUnhandled);
  });

  it("OfflineWindowExceededError from sync.redo() is swallowed, never becomes an unhandled rejection", async () => {
    const sync = makeSync("a");
    vi.spyOn(sync, "redo").mockImplementation(() => {
      throw new OfflineWindowExceededError();
    });
    const controller = new UndoRedoController({ sync });
    const onUnhandled = vi.fn();
    process.once("unhandledRejection", onUnhandled);

    controller.scheduleRedo();
    await Promise.resolve();
    await Promise.resolve();

    expect(onUnhandled).not.toHaveBeenCalled();
    process.removeListener("unhandledRejection", onUnhandled);
  });

  it("runIgnoringGuardErrors: NoWriteAccessError and OfflineWindowExceededError are swallowed, any OTHER error is rethrown unchanged", () => {
    expect(() =>
      runIgnoringGuardErrors(() => {
        throw new NoWriteAccessError();
      }),
    ).not.toThrow();
    expect(() =>
      runIgnoringGuardErrors(() => {
        throw new OfflineWindowExceededError();
      }),
    ).not.toThrow();
    const boom = new Error("something else entirely");
    expect(() =>
      runIgnoringGuardErrors(() => {
        throw boom;
      }),
    ).toThrow(boom);
  });
});

describe("attachUndoRedoKeydownFallback — key-combination mapping (Scope-IN: Ctrl+Y on Windows)", () => {
  function fire(root: Element, init: KeyboardEventInit): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", { ...init, cancelable: true, bubbles: true });
    root.dispatchEvent(ev);
    return ev;
  }

  it("Ctrl+Z schedules undo and prevents default", async () => {
    const sync = makeSync("a");
    const controller = new UndoRedoController({ sync });
    const undoSpy = vi.spyOn(controller, "scheduleUndo");
    const root = document.createElement("div");
    attachUndoRedoKeydownFallback(root, controller);

    const ev = fire(root, { key: "z", ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(undoSpy).toHaveBeenCalledTimes(1);
  });

  it("Cmd+Z (metaKey) also schedules undo — Mac accelerator", () => {
    const sync = makeSync("a");
    const controller = new UndoRedoController({ sync });
    const undoSpy = vi.spyOn(controller, "scheduleUndo");
    const root = document.createElement("div");
    attachUndoRedoKeydownFallback(root, controller);

    fire(root, { key: "z", metaKey: true });
    expect(undoSpy).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Shift+Z schedules redo, never undo", () => {
    const sync = makeSync("a");
    const controller = new UndoRedoController({ sync });
    const undoSpy = vi.spyOn(controller, "scheduleUndo");
    const redoSpy = vi.spyOn(controller, "scheduleRedo");
    const root = document.createElement("div");
    attachUndoRedoKeydownFallback(root, controller);

    fire(root, { key: "z", ctrlKey: true, shiftKey: true });
    expect(redoSpy).toHaveBeenCalledTimes(1);
    expect(undoSpy).not.toHaveBeenCalled();
  });

  it("Ctrl+Y (Windows) schedules redo — Scope-IN's own explicit requirement", () => {
    const sync = makeSync("a");
    const controller = new UndoRedoController({ sync });
    const redoSpy = vi.spyOn(controller, "scheduleRedo");
    const root = document.createElement("div");
    attachUndoRedoKeydownFallback(root, controller);

    const ev = fire(root, { key: "y", ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(redoSpy).toHaveBeenCalledTimes(1);
  });

  it("Cmd+Y (Mac) does NOT schedule redo — Ctrl+Y is a Windows-only accelerator, deliberately not extended to metaKey", () => {
    const sync = makeSync("a");
    const controller = new UndoRedoController({ sync });
    const redoSpy = vi.spyOn(controller, "scheduleRedo");
    const undoSpy = vi.spyOn(controller, "scheduleUndo");
    const root = document.createElement("div");
    attachUndoRedoKeydownFallback(root, controller);

    const ev = fire(root, { key: "y", metaKey: true });
    expect(ev.defaultPrevented).toBe(false); // not our accelerator -- left alone
    expect(redoSpy).not.toHaveBeenCalled();
    expect(undoSpy).not.toHaveBeenCalled();
  });

  it("a plain 'z' with no modifier key is ignored entirely", () => {
    const sync = makeSync("a");
    const controller = new UndoRedoController({ sync });
    const undoSpy = vi.spyOn(controller, "scheduleUndo");
    const root = document.createElement("div");
    attachUndoRedoKeydownFallback(root, controller);

    const ev = fire(root, { key: "z" });
    expect(ev.defaultPrevented).toBe(false);
    expect(undoSpy).not.toHaveBeenCalled();
  });

  it("detach stops the listener from firing", () => {
    const sync = makeSync("a");
    const controller = new UndoRedoController({ sync });
    const undoSpy = vi.spyOn(controller, "scheduleUndo");
    const root = document.createElement("div");
    const detach = attachUndoRedoKeydownFallback(root, controller);
    detach();

    fire(root, { key: "z", ctrlKey: true });
    expect(undoSpy).not.toHaveBeenCalled();
  });
});
