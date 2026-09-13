// Per-user undo/redo client wiring (Phase 36, Engine Spec §9, API Spec §7.8). Owns the
// microtask-based dedup guard UWIRE-02 requires ("a browser firing BOTH historyUndo and keydown
// performs EXACTLY ONE undo") and the keydown fallback UWIRE-02's own wording implies Safari
// needs: real Safari has historically not reliably fired `beforeinput` for keyboard-driven
// undo/redo the way Chromium/Firefox do, so this project cannot rely on the beforeinput dispatch
// table (inputPipeline.ts's own `historyUndo`/`historyRedo` cases) as the ONLY trigger — a
// `keydown` listener is attached alongside it, on the SAME root, sharing this controller's own
// guard so a browser that fires both never performs the action twice.
//
// Deliberately a separate module/controller from `inputPipeline.ts`'s own dispatch table (the
// same architectural split `CompositionController`/`attachCompositionHandlers` already
// established for IME, Phase 34) rather than folding keydown handling into
// `attachInputPipeline` itself — `beforeinput`'s own dispatch table has no equivalent for a
// bare `keydown` event, so this needed its own attach function regardless.

import { NoWriteAccessError } from "../sync/syncClient.js";
import { OfflineWindowExceededError } from "../sync/offlineWindow.js";
import type { SyncClient } from "../sync/syncClient.js";

export interface UndoRedoControllerDeps {
  readonly sync: SyncClient;
}

/**
 * `SyncClient.undo`/`redo` throw the SAME two guard errors `localInsert`/`localDelete` do
 * (`assertHasWriteAccess`/`assertOfflineWindowNotExceeded`) — a VIEWER pressing Ctrl+Z, or a
 * client past the offline-window cap, must be silently ignored here exactly like
 * `inputPipeline.ts`'s own `insertTextAt`/`deleteRangeAt` already do for ordinary typing (see
 * their own comment for the full reasoning), NOT left to escape as an unhandled exception
 * inside a bare `queueMicrotask` callback — a real gap fixed the same day it was introduced,
 * before this ever shipped. Exported for direct, synchronous unit testing (avoids exercising a
 * genuinely-uncaught throw inside a real `queueMicrotask` callback just to prove this).
 */
export function runIgnoringGuardErrors(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof OfflineWindowExceededError || err instanceof NoWriteAccessError) {
      return;
    }
    throw err;
  }
}

/**
 * Schedules an undo/redo via `queueMicrotask` rather than calling `sync.undo()`/`sync.redo()`
 * directly from the triggering event handler — this is the "microtask guard" UWIRE-02 asks for.
 * Both a `beforeinput` (`historyUndo`/`historyRedo`) and a `keydown` (Ctrl+Z/Cmd+Z/etc.) handler
 * can fire for the SAME physical keystroke, in the SAME synchronous browser event-dispatch
 * turn — synchronous code (a keydown handler, then a beforeinput handler, or vice versa,
 * depending on the browser) always runs to completion before any microtask gets a chance to run.
 * So: the FIRST handler to fire for a given keystroke sets `pending*`, and schedules the ACTUAL
 * `sync.undo()`/`sync.redo()` call for the next microtask; the SECOND handler (if the browser
 * fires one) sees `pending*` already `true` and does nothing further. Exactly one undo/redo
 * happens per physical keystroke, regardless of how many of the two event sources a given
 * browser happens to fire for it — including the degenerate case of only ONE of them ever
 * firing (e.g. a browser that never dispatches `beforeinput` for undo at all), which still
 * performs exactly one action, on the very next microtask.
 */
export class UndoRedoController {
  private pendingUndo = false;
  private pendingRedo = false;

  constructor(private readonly deps: UndoRedoControllerDeps) {}

  scheduleUndo(): void {
    if (this.pendingUndo) {
      return;
    }
    this.pendingUndo = true;
    queueMicrotask(() => {
      this.pendingUndo = false;
      runIgnoringGuardErrors(() => this.deps.sync.undo());
    });
  }

  scheduleRedo(): void {
    if (this.pendingRedo) {
      return;
    }
    this.pendingRedo = true;
    queueMicrotask(() => {
      this.pendingRedo = false;
      runIgnoringGuardErrors(() => this.deps.sync.redo());
    });
  }
}

/**
 * Attaches the `keydown` fallback — Ctrl+Z/Cmd+Z (undo), Ctrl+Shift+Z/Cmd+Shift+Z (redo,
 * cross-platform convention), and Scope-IN's own explicit "Ctrl+Y mapped to redo on Windows"
 * (deliberately NOT extended to Cmd+Y on Mac, which is not a redo accelerator there). Always
 * calls `preventDefault()` on a matched combination — a physical Ctrl+Z is also a native
 * browser/OS accelerator that can otherwise trigger `execCommand('undo')` independently of any
 * `beforeinput` dispatch at all; UWIRE-03 already establishes that native undo stack is
 * permanently empty by construction (every `beforeinput` this project ever sees is
 * `preventDefault()`-ed), so letting it fire would be harmless to content but is prevented
 * anyway for a clean, single, well-defined trigger path.
 */
export function attachUndoRedoKeydownFallback(
  root: Element,
  controller: UndoRedoController,
): () => void {
  function onKeyDown(ev: Event): void {
    const ke = ev as KeyboardEvent;
    const mod = ke.ctrlKey || ke.metaKey;
    if (!mod) {
      return;
    }
    const key = ke.key.toLowerCase();
    if (key === "z" && ke.shiftKey) {
      ke.preventDefault();
      controller.scheduleRedo();
    } else if (key === "z") {
      ke.preventDefault();
      controller.scheduleUndo();
    } else if (key === "y" && ke.ctrlKey && !ke.metaKey) {
      ke.preventDefault();
      controller.scheduleRedo();
    }
  }
  root.addEventListener("keydown", onKeyDown);
  return () => root.removeEventListener("keydown", onKeyDown);
}
