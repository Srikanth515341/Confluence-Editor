// @vitest-environment jsdom
//
// Test Plan PRES-02 (partial)/PRES-06/PRES-07 (partial). jsdom has no real layout engine —
// `Range.getClientRects()`/`Element.getBoundingClientRect()` always return zero-sized rects — so
// this file mocks JUST those two measurement points to return deterministic fake geometry,
// leaving the REAL pipeline (resolve a peer's relayed identifier -> a live visible index via
// `Engine.resolveCaret` -> a real DOM node/offset via `visToDom`, against a REAL `Engine` + REAL
// `DomWriter`-rendered subtree) entirely genuine. This proves this file's OWN rendering logic
// (which elements get created, under which tier, with what data, one rect per line rather than
// one enclosing box) faithfully — the one thing jsdom genuinely cannot prove is REAL multi-line
// text-wrapping geometry (a real 3-line paragraph actually producing 3 real rects) or REAL
// scroll/resize-triggered browser reflow, both of which live in
// `packages/client/e2e/presenceRendering.spec.ts` instead (real Chromium/Firefox/WebKit).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, type Identifier } from "@collab-editor/engine";
import { SessionRole } from "@collab-editor/protocol";
import { DomWriter } from "../binding/index.js";
import type { PresenceClientEvent } from "../sync/syncClient.js";
import { densityTierFor } from "./presenceOverlay.js";
import { PresenceOverlay } from "./presenceOverlay.js";

function fakeRect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) };
}

let containerRectMock: DOMRect;
let rangeRectsMock: DOMRect[];

beforeEach(() => {
  document.body.replaceChildren();
  containerRectMock = fakeRect(0, 0, 800, 600);
  rangeRectsMock = [fakeRect(10, 20, 2, 16)];
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return containerRectMock;
  });
  // jsdom's `Range.prototype` has no `getClientRects` at all (unlike `Element.prototype.
  // getBoundingClientRect`, which jsdom DOES define, just returning zeros) -- `vi.spyOn` requires
  // an existing method to wrap, so this is a plain assignment instead, restored after each test via
  // vitest's own `restoreMocks`/explicit cleanup is unnecessary since `beforeEach` reassigns it
  // fresh every time regardless.
  (Range.prototype as unknown as { getClientRects: () => DOMRectList }).getClientRects = () =>
    rangeRectsMock as unknown as DOMRectList;
});

function setup(text: string): { root: HTMLDivElement; overlay: HTMLDivElement; domWriter: DomWriter; engine: Engine } {
  const wrapper = document.createElement("div");
  document.body.appendChild(wrapper);
  const root = document.createElement("div");
  const overlay = document.createElement("div");
  wrapper.appendChild(root);
  wrapper.appendChild(overlay);
  const domWriter = new DomWriter();
  const engine = new Engine(1);
  for (const ch of text) {
    engine.localInsert(engine.stats().visibleLength, ch.codePointAt(0)!);
  }
  domWriter.mount(root, engine.text());
  return { root, overlay, domWriter, engine };
}

function join(replicaId: number, userId: string, displayName = `User ${replicaId}`): PresenceClientEvent {
  return { kind: "join", replicaId, userId, displayName, role: SessionRole.EDITOR };
}
function update(replicaId: number, anchor: Identifier | null, focus: Identifier | null, collapsed: boolean): PresenceClientEvent {
  return { kind: "update", replicaId, anchor, focus, collapsed };
}
function leave(replicaId: number): PresenceClientEvent {
  return { kind: "leave", replicaId, reason: 0 };
}

describe("densityTierFor (API Spec §8.3)", () => {
  it("1-8 -> full, 9-15 -> caretsAndNames, 16+ -> caretsOnly", () => {
    expect(densityTierFor(1)).toBe("full");
    expect(densityTierFor(8)).toBe("full");
    expect(densityTierFor(9)).toBe("caretsAndNames");
    expect(densityTierFor(15)).toBe("caretsAndNames");
    expect(densityTierFor(16)).toBe("caretsOnly");
    expect(densityTierFor(32)).toBe("caretsOnly");
  });
});

describe("PresenceOverlay -- structural isolation (PRES-02)", () => {
  it("renders into a container that is a SIBLING of, never inside, the contenteditable root", () => {
    const { root, overlay, domWriter, engine } = setup("hello world");
    const anchor = engine.visible()[2]!.id;
    const overlayInstance = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => cb(),
    });
    overlayInstance.handlePresenceEvent(join(2, "user-a"));
    overlayInstance.handlePresenceEvent(update(2, anchor, anchor, true));

    expect(root.contains(overlay)).toBe(false);
    expect(overlay.contains(root)).toBe(false);
    expect(overlay.querySelector('[data-presence-kind="caret"]')).not.toBeNull();
    // Nothing presence-related was ever inserted into the contenteditable subtree itself.
    expect(root.querySelector("[data-presence-kind]")).toBeNull();
  });
});

