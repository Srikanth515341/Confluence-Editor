// IME and composition handling (Phase 34). API Spec §7.4.2 (the
// insertCompositionText/deleteCompositionText rows), §7.6 (composition);
// PRD FR-CE-10, R4; Test Plan §7.3 (IME-01..IME-06). Dependencies: Phase 12
// (load-bearing — this module owns the ONE deliberate carve-out from
// inputPipeline.ts's otherwise-universal "prevent every beforeinput" rule).
//
// The composition state machine, per Scope-IN: a `composing` flag, a
// `compositionAnchor`, and a `remoteBuffer`. Unlike every OTHER
// beforeinput-driven mutation in this pipeline, composition does NOT mutate
// the engine per keystroke — a real IME session (Japanese romaji->kanji,
// Korean jamo assembly, Chinese Pinyin candidate selection, Vietnamese
// Telex/VNI diacritics that retroactively modify an EARLIER character) is
// one long-lived, multi-step editing gesture that only becomes a real,
// intention-preserving edit once the user COMMITS it. Emitting an operation
// per intermediate composition state would broadcast a stream of
// nonsensical partial syllables to every peer and make undo/redo (Phase 36)
// incoherent. So: nothing is minted until `compositionend`; the browser's
// own native rendering is what the user sees while composing (there is no
// way for `DomWriter` to render an uncommitted, mid-conversion candidate
// string itself — only a real IME engine knows what that should look like).
//
// `compositionAnchor` is stored as a stable node IDENTIFIER (via
// `resolvePresenceAnchor`), never a raw numeric visible index — this is
// what makes IME-03 (a remote operation landing INSIDE, or before, the
// composition region) converge correctly: a numeric index captured at
// `compositionstart` would be silently wrong by the time `compositionend`
// commits, arbitrarily many seconds later, if a peer inserted or deleted
// anything before it in the meantime. `Engine.resolveCaret` (Phase 32) is
// the exact inverse, resolving the identifier back to a CURRENT index at
// commit time — the identical mechanism `caretTracker.ts` already
// established for tracking THIS session's own caret through a remote edit,
// reused here for the one caret position that matters most during
// composition.
//
// `remoteBuffer`, per Scope-IN's explicit instruction ("Remote operations
// buffered at the BINDING layer during composition, not the engine"): the
// ENGINE always applies a remote operation the instant it arrives,
// composition or not (`SyncClient.handleOps` has no knowledge of this
// controller and must not gain any — the engine's own causal-readiness
// machinery cannot be paused without breaking convergence for every OTHER
// concurrently-connected replica). What's buffered is the DOM's own
// REACTION to that arrival: `EditorView.tsx`'s `onRemoteOpsApplied` handler
// would ordinarily remount the whole contenteditable subtree from
// `engine.text()` immediately — doing that DURING an active composition
// would destroy the browser's own live composition UI, aborting the
// composition entirely (IME-02's own "ASSERT A's composition is NOT
// aborted"). `noteRemoteOpsApplied()` is the gate EditorView checks before
// reacting; while composing, it counts the arrival and returns `true`
// (deferred) instead. Nothing further needs to be "replayed" once
// composition commits — `commit()`'s own final remount reads whatever
// `engine.text()` says AT THAT MOMENT, which by construction already
// reflects every remote operation that landed in the meantime. That IS the
// flush.
//
// Two disclosed, deliberately out-of-scope edge cases, neither named by
// Scope-IN nor exercised by IME-01..06: (1) an ordinary (non-composition)
// beforeinput arriving WHILE composing -- real browsers route every edit
// through composition events for the duration of an active session, so
// this is not reachable via any genuine IME, only via a synthetic/scripted
// event stream deliberately constructed to violate that; (2) a brand-new
// engine arriving via a fresh SNAPSHOT (EditorView.tsx's own
// mountIfNewEngine, e.g. a slow reconnect's handshake completing) DURING
// an active composition -- that remount is unconditional and would replace
// the DOM subtree the browser's own composition UI is rendering into,
// independent of anything this controller does. IME-06 only covers a
// DISCONNECT during composition (the resident engine is unaffected until a
// handshake actually completes), not a full reconnect racing to completion
// mid-composition.

import type { Identifier } from "@collab-editor/engine";
import { resolvePresenceAnchor } from "../sync/syncClient.js";
import { NoWriteAccessError } from "../sync/syncClient.js";
import { OfflineWindowExceededError } from "../sync/offlineWindow.js";
import {
  deleteRangeAt,
  liveSelectionRange,
  placeCaretAt,
  type InputPipelineDeps,
} from "./inputPipeline.js";

/** Test Plan IME-05's own literal number — a composition left open this long is force-committed. */
const DEFAULT_WATCHDOG_MS = 10_000;

