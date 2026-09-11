// Phase 32 (API Spec §7.5/§11.7, Engine Spec §11.3, Test Plan CUR-01..05, blocker B19) — keeps a
// caret/selection anchored to the CHARACTERS a user placed it on, not to a numeric position, when
// a remote edit shifts or removes content around it. Replaces EditorView.tsx's pre-Phase-32
// numeric-visible-index capture/restore (captureCaretVisIndex/restoreCaretVisIndex) — see that
// file's own header comment, retained there as history, for exactly why the numeric approach was
// only ever a "minimum viable" stand-in for this phase's real mechanism.
//
// Anchor and focus are captured and restored INDEPENDENTLY (Scope-IN's own explicit requirement,
// Test Plan CUR-03) -- a selection is two separate caret positions, not one position plus a
// length, and a joint/derived delta would either collapse or displace the selection when a remote
// edit lands INSIDE it. Each of `anchor`/`focus` is resolved to a stable node identifier using the
// SAME "identifier of the node immediately LEFT of a visible position" convention
// `resolvePresenceAnchor` (SyncClient, Phase 31) already established for the wire, and resolved
// BACK to a live visible index via `Engine.resolveCaret` (Phase 32) -- the two are exact inverses
// of each other by construction.
//
// PERFORMANCE NOTE, added after a code-review question surfaced a real, measured cost (see
// `packages/testkit/src/benchmark/caretResolution.ts` for the full numbers): `resolvePresenceAnchor`
// itself calls `Engine.visible()` -- a FULL in-order traversal (`FugueTree.toArray()`), O(N) in the
// document's total node count, unrelated to `resolveCaret`'s own much cheaper O(depth) walk.
// Calling it independently for anchor AND focus (the obvious, naive way to reuse that function
// here) would pay that O(N) traversal TWICE per capture, on EVERY remote-ops-applied batch, with
// no rate limit the way Phase 31's own 20/s presence-sending path has -- measured at ~3.2ms per
// traversal at a 20,000-character sequentially-typed document, this would have added ~6.5ms of
// pure caret-tracking overhead to every remote batch at that size, ON TOP OF the pre-existing,
// already-O(N) DOM remount cost (Phase 14), and compounding with the disclosed Fugue O(N)
// sequential-typing depth cost (CLAUDE.md's Open Item 3) as documents grow. `captureCaret` below
// instead calls `engine.visible()` exactly ONCE per capture and resolves both anchor and focus
// against that SAME snapshot -- halving this specific cost without changing the result (`engine.
// visible()` is a pure read; two independent calls would have returned equivalent arrays anyway).
// This does NOT eliminate the O(N) cost -- see CLAUDE.md's tracked open item for the honest
// remaining picture and why a further fix (an incremental/cached visible-sequence view) is
// deliberately left as future work, not attempted under this fix's own narrow scope.

import type { Engine, Identifier } from "@collab-editor/engine";
import { domToVis, totalVisibleLength, visToDom, type RenderRun } from "../binding/index.js";

/** A captured selection, as two independently-resolved node-identifier anchors. `null` means "document start" (nothing to the left), the same convention `InsertOperation.parent`/presence anchors already use. */
export interface CaretSnapshot {
  readonly anchor: Identifier | null;
  readonly focus: Identifier | null;
}

/**
 * Captures the CURRENT browser selection as a pair of stable node-identifier anchors, resolved
 * against `engine`'s CURRENT structure. Must be called BEFORE any DOM mutation (Scope-IN's own
 * "capture() before any DOM mutation") -- once `domWriter.mount()` has rebuilt the subtree, the
 * live `Selection`'s own node/offset no longer describes a meaningful position to resolve.
 *
 * Deliberately reads `sel.anchorNode`/`anchorOffset`/`focusNode`/`focusOffset` -- the Selection
 * API's own true anchor/focus pair (direction-aware: for a BACKWARDS selection, `anchorNode` is
 * the LATER document position) -- not `Range.startContainer`/`endContainer`, which the DOM always
 * normalizes to document order regardless of selection direction and would silently discard which
 * end the user actually dragged from.
 *
 * Returns `null` if there is no live selection to capture (nothing to restore later either).
 */
export function captureCaret(index: readonly RenderRun[], engine: Engine): CaretSnapshot | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) {
    return null;
  }
  let anchorVis: number;
  let focusVis: number;
  try {
    anchorVis = domToVis(index, sel.anchorNode, sel.anchorOffset);
    focusVis = domToVis(index, sel.focusNode, sel.focusOffset);
  } catch {
    // The live selection sits somewhere `domToVis` can't map (e.g. outside the editor root
    // entirely) -- nothing meaningful to capture, same as no selection at all.
    return null;
  }
  // ONE traversal, shared by both lookups -- see this file's own header PERFORMANCE NOTE for why
  // this matters and what it costs if done naively (two independent calls).
  const visible = engine.visible();
  const resolve = (visibleIndex: number): Identifier | null =>
    visibleIndex <= 0 ? null : (visible[visibleIndex - 1]?.id ?? null);
  return {
    anchor: resolve(anchorVis),
    focus: resolve(focusVis),
  };
}

/**
 * Restores a previously-captured selection AFTER a DOM mutation (Scope-IN's own "restore() after
 * all of them") by resolving each of `snapshot`'s two identifiers back to a CURRENT visible index
 * via `engine.resolveCaret` -- independently, per CUR-03 -- then mapping each back to a concrete
 * DOM position via `visToDom` against the FRESH `index` the mutation just produced.
 *
 * Uses `Selection.setBaseAndExtent` (not a `Range` + `addRange`) specifically because a `Range`
 * always normalizes to `start <= end` in document order, silently collapsing a backwards
 * selection's own direction the instant it's re-applied -- `setBaseAndExtent` is the one Selection
 * API that lets anchor/focus be set independently, in either order, exactly mirroring how they
 * were captured.
 */
export function restoreCaret(
  snapshot: CaretSnapshot,
  root: Element,
  index: readonly RenderRun[],
  engine: Engine,
): void {
  const sel = window.getSelection();
  if (!sel) {
    return;
  }
  const total = totalVisibleLength(index);
  const anchorVis = Math.max(0, Math.min(engine.resolveCaret(snapshot.anchor), total));
  const focusVis = Math.max(0, Math.min(engine.resolveCaret(snapshot.focus), total));
  const anchorPos = visToDom(index, root, anchorVis);
  const focusPos = visToDom(index, root, focusVis);
  sel.setBaseAndExtent(anchorPos.node, anchorPos.offset, focusPos.node, focusPos.offset);
}