describe("PresenceOverlay -- roster tracking and rendering", () => {
  it("renders a caret for a joined-and-positioned participant; renders nothing for a joined-but-not-yet-positioned one", () => {
    const { root, overlay, domWriter, engine } = setup("hello world");
    const anchor = engine.visible()[2]!.id;
    const o = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => cb(),
    });
    o.handlePresenceEvent(join(2, "user-a"));
    expect(overlay.querySelectorAll('[data-presence-kind="caret"]').length).toBe(0); // no position yet
    o.handlePresenceEvent(update(2, anchor, anchor, true));
    expect(overlay.querySelectorAll('[data-presence-kind="caret"]').length).toBe(1);
  });

  it("an UPDATE for a replicaId that never joined/rostered is safely ignored", () => {
    const { root, overlay, domWriter, engine } = setup("hello");
    const anchor = engine.visible()[0]!.id;
    const o = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => cb(),
    });
    o.handlePresenceEvent(update(99, anchor, anchor, true));
    expect(o.participantCount).toBe(0);
    expect(overlay.children.length).toBe(0);
  });

  it("ROSTER replaces whatever was previously tracked (a complete snapshot, not a merge)", () => {
    const { root, overlay, domWriter, engine } = setup("hello");
    const o = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => cb(),
    });
    o.handlePresenceEvent(join(1, "stale-user"));
    expect(o.participantCount).toBe(1);
    o.handlePresenceEvent({
      kind: "roster",
      participants: [
        { replicaId: 2, userId: "fresh-user", displayName: "Fresh", role: SessionRole.EDITOR },
      ],
    });
    expect(o.participantCount).toBe(1); // the stale one is gone, replaced by the roster's own entry
  });

  it("LEAVE removes the participant and their rendered elements", () => {
    const { root, overlay, domWriter, engine } = setup("hello");
    const anchor = engine.visible()[0]!.id;
    const o = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => cb(),
    });
    o.handlePresenceEvent(join(2, "user-a"));
    o.handlePresenceEvent(update(2, anchor, anchor, true));
    expect(overlay.children.length).toBeGreaterThan(0);
    o.handlePresenceEvent(leave(2));
    expect(o.participantCount).toBe(0);
    expect(overlay.querySelectorAll('[data-presence-kind="caret"]').length).toBe(0);
  });
});