export interface CompositionControllerDeps extends InputPipelineDeps {
  /** The mounted contenteditable root — needed for the full re-mount `commit()` performs (mirrors `EditorView.tsx`'s own remote-ops-applied handler). */
  readonly root: Element;
  /**
   * TEST-ONLY: overrides the production 10-second watchdog threshold. Omitted (every real
   * caller) means the real `DEFAULT_WATCHDOG_MS`. Exists for exactly the same reason
   * `DocumentCoordinator`'s own `snapshotThresholds` test-only constructor override does (Phase
   * 17) and Test Plan RC-27/34's own "accelerate what doesn't depend on real timing, document
   * why" precedent: IME-05 asks to prove the code force-commits after ITS configured threshold,
   * not to literally wait a real 10+ seconds in a jsdom unit test, and a real-browser Playwright
   * spec has no `vi.useFakeTimers()` equivalent to fall back on — a short injected real value
   * exercises the IDENTICAL code path (a plain `setTimeout`), only the constant differs. The
   * shipped default (exactly 10\_000ms) is itself verified with fake timers, boundary-exact, in
   * `compositionController.test.ts`.
   */
  readonly watchdogMs?: number;
}

/**
 * Owns the whole IME composition lifecycle for one editor root: `compositionstart`/
 * `compositionupdate`/`compositionend`, the 10-second stuck-composition watchdog, and the
 * remote-operation buffering gate `EditorView.tsx` consults from its own `onRemoteOpsApplied`
 * handler. Constructed once per `EditorView` mount, alongside `DomWriter`/`MutationSentinel`
 * (`attachCompositionHandlers` below wires it to real DOM events, mirroring
 * `attachInputPipeline`'s own shape).
 */
export class CompositionController {
  private readonly deps: CompositionControllerDeps;
  private readonly watchdogMs: number;

  private composing = false;
  private anchorId: Identifier | null = null;
  /** The most recent `compositionupdate`'s own `data` — used ONLY as the watchdog's "commit what exists" fallback text (Scope-IN's own `compositionupdate: deliberately empty` — this is bookkeeping for a force-commit path, not an engine/DOM mutation). */
  private lastData = "";
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  /** Scope-IN's `remoteBuffer`, made concrete as a count: how many remote-ops-applied batches arrived while composing, deferred rather than acted on. Reset at every `commit()` — see this file's own header comment for why nothing further needs to be replayed from it. */
  private remoteOpsBufferedCount = 0;

  constructor(deps: CompositionControllerDeps) {
    this.deps = deps;
    this.watchdogMs = deps.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  }

  /** Whether a composition is currently in progress — `EditorView.tsx` consults this indirectly via {@link noteRemoteOpsApplied}, not directly. */
  get isComposing(): boolean {
    return this.composing;
  }

  /** Diagnostic/test surface for Scope-IN's own `remoteBuffer` concept — see this file's own header comment for why the count alone is sufficient (nothing further needs to be replayed at flush time). */
  get bufferedRemoteOpsCount(): number {
    return this.remoteOpsBufferedCount;
  }

  /**
   * Called by `EditorView.tsx`'s own `onRemoteOpsApplied` handler, in place of that handler's
   * ordinary capture/mount/restore reaction. Returns `true` ("I've taken care of this, do
   * nothing further") while composing; `false` ("proceed as normal") otherwise.
   */
  noteRemoteOpsApplied(): boolean {
    if (!this.composing) {
      return false;
    }
    this.remoteOpsBufferedCount += 1;
    return true;
  }

  /**
   * `compositionstart` (Scope-IN: "capture anchor; emit selection deletion NOW if replacing
   * one"). A no-op if there is no engine yet (mirrors `handleBeforeInput`'s own "not synced yet"
   * guard) or if a composition is somehow already open (defensive — real browsers never fire two
   * `compositionstart`s back to back without an intervening `compositionend`).
   */
  handleCompositionStart(): void {
    const engine = this.deps.sync.engine;
    if (!engine || this.composing) {
      return;
    }
    this.composing = true;
    this.lastData = "";
    this.remoteOpsBufferedCount = 0;

    // IME-04: a live, non-collapsed selection is deleted NOW, as an ordinary operation, BEFORE
    // the IME takes the region — reusing the exact same range reader/deleter ordinary Backspace
    // uses (inputPipeline.ts), so this is indistinguishable from any other selection-replacing
    // edit on the wire.
    const range = liveSelectionRange(this.deps);
    if (range.end > range.start) {
      deleteRangeAt(this.deps, range.start, range.end - range.start);
    }

    // The STABLE anchor this composition will commit against — see this file's own header
    // comment for why an identifier, not a raw index, is required for IME-03's correctness.
    this.anchorId = resolvePresenceAnchor(engine, range.start);

    // The browser is about to start rendering its own native composition preview directly into
    // the DOM — MutationSentinel must not treat that as a foreign mutation and revert it.
    // Resumed in `commit()`, after this composition's own final, authoritative remount.
    this.deps.sentinel.stop();

    this.armWatchdog();
  }

