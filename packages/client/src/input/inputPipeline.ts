// The input pipeline (Phase 12, API Spec §7.4 / §7.4.2's inputType dispatch
// table, §7.4.3 grapheme boundaries, §7.4.4 bind flag). Captures every
// `beforeinput` event on the editor root and translates it into engine
// operations — the browser is NEVER allowed to mutate the editable subtree
// itself; `DomWriter` (Phase 11) remains the sole mutator.

import {
  domToVis,
  scalarToUtf16,
  totalVisibleLength,
  utf16ToScalar,
  visToDom,
  type DomWriter,
} from "../binding/index.js";
import type { SyncClient } from "../sync/syncClient.js";
import { OfflineWindowExceededError } from "../sync/offlineWindow.js";
import type { MutationSentinel } from "../sentinel/index.js";
import {
  clusterAfter,
  clusterBefore,
  lineStartBefore,
  wordAfter,
  wordBefore,
} from "./graphemeSegmentation.js";

/**
 * Everything one `beforeinput` handler call needs — no hidden global state.
 * `sentinel` is REQUIRED, not optional: every `DomWriter` write below runs
 * through `sentinel.applyPatches()` (Phase 13, API Spec §7.7.1) rather than
 * calling `domWriter.insertText`/`deleteRange` bare, so a caller can never
 * accidentally reintroduce a DOM mutation the sentinel doesn't know about.
 */
export interface InputPipelineDeps {
  readonly domWriter: DomWriter;
  readonly sync: SyncClient;
  readonly sentinel: MutationSentinel;
}

interface VisRange {
  readonly start: number;
  readonly end: number;
}

/**
 * `domToVis` throws if `node` doesn't belong to any run in `index` — which
 * can legitimately happen now (Phase 14): a REMOTE operation can trigger a
 * full re-mount (EditorView's `onRemoteOpsApplied`) asynchronously, between
 * the moment a `beforeinput` event is dispatched and the moment this
 * handler actually reads the live `Selection`, leaving that Selection
 * anchored to a Text node `mount()` already replaced. Falling back to the
 * end of the CURRENT document — rather than letting the exception escape
 * and silently drop the keystroke entirely — is what actually matters here:
 * losing a user's local edit to an unlucky race is a correctness bug (data
 * loss), whereas landing it at the wrong position under that same rare
 * race is merely a UX rough edge, in the same spirit as Phase 12's
 * `captureCaret` fallback and squarely inside "cursor precision under
 * concurrent remote edits is Phase 32's job, not this one's."
 */
function safeDomToVis(index: DomWriter["index"], node: Node, offset: number): number {
  try {
    return domToVis(index, node, offset);
  } catch {
    return totalVisibleLength(index);
  }
}

/**
 * Reads `event.getTargetRanges()` (Input Events Level 2) and maps its
 * first range into visible (scalar) indices via {@link safeDomToVis} — the
 * browser's own notion of what a `beforeinput` event would have modified,
 * available for autocorrect/spellcheck replacement and IME commits where
 * it can differ from the CURRENT selection. `null` when unsupported or
 * empty, so callers fall back to reading the live selection instead.
 */