describe("PresenceOverlay -- selection rendering and tier suppression (API Spec §8.2/§8.3)", () => {
  it("tier 1 (full): a real selection renders ONE wash element PER RECT getClientRects() reports, never one enclosing box", () => {
    const { root, overlay, domWriter, engine } = setup("hello world, this is a long line");
    const anchor = engine.visible()[0]!.id;
    const focus = engine.visible()[10]!.id;
    rangeRectsMock = [fakeRect(0, 0, 100, 16), fakeRect(0, 16, 200, 16), fakeRect(0, 32, 50, 16)]; // a 3-line selection
    const o = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => cb(),
    });
    o.handlePresenceEvent(join(2, "user-a"));
    o.handlePresenceEvent(update(2, anchor, focus, false)); // collapsed: false -- a real selection

    const washes = overlay.querySelectorAll('[data-presence-kind="selection"]');
    expect(washes.length).toBe(3); // NOT 1 -- exactly matches the number of rects reported
    // The caret marker is ALSO drawn (at the focus end), independent of the selection washes.
    expect(overlay.querySelectorAll('[data-presence-kind="caret"]').length).toBe(1);
  });

  it("BOUNDARY: at EXACTLY 8 participants selection washes still render (full tier); at EXACTLY 9, the SAME selection is suppressed (crossed into tier 2)", () => {
    // `densityTierFor` itself is already checked at the exact 8/9 and 15/16 boundaries above (a
    // pure function, no DOM) -- this test additionally proves the BEHAVIORAL consequence at those
    // same exact counts, not just at an interior sample point (10, 20) that could miss a boundary
    // bug specific to how `render()` applies the tier, e.g. a hypothetical second, independently
    // hand-written `<= 8` vs `< 8` check that diverged from `densityTierFor`'s own.
    const { root, overlay, domWriter, engine } = setup("hello world, this is a long line");
    const anchor = engine.visible()[0]!.id;
    const focus = engine.visible()[10]!.id;
    rangeRectsMock = [fakeRect(0, 0, 100, 16), fakeRect(0, 16, 200, 16)];
    const o = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => cb(),
    });

    for (let i = 1; i <= 7; i++) o.handlePresenceEvent(join(i, `user-${i}`));
    o.handlePresenceEvent(join(8, "selector")); // exactly 8 -- still "full"
    o.handlePresenceEvent(update(8, anchor, focus, false)); // participant 8 holds the real selection
    for (let i = 1; i <= 7; i++) o.handlePresenceEvent(update(i, anchor, anchor, true));

    expect(o.currentTier).toBe("full");
    expect(overlay.querySelectorAll('[data-presence-kind="selection"]').length).toBe(2); // rendered

    o.handlePresenceEvent(join(9, "ninth")); // crosses to exactly 9 -- tier 2
    o.handlePresenceEvent(update(9, anchor, anchor, true));

    expect(o.currentTier).toBe("caretsAndNames");
    expect(overlay.querySelectorAll('[data-presence-kind="selection"]').length).toBe(0); // the SAME selection, now suppressed
    expect(overlay.querySelectorAll('[data-presence-kind="caret"]').length).toBe(9); // carets unaffected by the crossing
  });

  it("BOUNDARY: at EXACTLY 15 participants name labels still render and no overflow chip exists; at EXACTLY 16, names disappear and the chip appears", () => {
    const { root, overlay, domWriter, engine } = setup("hello");
    const anchor = engine.visible()[0]!.id;
    let nowMs = 5_000_000;
    const o = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => cb(),
      now: () => nowMs,
    });

    for (let i = 1; i <= 15; i++) {
      o.handlePresenceEvent(join(i, `user-${i}`));
      o.handlePresenceEvent(update(i, anchor, anchor, true)); // each freshly "moved" -- label visible
    }
    expect(o.currentTier).toBe("caretsAndNames");
    expect(overlay.querySelectorAll('[data-presence-kind="label"]').length).toBe(15);
    expect(overlay.querySelector('[data-presence-kind="overflowChip"]')).toBeNull();

    o.handlePresenceEvent(join(16, "sixteenth")); // crosses to exactly 16 -- tier 3
    o.handlePresenceEvent(update(16, anchor, anchor, true));

    expect(o.currentTier).toBe("caretsOnly");
    expect(overlay.querySelectorAll('[data-presence-kind="label"]').length).toBe(0); // ALL 16 labels gone, not just the new one's
    expect(overlay.querySelector('[data-presence-kind="overflowChip"]')).not.toBeNull();
    expect(overlay.querySelectorAll('[data-presence-kind="caret"]').length).toBe(16); // carets unaffected by the crossing
  });

  it("tier 2 (9-15 participants): selection washes are suppressed entirely, but carets and names remain", () => {
    const { root, overlay, domWriter, engine } = setup("hello world, this is a long line");
    const anchor = engine.visible()[0]!.id;
    const focus = engine.visible()[10]!.id;
    rangeRectsMock = [fakeRect(0, 0, 100, 16), fakeRect(0, 16, 200, 16)];
    const o = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => cb(),
    });
    for (let i = 1; i <= 10; i++) o.handlePresenceEvent(join(i, `user-${i}`)); // 10 participants -> tier 2
    o.handlePresenceEvent(update(1, anchor, focus, false));
    for (let i = 2; i <= 10; i++) o.handlePresenceEvent(update(i, anchor, anchor, true));

    expect(o.currentTier).toBe("caretsAndNames");
    expect(overlay.querySelectorAll('[data-presence-kind="selection"]').length).toBe(0); // suppressed
    expect(overlay.querySelectorAll('[data-presence-kind="caret"]').length).toBe(10); // carets still render
    expect(overlay.querySelectorAll('[data-presence-kind="label"]').length).toBeGreaterThan(0); // names still shown
  });

  it("tier 3 (16+ participants): no name labels are ever rendered, carets still render, and an overflow chip shows the count", () => {
    const { root, overlay, domWriter, engine } = setup("hello world");
    const anchor = engine.visible()[0]!.id;
    const o = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => cb(),
    });
    for (let i = 1; i <= 20; i++) {
      o.handlePresenceEvent(join(i, `user-${i}`));
      o.handlePresenceEvent(update(i, anchor, anchor, true));
    }

    expect(o.currentTier).toBe("caretsOnly");
    expect(overlay.querySelectorAll('[data-presence-kind="caret"]').length).toBe(20);
    expect(overlay.querySelectorAll('[data-presence-kind="label"]').length).toBe(0); // no names at all
    const chip = overlay.querySelector('[data-presence-kind="overflowChip"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("20");
  });

  it("the overflow chip expands to a list of participants on click, and collapses again on a second click", () => {
    const { root, overlay, domWriter, engine } = setup("hello");
    const anchor = engine.visible()[0]!.id;
    const o = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => cb(),
    });
    for (let i = 1; i <= 16; i++) {
      o.handlePresenceEvent(join(i, `user-${i}`, `Person ${i}`));
      o.handlePresenceEvent(update(i, anchor, anchor, true));
    }
    expect(overlay.querySelector('[data-presence-kind="overflowList"]')).toBeNull();
    const chip = overlay.querySelector('[data-presence-kind="overflowChip"]') as HTMLElement;
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const list = overlay.querySelector('[data-presence-kind="overflowList"]');
    expect(list).not.toBeNull();
    expect(list!.textContent).toContain("Person 1");
    expect(list!.querySelectorAll("div").length).toBe(16);

    const chipAgain = overlay.querySelector('[data-presence-kind="overflowChip"]') as HTMLElement;
    chipAgain.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(overlay.querySelector('[data-presence-kind="overflowList"]')).toBeNull();
  });
});

