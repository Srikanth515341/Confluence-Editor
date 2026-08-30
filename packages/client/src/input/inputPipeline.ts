// The input pipeline (Phase 12, API Spec §7.4 / §7.4.2's inputType dispatch
// table, §7.4.3 grapheme boundaries, §7.4.4 bind flag). Captures every
// `beforeinput` event on the editor root and translates it into engine
// operations — the browser is NEVER allowed to mutate the editable subtree
// itself; `DomWriter` (Phase 11) remains the sole mutator.

import {
  domToVis,
  scalarToUtf16,
  utf16ToScalar,
  visToDom,
  type DomWriter,
} from "../binding/index.js";
import type { SyncClient } from "../sync/syncClient.js";
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
 * Reads `event.getTargetRanges()` (Input Events Level 2) and maps its
 * first range into visible (scalar) indices via {@link domToVis} — the
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
  const a = domToVis(deps.domWriter.index, first.startContainer, first.startOffset);
  const b = domToVis(deps.domWriter.index, first.endContainer, first.endOffset);
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** Reads the LIVE `window.getSelection()` range, mapped to visible indices. Collapsed (`start === end`) at position 0 if there is no selection at all. */
function liveSelectionRange(deps: InputPipelineDeps): VisRange {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return { start: 0, end: 0 };
  }
  const range = sel.getRangeAt(0);
  const a = domToVis(deps.domWriter.index, range.startContainer, range.startOffset);
  const b = domToVis(deps.domWriter.index, range.endContainer, range.endOffset);
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
  deps.sync.localInsertText(at, text);
  deps.sentinel.applyPatches(() => {
    deps.domWriter.insertText(at, text, deps.sync.engine?.text());
  });
  placeCaretAt(deps, at + Array.from(text).length); // Array.from: scalar count, not UTF-16 length
}

function deleteRangeAt(deps: InputPipelineDeps, at: number, count: number): void {
  if (count <= 0) {
    return;
  }
  deps.sync.localDelete(at, count);
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
    return; // not synced yet — nothing to apply against (no offline edit queue this phase)
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