function targetRange(ev: InputEvent, deps: InputPipelineDeps): VisRange | null {
  const getRanges = (ev as { getTargetRanges?: () => readonly StaticRange[] }).getTargetRanges;
  const ranges = typeof getRanges === "function" ? getRanges.call(ev) : [];
  const first = ranges && ranges.length > 0 ? ranges[0] : undefined;
  if (!first) {
    return null;
  }
  const a = safeDomToVis(deps.domWriter.index, first.startContainer, first.startOffset);
  const b = safeDomToVis(deps.domWriter.index, first.endContainer, first.endOffset);
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** Reads the LIVE `window.getSelection()` range, mapped to visible indices. Collapsed (`start === end`) at position 0 if there is no selection at all. */
function liveSelectionRange(deps: InputPipelineDeps): VisRange {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return { start: 0, end: 0 };
  }
  const range = sel.getRangeAt(0);
  const a = safeDomToVis(deps.domWriter.index, range.startContainer, range.startOffset);
  const b = safeDomToVis(deps.domWriter.index, range.endContainer, range.endOffset);
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

function resolvedRange(ev: InputEvent, deps: InputPipelineDeps): VisRange {
  return targetRange(ev, deps) ?? liveSelectionRange(deps);
}

function textForInputType(ev: InputEvent): string {
  switch (ev.inputType) {
    case "insertLineBreak":
    case "insertParagraph":
      return "\n";
    case "insertFromPaste":
    case "insertFromDrop":
      return ev.dataTransfer?.getData("text/plain") ?? "";
    default:
      return ev.data ?? "";
  }
}

/**
 * Moves the LIVE browser caret to visible (scalar) index `visIndex`. Required after every
 * mutation: since `beforeinput` is always prevented (Scope-IN), the browser never advances its
 * own Selection the way it would after a native edit — without this, every subsequent keystroke
 * would keep reporting the SAME stale caret position, corrupting typing order entirely (caught by
 * this phase's own e2e suite: typing "hello" landed as "olleh" — every character re-inserted at
 * the position the caret was left at by the PREVIOUS insert, i.e. the very start, before this fix).
 */
function placeCaretAt(deps: InputPipelineDeps, visIndex: number): void {
  const root = deps.domWriter.rootElement;
  const sel = window.getSelection();
  if (!root || !sel) {
    return;
  }
  const pos = visToDom(deps.domWriter.index, root, visIndex);
  const range = document.createRange();
  range.setStart(pos.node, pos.offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function insertTextAt(deps: InputPipelineDeps, at: number, text: string): void {
  if (text.length === 0) {
    return;
  }
  try {
    deps.sync.localInsertText(at, text);
  } catch (err) {
    if (err instanceof OfflineWindowExceededError) {
      // Scope-IN (Phase 24): "stops accepting new edits" — the keystroke is dropped from the
      // DOM's own perspective too (never mutated, same as this pipeline's pre-existing "no
      // engine yet" no-op just above `handleBeforeInput`'s own dispatch table). Surfacing this
      // to the USER is the reactive `SyncClient.offlineWindowStatus`/`rejectedCount` layer's
      // job, not a per-keystroke exception out of a DOM event handler.
      return;
    }
    throw err;
  }
  deps.sentinel.applyPatches(() => {
    deps.domWriter.insertText(at, text, deps.sync.engine?.text());
  });
  placeCaretAt(deps, at + Array.from(text).length); // Array.from: scalar count, not UTF-16 length
}

function deleteRangeAt(deps: InputPipelineDeps, at: number, count: number): void {
  if (count <= 0) {
    return;
  }
  try {
    deps.sync.localDelete(at, count);
  } catch (err) {
    if (err instanceof OfflineWindowExceededError) {
      return; // see insertTextAt's own comment for the full reasoning
    }
    throw err;
  }
  deps.sentinel.applyPatches(() => {
    deps.domWriter.deleteRange(at, count, deps.sync.engine?.text());
  });
  placeCaretAt(deps, at);
}

/** `insertText`/`insertReplacementText`/`insertFromPaste`/`insertFromDrop`/`insertLineBreak`/`insertParagraph` (API Spec §7.4.2) all reduce to: resolve the range that would be replaced (possibly empty), delete it, then insert the type's own text at its start. */
function replaceRangeThenInsert(ev: InputEvent, deps: InputPipelineDeps): void {
  const range = resolvedRange(ev, deps);
  const text = textForInputType(ev);
  if (range.end > range.start) {
    deleteRangeAt(deps, range.start, range.end - range.start);
  }
  insertTextAt(deps, range.start, text);
}

/** `deleteByDrag`/`deleteByCut` — delete the resolved range outright, no insert. */
function deleteResolvedRange(ev: InputEvent, deps: InputPipelineDeps): void {
  const range = resolvedRange(ev, deps);
  if (range.end > range.start) {
    deleteRangeAt(deps, range.start, range.end - range.start);
  }
}

/**
 * `deleteContentBackward`/`deleteContentForward` (API Spec §7.4.2, §7.4.3).
 * Deliberately reads the LIVE SELECTION ONLY — never `event.getTargetRanges()`
 * — for the collapsed-caret case: Scope-IN obligation 1 requires grapheme
 * boundaries to be resolved via `Intl.Segmenter`, not via whichever cluster
 * boundary a given browser's own (font/text-shaping-dependent) targetRange
 * happens to report. This distinction is load-bearing, not stylistic — real
 * Firefox, tested against a genuine family-ZWJ-emoji Backspace keystroke in
 * this phase's own e2e suite, reported a native targetRange that erased
 * only the trailing ZWJ+code-point pair rather than the whole 7-scalar
 * cluster (a headless-environment color-emoji-font/shaping artifact, not a
 * spec-mandated behavior) — trusting it directly would have made GRA-02
 * pass or fail depending on the host's installed fonts. If the live
 * selection is an actual non-collapsed range, delete exactly that (a
 * user-made selection is not grapheme-bound); otherwise resolve the FULL
 * grapheme cluster adjacent to the caret ourselves.
 */
function deleteContentCluster(deps: InputPipelineDeps, direction: "backward" | "forward"): void {
  const range = liveSelectionRange(deps);
  if (range.end > range.start) {
    deleteRangeAt(deps, range.start, range.end - range.start);
    return;
  }
  const text = deps.domWriter.materializedText();
  const caretUtf16 = scalarToUtf16(text, range.start);
  const span =
    direction === "backward" ? clusterBefore(text, caretUtf16) : clusterAfter(text, caretUtf16);
  if (!span) {
    return;
  }
  const startScalar = utf16ToScalar(text, span.utf16Start);
  const endScalar = utf16ToScalar(text, span.utf16End);
  deleteRangeAt(deps, startScalar, endScalar - startScalar);
}

/** `deleteWordBackward`/`deleteWordForward` (API Spec §7.4.2: "use Intl.Segmenter('word'), not a regex"). Same non-collapsed-selection short-circuit as {@link deleteContentCluster}. */
function deleteWord(
  ev: InputEvent,
  deps: InputPipelineDeps,
  direction: "backward" | "forward",
): void {
  const range = resolvedRange(ev, deps);
  if (range.end > range.start) {
    deleteRangeAt(deps, range.start, range.end - range.start);
    return;
  }
  const text = deps.domWriter.materializedText();
  const caretUtf16 = scalarToUtf16(text, range.start);
  const span =
    direction === "backward" ? wordBefore(text, caretUtf16) : wordAfter(text, caretUtf16);
  if (!span) {
    return;
  }
  const startScalar = utf16ToScalar(text, span.utf16Start);
  const endScalar = utf16ToScalar(text, span.utf16End);
  deleteRangeAt(deps, startScalar, endScalar - startScalar);
}

/** `deleteSoftLineBackward`/`deleteHardLineBackward` (API Spec §7.4.2) — see {@link lineStartBefore}'s doc comment for why both map to the same behavior in this phase. */
function deleteLineBackward(ev: InputEvent, deps: InputPipelineDeps): void {
  const range = resolvedRange(ev, deps);
  if (range.end > range.start) {
    deleteRangeAt(deps, range.start, range.end - range.start);
    return;
  }
  const text = deps.domWriter.materializedText();
  const caretUtf16 = scalarToUtf16(text, range.start);
  const lineStartUtf16 = lineStartBefore(text, caretUtf16);
  const startScalar = utf16ToScalar(text, lineStartUtf16);
  deleteRangeAt(deps, startScalar, range.start - startScalar);
}

/**
 * The full API Spec §7.4.2 dispatch table. Called from a `beforeinput`
 * listener — `event.preventDefault()` happens FIRST, unconditionally, for
 * every event this function sees (Scope-IN: "without exception"), before
 * any dispatch logic runs, so a throw further down can never leave the
 * browser free to mutate the DOM itself.
 */
export function handleBeforeInput(ev: InputEvent, deps: InputPipelineDeps): void {
  ev.preventDefault();

  if (!deps.sync.engine) {
    // Not synced yet — no engine exists at all (before the very first SNAPSHOT). This is the
    // ONE case Phase 22 still blocks: there is nothing to mint an operation against yet.
    //
    // Phase 14 originally ALSO blocked here whenever `state.value !== "synced"` (i.e. also
    // during `reconnecting`/`offline`), specifically because a local edit minted against an
    // engine reference a fresh SNAPSHOT was about to replace wholesale would be silently
    // orphaned (a real, confirmed bug — see SyncClient.requireEngine's prior doc comment history
    // for the full account). Phase 22 removes that extra check deliberately: `SyncClient` now
    // durably queues an edit minted during `reconnecting`/`offline` (API Spec §7.9) and
    // reconciles it against the NEXT fresh SNAPSHOT's engine (reconcileOfflineQueue.ts) — the
    // orphaning failure mode this check existed to prevent no longer exists, so blocking real
    // user typing during a reconnect is no longer necessary and would defeat PRD FR-OF-2's whole
    // point (offline edits must actually be capturable, not merely durable once captured).
    return;
  }

  switch (ev.inputType) {
    case "insertText":
    case "insertReplacementText":
    case "insertFromPaste":
    case "insertFromDrop":
    case "insertLineBreak":
    case "insertParagraph":
      replaceRangeThenInsert(ev, deps);
      break;
    case "deleteByDrag":
    case "deleteByCut":
      deleteResolvedRange(ev, deps);
      break;
    case "deleteContentBackward":
      deleteContentCluster(deps, "backward");
      break;
    case "deleteContentForward":
      deleteContentCluster(deps, "forward");
      break;
    case "deleteWordBackward":
      deleteWord(ev, deps, "backward");
      break;
    case "deleteWordForward":
      deleteWord(ev, deps, "forward");
      break;
    case "deleteSoftLineBackward":
    case "deleteHardLineBackward":
      deleteLineBackward(ev, deps);
      break;
    case "insertCompositionText":
    case "deleteCompositionText":
      break; // never emits an operation (API Spec §7.4.2) — IME composition is Phase 13's sentinel
    case "historyUndo":
    case "historyRedo":
      // TODO(Phase 36): engine.undo()/engine.redo() (Engine Spec §9). Stubbed per API Spec
      // §7.4.2 — this phase only prevents the browser's own undo/redo from touching the DOM.
      break;
    default:
      console.warn(`inputPipeline: unhandled inputType "${ev.inputType}" — ignored`);
      break;
  }
}

/** Attaches {@link handleBeforeInput} to `root`'s `beforeinput` event. Returns a detach function. */
export function attachInputPipeline(root: Element, deps: InputPipelineDeps): () => void {
  const listener = (ev: Event) => handleBeforeInput(ev as InputEvent, deps);
  root.addEventListener("beforeinput", listener);
  return () => root.removeEventListener("beforeinput", listener);
}