  /**
   * `compositionupdate` (Scope-IN: "deliberately empty, with a comment saying so"). No engine
   * mutation, no DOM mutation — the browser renders its own native composition preview; nothing
   * here needs to touch `DomWriter` or `Engine` at all. The only thing recorded is `ev.data`,
   * purely as a fallback for the watchdog's own "commit what exists" behavior (IME-05) should
   * `compositionend` never arrive.
   */
  handleCompositionUpdate(ev: CompositionEvent): void {
    if (!this.composing) {
      return; // a stray event after the watchdog already force-committed, or before compositionstart
    }
    this.lastData = ev.data ?? "";
  }

  /** `compositionend` (Scope-IN: "emit committed text as ONE OP_INSERT_RUN, flush buffer"). A no-op if this composition was already force-ended by the watchdog (or a stray event with none ever open). */
  handleCompositionEnd(ev: CompositionEvent): void {
    if (!this.composing) {
      return;
    }
    this.commit(ev.data ?? this.lastData);
  }

  /**
   * Shared by both the real `compositionend` path and the watchdog's own force-commit path.
   * Mints the committed text as one `OP_INSERT_RUN` (`SyncClient.localInsertText` already
   * coalesces a multi-character insert into the fewest possible wire frames, Phase 12 — a run of
   * two or more characters becomes exactly one frame, Test Plan IME-01), then re-mounts the
   * WHOLE subtree from the engine's now-authoritative text.
   *
   * The re-mount (rather than an incremental `DomWriter.insertText`) is deliberate, not merely a
   * convenient reuse of existing machinery: the physical DOM at this moment holds the BROWSER'S
   * OWN native composition markup, which `DomWriter.index` was never incrementally updated to
   * track (nothing here ever called `domWriter.insertText`/`deleteRange` during composition) —
   * the same "the engine is authoritative, re-render from scratch rather than trying to patch an
   * untracked DOM shape" mechanism `MutationSentinel.reconcile()` and `EditorView.tsx`'s own
   * remote-ops-applied handler already use for the identical reason.
   */
  private commit(text: string): void {
    this.clearWatchdog();
    this.composing = false;
    const anchorId = this.anchorId;
    this.anchorId = null;
    this.remoteOpsBufferedCount = 0;

    const { domWriter, sync, sentinel, root } = this.deps;
    const engine = sync.engine;
    if (!engine) {
      sentinel.start();
      return;
    }

    const insertAt = engine.resolveCaret(anchorId);
    let insertedScalars = 0;
    if (text.length > 0) {
      try {
        sync.localInsertText(insertAt, text);
        insertedScalars = Array.from(text).length; // scalar count, not UTF-16 length — matches inputPipeline.ts's own convention
      } catch (err) {
        if (!(err instanceof OfflineWindowExceededError || err instanceof NoWriteAccessError)) {
          sentinel.start(); // never leave the sentinel permanently suspended on an unexpected throw
          throw err;
        }
        // Scope-IN mirrors `insertTextAt`'s own reasoning (inputPipeline.ts): the offline-window
        // cap or a revoked/downgraded role refuses the edit outright. The remount below still
        // runs, discarding the browser's own composition preview in favor of whatever the engine
        // ACTUALLY holds — the same "never mint-then-silently-drop" discipline as ordinary typing.
      }
    }

    sentinel.applyPatches(() => domWriter.mount(root, engine.text()));
    placeCaretAt(this.deps, insertAt + insertedScalars);
    sentinel.start();
  }

  /** IME-05 — a composition left open this long is force-ended, committing whatever text has been observed so far via `compositionupdate`, flushing the remote-op buffer (its own final remount reflects current engine state regardless), and logging (Scope-IN: "and logs"). */
  private armWatchdog(): void {
    this.watchdogTimer = setTimeout(() => {
      console.warn(
        `CompositionController: a composition was left open longer than ${this.watchdogMs}ms — force-committing whatever has been observed so far (Test Plan IME-05, API Spec §7.6).`,
      );
      this.commit(this.lastData);
    }, this.watchdogMs);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== undefined) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /** Called from `EditorView.tsx`'s own cleanup — clears any still-armed watchdog so it can never fire against an unmounted editor. */
  dispose(): void {
    this.clearWatchdog();
  }
}

/** Attaches {@link CompositionController}'s three composition-event handlers to `root`. Returns a detach function, mirroring {@link attachInputPipeline}'s own shape (`inputPipeline.ts`). */
export function attachCompositionHandlers(
  root: Element,
  controller: CompositionController,
): () => void {
  const onStart = (): void => controller.handleCompositionStart();
  const onUpdate = (ev: Event): void => controller.handleCompositionUpdate(ev as CompositionEvent);
  const onEnd = (ev: Event): void => controller.handleCompositionEnd(ev as CompositionEvent);
  root.addEventListener("compositionstart", onStart);
  root.addEventListener("compositionupdate", onUpdate);
  root.addEventListener("compositionend", onEnd);
  return () => {
    root.removeEventListener("compositionstart", onStart);
    root.removeEventListener("compositionupdate", onUpdate);
    root.removeEventListener("compositionend", onEnd);
  };
}