describe("PresenceOverlay -- name label fade timing (API Spec §8.2: 'shown on hover and for 2s after cursor moves, then fades')", () => {
  it("shows the name label immediately after a move, hides it once 2s have passed with no further move, and shows it again on hover", () => {
    const { root, overlay, domWriter, engine } = setup("hello world");
    const anchor = engine.visible()[0]!.id;
    let nowMs = 1_000_000;
    const o = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => cb(),
      now: () => nowMs,
    });
    o.handlePresenceEvent(join(2, "user-a"));
    o.handlePresenceEvent(update(2, anchor, anchor, true));
    expect(overlay.querySelectorAll('[data-presence-kind="label"]').length).toBe(1); // just moved -- visible

    nowMs += 1999;
    o.refresh();
    expect(overlay.querySelectorAll('[data-presence-kind="label"]').length).toBe(1); // still under 2s

    nowMs += 2; // now just past the 2s mark
    o.refresh();
    expect(overlay.querySelectorAll('[data-presence-kind="label"]').length).toBe(0); // faded

    const label = overlay.querySelector('[data-presence-kind="caret"]') as HTMLElement;
    void label;
    // Simulate hovering the (now-hidden) label's own caret area isn't directly testable without a
    // rendered label to hover -- exercise the underlying mechanism directly instead: a real
    // mouseenter on a rendered label (captured while still visible) re-arms visibility.
    nowMs = 1_000_000;
    o.handlePresenceEvent(update(2, anchor, anchor, true)); // move again to get a fresh, visible label
    const freshLabel = overlay.querySelector('[data-presence-kind="label"]') as HTMLElement;
    expect(freshLabel).not.toBeNull();
    freshLabel.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    nowMs += 5000; // well past the 2s fade window
    o.refresh();
    expect(overlay.querySelectorAll('[data-presence-kind="label"]').length).toBe(1); // still shown -- hovered
  });
});

describe("PresenceOverlay -- rAF throttling (API Spec §8.3: 'throttled to one animation frame regardless of update volume')", () => {
  it("schedules at most ONE frame callback no matter how many events arrive before it fires", () => {
    const { root, overlay, domWriter, engine } = setup("hello");
    const anchor = engine.visible()[0]!.id;
    let scheduledCount = 0;
    let pendingCb: (() => void) | null = null;
    const o = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => {
        scheduledCount++;
        pendingCb = cb;
      },
    });
    o.handlePresenceEvent(join(1, "a"));
    o.handlePresenceEvent(join(2, "b"));
    o.handlePresenceEvent(update(1, anchor, anchor, true));
    o.handlePresenceEvent(update(2, anchor, anchor, true));
    expect(scheduledCount).toBe(1); // ONE frame scheduled despite 4 events

    pendingCb!(); // the frame finally fires
    expect(overlay.querySelectorAll('[data-presence-kind="caret"]').length).toBe(2); // both reflected in that one render

    // A NEW event after the frame fired schedules exactly one MORE frame.
    o.handlePresenceEvent(leave(2));
    expect(scheduledCount).toBe(2);
  });
});

describe("PresenceOverlay -- recomputes on scroll and resize (PRES-07, structural half)", () => {
  it("a 'scroll' event on editorRoot and a 'resize' event on window each schedule a render", () => {
    const { root, overlay, domWriter, engine } = setup("hello");
    let scheduledCount = 0;
    const o = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlay,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => engine,
      requestFrame: (cb) => {
        scheduledCount++;
        cb();
      },
    });
    o.start();
    expect(scheduledCount).toBe(0);
    root.dispatchEvent(new Event("scroll"));
    expect(scheduledCount).toBe(1);
    window.dispatchEvent(new Event("resize"));
    expect(scheduledCount).toBe(2);
    o.stop();
    root.dispatchEvent(new Event("scroll"));
    expect(scheduledCount).toBe(2); // no longer listening after stop()
  });
});
