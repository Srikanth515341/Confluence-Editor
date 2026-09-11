// @vitest-environment jsdom
//
// Test Plan CUR-01..05, blocker B19 (API Spec §7.5/§11.7, Engine Spec §11.3, Phase 32). Exercises
// `captureCaret`/`restoreCaret` against a REAL `Engine` and a REAL `DomWriter`-rendered jsdom
// subtree, with remote edits applied directly via `Engine.localInsert`/`localDelete` -- no
// `SyncClient`/network needed, since caret tracking is a pure function of (selection, render
// index, engine), the same layering discipline Phase 11's own `domEngineConsistency.test.ts`
// established (real Engine + real DOM position mapping, no React, no wire protocol).
//
// CUR-04's own "identical on a THIRD replica" requirement is proven exhaustively at the engine
// level, independent of any DOM at all, in `packages/engine/src/engine.test.ts`'s own dedicated
// CUR-04 test (three independently-converged `Engine`s, three delivery orders, both a live and a
// tombstoned anchor) -- not re-derived here, since `resolveCaret`'s determinism is a property of
// the engine alone and doesn't depend on which DOM happens to be observing it. This file instead
// covers the DOM-facing half of CUR-04: that a LOCAL caret correctly re-resolves to the nearest
// surviving character after its own anchor is deleted.
//
// CUR-05's own literal "60s at 10Hz, 600 samples" is NOT waited out in real wall-clock time --
// nothing in this mechanism's own correctness depends on REAL elapsed time (capture/restore is a
// pure per-mutation-batch operation, not a timer), so this test instead runs 600 DETERMINISTIC
// capture/mutate/remount/restore cycles back to back and asserts zero anchor drift across all of
// them -- the same "accelerate what doesn't depend on real timing, document why" precedent this
// project established for RC-34 (Phase 23) and DUR-05/06's own fuzz-based fault injection
// (Phase 25).

import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@collab-editor/engine";
import { DomWriter, domToVis, visToDom } from "../binding/index.js";
import { captureCaret, restoreCaret } from "./caretTracker.js";

beforeEach(() => {
  document.body.replaceChildren();
});

function setup(text: string): { root: HTMLDivElement; domWriter: DomWriter; engine: Engine } {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const domWriter = new DomWriter();
  const engine = new Engine(1);
  for (const ch of text) {
    engine.localInsert(engine.stats().visibleLength, ch.codePointAt(0)!);
  }
  domWriter.mount(root, engine.text());
  return { root, domWriter, engine };
}

/** Places a real, collapsed jsdom Selection at visible index `v`. */
function placeCaret(domWriter: DomWriter, root: Element, v: number): void {
  const pos = visToDom(domWriter.index, root, v);
  const sel = window.getSelection()!;
  const range = document.createRange();
  range.setStart(pos.node, pos.offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Places a real jsdom Selection spanning visible indices `anchorV` -> `focusV` -- backwards if `focusV < anchorV`. */
function placeSelection(domWriter: DomWriter, root: Element, anchorV: number, focusV: number): void {
  const anchorPos = visToDom(domWriter.index, root, anchorV);
  const focusPos = visToDom(domWriter.index, root, focusV);
  window.getSelection()!.setBaseAndExtent(anchorPos.node, anchorPos.offset, focusPos.node, focusPos.offset);
}

function currentCollapsedVis(domWriter: DomWriter): number {
  const range = window.getSelection()!.getRangeAt(0);
  return domToVis(domWriter.index, range.startContainer, range.startOffset);
}

function currentAnchorFocusVis(domWriter: DomWriter): { anchor: number; focus: number } {
  const sel = window.getSelection()!;
  return {
    anchor: domToVis(domWriter.index, sel.anchorNode!, sel.anchorOffset),
    focus: domToVis(domWriter.index, sel.focusNode!, sel.focusOffset),
  };
}

describe("CaretTracker — CUR-01: caret stays anchored through a remote INSERT before it", () => {
  it("a caret placed after character 100 of a 500-char document stays on the SAME character after 50 remote inserts before it", () => {
    const { root, domWriter, engine } = setup("x".repeat(500));
    placeCaret(domWriter, root, 100); // immediately after the 100th character

    const snapshot = captureCaret(domWriter.index, engine)!;
    expect(snapshot).not.toBeNull();
    expect(snapshot.anchor).toEqual(engine.visible()[99]!.id); // the 100th character's own id

    for (let i = 0; i < 50; i++) {
      engine.localInsert(20 + i, "y".codePointAt(0)!); // 50 inserts at position 20 -- before the caret
    }
    domWriter.mount(root, engine.text());
    restoreCaret(snapshot, root, domWriter.index, engine);

    const newVis = currentCollapsedVis(domWriter);
    expect(newVis).toBe(150); // shifted by exactly the 50 new characters
    expect(engine.resolveCaret(snapshot.anchor)).toBe(150); // resolved via the SAME anchor, not a recomputed offset

    engine.localInsert(newVis, "!".codePointAt(0)!); // the next keystroke lands immediately after that same character
    expect(engine.text()[150]).toBe("!");
  });
});

describe("CaretTracker — CUR-02: caret stays anchored through a remote DELETE before it", () => {
  it("a caret placed after character 100 stays on the SAME character after 50 remote deletes before it", () => {
    const { root, domWriter, engine } = setup("x".repeat(500));
    placeCaret(domWriter, root, 100);
    const snapshot = captureCaret(domWriter.index, engine)!;
    const anchorId = snapshot.anchor!;

    engine.localDelete(20, 50); // deletes characters [20, 70)
    domWriter.mount(root, engine.text());
    restoreCaret(snapshot, root, domWriter.index, engine);

    expect(currentCollapsedVis(domWriter)).toBe(50); // 100 minus the 50 deleted before it
    expect(engine.resolveCaret(anchorId)).toBe(50);
  });
});

describe("CaretTracker — CUR-03: a selection extends correctly when a peer inserts INSIDE it, anchor and focus resolved independently", () => {
  it("selecting [100, 200) then a peer inserting 30 chars at 150 grows the selection to [100, 230)", () => {
    const { root, domWriter, engine } = setup("x".repeat(500));
    placeSelection(domWriter, root, 100, 200);
    const snapshot = captureCaret(domWriter.index, engine)!;
    expect(snapshot.anchor).toEqual(engine.visible()[99]!.id);
    expect(snapshot.focus).toEqual(engine.visible()[199]!.id);

    for (let i = 0; i < 30; i++) {
      engine.localInsert(150 + i, "y".codePointAt(0)!); // INSIDE the selection
    }
    domWriter.mount(root, engine.text());
    restoreCaret(snapshot, root, domWriter.index, engine);

    const { anchor, focus } = currentAnchorFocusVis(domWriter);
    expect(anchor).toBe(100); // unaffected -- before the insert
    expect(focus).toBe(230); // shifted by the 30 new characters
  });

  it("a BACKWARDS selection (focus before anchor) preserves its own direction through a remote edit", () => {
    const { root, domWriter, engine } = setup("x".repeat(50));
    placeSelection(domWriter, root, 30, 10); // dragged from 30 back to 10 -- anchor > focus
    const snapshot = captureCaret(domWriter.index, engine)!;
    expect(snapshot.anchor).toEqual(engine.visible()[29]!.id);
    expect(snapshot.focus).toEqual(engine.visible()[9]!.id);

    engine.localInsert(0, "z".codePointAt(0)!); // one new leading character
    domWriter.mount(root, engine.text());
    restoreCaret(snapshot, root, domWriter.index, engine);

    const { anchor, focus } = currentAnchorFocusVis(domWriter);
    expect(anchor).toBe(31);
    expect(focus).toBe(11);
  });
});

describe("CaretTracker — CUR-04 (DOM-facing half): a caret whose anchor is DELETED resolves to the nearest surviving character to the left", () => {
  it("resolves to immediately after character 94 when characters 95-105 (including the anchor) are deleted -- never to document start or end", () => {
    const { root, domWriter, engine } = setup("x".repeat(200));
    placeCaret(domWriter, root, 100); // anchor: the 100th character (visible index 99)
    const snapshot = captureCaret(domWriter.index, engine)!;
    const anchorId = snapshot.anchor!;

    engine.localDelete(95, 10); // deletes characters [95, 105) -- the anchor is inside this range
    domWriter.mount(root, engine.text());
    restoreCaret(snapshot, root, domWriter.index, engine);

    // Immediately after character 94 (0-indexed 94 -> visible index 95) -- NOT 0, NOT the new end.
    expect(currentCollapsedVis(domWriter)).toBe(95);
    expect(engine.resolveCaret(anchorId)).toBe(95);
  });
});

describe("CaretTracker — capture()/restore() round trip, no mutation in between", () => {
  it("restoring immediately after capturing (nothing changed) lands on the exact same visible index", () => {
    const { root, domWriter, engine } = setup("hello world");
    placeCaret(domWriter, root, 5);
    const snapshot = captureCaret(domWriter.index, engine)!;
    domWriter.mount(root, engine.text()); // no structural change, just a remount
    restoreCaret(snapshot, root, domWriter.index, engine);
    expect(currentCollapsedVis(domWriter)).toBe(5);
  });

  it("returns null when there is no live selection to capture", () => {
    const { domWriter, engine } = setup("hello");
    window.getSelection()!.removeAllRanges();
    expect(captureCaret(domWriter.index, engine)).toBeNull();
  });
});

describe("CaretTracker — CUR-05 shape: zero anchor drift across 600 capture/restore cycles under concurrent surrounding edits", () => {
  it("a fixed anchor character's resolved identifier never changes across 600 remote-edit-and-remount cycles when the anchor itself is never touched", () => {
    const { root, domWriter, engine } = setup("x".repeat(300));
    placeCaret(domWriter, root, 150); // A's own caret, roughly in the middle
    const originalAnchorId = captureCaret(domWriter.index, engine)!.anchor;
    expect(originalAnchorId).not.toBeNull();

    let seedState = 7;
    function rand(): number {
      seedState = (seedState + 0x6d2b79f5) | 0;
      let t = seedState;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    const anchorIdSeenAcrossSamples: string[] = [];
    for (let sample = 0; sample < 600; sample++) {
      // capture() BEFORE this tick's mutation -- reads the DOM position `restore()` left it at
      // last tick (or the initial placement, on the very first tick).
      const snapshot = captureCaret(domWriter.index, engine)!;
      anchorIdSeenAcrossSamples.push(JSON.stringify(snapshot.anchor));

      // Three "peers" edit continuously above and below A's own position. Insert is always safe
      // (it never mutates an existing character's identity); a delete is steered away from the
      // anchor's own visible index specifically so its CHARACTER is never the one removed -- the
      // whole point of CUR-05 is that the SAME character survives untouched for the full run.
      const anchorVis = engine.resolveCaret(originalAnchorId);
      const len = engine.stats().visibleLength;
      const ch = 97 + Math.floor(rand() * 26);
      if (len === 0 || rand() < 0.6) {
        engine.localInsert(Math.floor(rand() * (len + 1)), ch);
      } else {
        let pos = Math.floor(rand() * len);
        if (pos === anchorVis - 1) {
          pos = (pos + 1) % len;
        }
        engine.localDelete(pos, 1);
      }

      domWriter.mount(root, engine.text());
      restoreCaret(snapshot, root, domWriter.index, engine);
    }

    // Every one of the 600 samples captured the SAME anchor identifier -- zero anchor changes,
    // CUR-05's own literal assertion (10Hz/60s in the reference scenario; here, 600 deterministic
    // ticks instead of real time -- see this file's own header comment for why).
    const distinct = new Set(anchorIdSeenAcrossSamples);
    expect(distinct.size).toBe(1);
    expect(JSON.parse([...distinct][0]!)).toEqual(originalAnchorId);
    // And the anchor still resolves to a live, in-range position at the very end.
    const finalVis = engine.resolveCaret(originalAnchorId);
    expect(finalVis).toBeGreaterThanOrEqual(0);
    expect(finalVis).toBeLessThanOrEqual(engine.stats().visibleLength);
  });

  it("when one of the peers DOES delete the exact anchor character partway through the 600-sample run, the tracker re-anchors EXACTLY ONCE, then holds stable for the remainder", () => {
    // The test above deliberately steers every edit away from the anchor's own position, which
    // proves zero SPURIOUS drift but never actually exercises the harder case CUR-05's own
    // reference text implies is possible over 60s of real concurrent editing "above and below" a
    // fixed point: one of the peers eventually deletes the exact character the caret is anchored
    // to. CUR-04 already proves the underlying resolveCaret contract handles this correctly IN
    // ISOLATION (a single delete, immediately checked) -- this test instead exercises the SAME
    // event INSIDE the sustained-load harness, at an arbitrary point mid-run, and additionally
    // proves the property CUR-04 alone can't: that after the one legitimate re-anchor, tracking
    // stays stable again for the rest of the run, rather than continuing to drift.
    const { root, domWriter, engine } = setup("x".repeat(300));
    placeCaret(domWriter, root, 150);
    const originalAnchorId = captureCaret(domWriter.index, engine)!.anchor;
    expect(originalAnchorId).not.toBeNull();

    let seedState = 13;
    function rand(): number {
      seedState = (seedState + 0x6d2b79f5) | 0;
      let t = seedState;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    const KILL_TICK = 300; // roughly the midpoint of the run
    const anchorIdSeenAcrossSamples: string[] = [];
    for (let sample = 0; sample < 600; sample++) {
      const snapshot = captureCaret(domWriter.index, engine)!;
      anchorIdSeenAcrossSamples.push(JSON.stringify(snapshot.anchor));

      // Track the CURRENTLY live anchor (not the original id, which becomes tombstoned at
      // KILL_TICK) -- both for steering ordinary edits away from it before/after the kill, and
      // for locating exactly where to delete it AT the kill tick.
      const currentAnchorVis = engine.resolveCaret(snapshot.anchor);
      const len = engine.stats().visibleLength;

      if (sample === KILL_TICK) {
        // A peer deletes the EXACT character the caret is anchored to right now.
        expect(currentAnchorVis).toBeGreaterThan(0); // sanity: still resolves to a real character to delete
        engine.localDelete(currentAnchorVis - 1, 1);
      } else {
        const ch = 97 + Math.floor(rand() * 26);
        if (len === 0 || rand() < 0.6) {
          engine.localInsert(Math.floor(rand() * (len + 1)), ch);
        } else {
          let pos = Math.floor(rand() * len);
          if (pos === currentAnchorVis - 1) {
            pos = (pos + 1) % len;
          }
          engine.localDelete(pos, 1);
        }
      }

      domWriter.mount(root, engine.text());
      restoreCaret(snapshot, root, domWriter.index, engine);
    }

    // Before and including KILL_TICK, every sample captured the ORIGINAL anchor -- the deletion
    // happens AFTER that tick's own capture, so this tick still legitimately observed the old id.
    for (let i = 0; i <= KILL_TICK; i++) {
      expect(anchorIdSeenAcrossSamples[i]).toBe(JSON.stringify(originalAnchorId));
    }
    // From the VERY NEXT sample onward, every capture resolves to the NEW survivor -- the
    // re-anchor happens exactly once, at exactly the expected tick, never later and never
    // repeatedly.
    const newAnchorId = anchorIdSeenAcrossSamples[KILL_TICK + 1]!;
    expect(newAnchorId).not.toBe(JSON.stringify(originalAnchorId));
    for (let i = KILL_TICK + 1; i < 600; i++) {
      expect(anchorIdSeenAcrossSamples[i]).toBe(newAnchorId);
    }
    // Exactly two distinct anchor identifiers were ever captured across the whole 600-sample run
    // -- the original, and the one legitimate replacement -- never a third, spurious one.
    expect(new Set(anchorIdSeenAcrossSamples).size).toBe(2);
  });
});
