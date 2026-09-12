// Phase 33 (API Spec §8.2/§8.3, Test Plan PRES-02/06/07). Renders OTHER participants' carets and
// selections into an overlay layer — a sibling of the editor's contenteditable root, absolutely
// positioned, `pointer-events: none` (Scope-IN) — so presence rendering can NEVER touch, and is
// structurally incapable of touching, the contenteditable subtree `MutationSentinel` (Phase 13)
// watches: nothing in this file ever appends/removes/mutates a node inside the editor root, only
// inside its own separate `overlayContainer` element. This is what makes PRES-02's own
// "binding.reconciliation === 0 throughout" assertion true by CONSTRUCTION, not by carefully
// avoiding a mistake at runtime.
//
// UNLIKE Phase 31's client-side presence CODE (`sync/presence.ts`'s `PresenceUpdateCoalescer`),
// which deliberately has NO import from `@collab-editor/engine` (Scope-IN's own "structural
// isolation" for the WIRE/RATE-LIMITING layer specifically), THIS file legitimately imports and
// calls `Engine.resolveCaret` directly — rendering a peer's cursor fundamentally requires turning
// their relayed node identifier back into a live DOM position, the exact same thing
// `caretTracker.ts` (Phase 32) already does for THIS session's own local caret. There is no
// isolation rule being violated here; Phase 31's own Scope-IN bullet was scoped to the wire/rate
// layer, not to a not-yet-built rendering layer.

import type { Engine, Identifier } from "@collab-editor/engine";
import { visToDom, totalVisibleLength, type RenderRun } from "../binding/index.js";
import type { PresenceClientEvent } from "../sync/syncClient.js";
import { caretColor, selectionColor } from "./color.js";

/** API Spec §8.3 — the three degradation tiers, purely a function of participant COUNT (self excluded, since `onPresenceEvent` never fires for this client's own updates). */
export type PresenceDensityTier = "full" | "caretsAndNames" | "caretsOnly";

export function densityTierFor(participantCount: number): PresenceDensityTier {
  if (participantCount <= 8) return "full";
  if (participantCount <= 15) return "caretsAndNames";
  return "caretsOnly";
}

/** How long a just-moved cursor's name label stays visible before fading (API Spec §8.2: "shown on hover and for 2s after cursor moves, then fades"). */
const NAME_LABEL_VISIBLE_MS = 2000;

interface ParticipantState {
  userId: string;
  displayName: string;
  anchor: Identifier | null;
  focus: Identifier | null;
  collapsed: boolean;
  /** False until this participant's first PRESENCE_UPDATE arrives — nothing is rendered for a joined-but-not-yet-positioned participant. */
  hasPosition: boolean;
  lastMovedAtMs: number;
  hovered: boolean;
}

export interface PresenceOverlayDeps {
  /** The contenteditable root `DomWriter` mounts into — read-only here, NEVER mutated (see this file's own header comment). */
  readonly editorRoot: Element;
  /** A SIBLING of `editorRoot` this class owns exclusively — created and styled by the caller (`EditorView.tsx`) as `position: absolute; inset: 0; pointer-events: none` within a shared `position: relative` wrapper (Scope-IN's own literal layout requirement). */
  readonly overlayContainer: HTMLElement;
  readonly getDomWriterIndex: () => readonly RenderRun[];
  readonly getEngine: () => Engine | null;
  /** Injectable for deterministic testing — mirrors `PresenceUpdateCoalescer`'s own `now` injection (Phase 31). */
  readonly now?: () => number;
  /** Injectable frame scheduler — defaults to real `requestAnimationFrame`; tests inject a synchronous `(cb) => cb()` so rendering is observable without depending on jsdom's own (often absent) rAF support. */
  readonly requestFrame?: (cb: () => void) => void;
}

function identifierEquals(a: Identifier | null, b: Identifier | null): boolean {
  if (a === null || b === null) return a === b;
  return a.c === b.c && a.r === b.r;
}

/**
 * Owns the overlay's full lifecycle: tracks a roster of OTHER participants from raw
 * `PresenceClientEvent`s (join/leave/update/roster — `PRESENCE_UPDATE` itself carries no identity,
 * API Spec §3.8, only `replicaId`; identity comes from whichever JOIN or ROSTER entry introduced
 * that `replicaId`), resolves each one's `anchor`/`focus` to a live visible index via
 * `Engine.resolveCaret` (Phase 32 — correctly tracking a peer's own cursor through THIS session's
 * concurrent local edits too, since `resolveCaret` cares only about the CURRENT tree, never who
 * made a given edit), converts that to real screen geometry via `visToDom` + a DOM `Range`'s own
 * `getClientRects()`, and renders — throttled to at most one paint per animation frame regardless
 * of how many presence events arrive in between (API Spec §8.3's own explicit requirement).
 */
export class PresenceOverlay {
  private readonly participants = new Map<number, ParticipantState>();
  private readonly now: () => number;
  private readonly requestFrame: (cb: () => void) => void;
  private frameScheduled = false;
  private expandedOverflowList = false;
  private started = false;

  private readonly onScroll = (): void => this.scheduleRender();
  private readonly onResize = (): void => this.scheduleRender();

  constructor(private readonly deps: PresenceOverlayDeps) {
    this.now = deps.now ?? Date.now;
    this.requestFrame = deps.requestFrame ?? ((cb) => requestAnimationFrame(cb));
  }

  /** Attaches the scroll/resize listeners (PRES-07: "recomputed on scroll and resize" — `getClientRects()` is viewport-relative, so it goes stale on either even with zero presence changes). */
  start(): void {
    if (this.started) return;
    this.started = true;
    // `scroll` does not bubble, so it must be attached directly to the element that actually
    // scrolls (the contenteditable root itself, via its own `overflow-y: auto`, not `window`).
    this.deps.editorRoot.addEventListener("scroll", this.onScroll);
    window.addEventListener("resize", this.onResize);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.editorRoot.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);
    this.deps.overlayContainer.replaceChildren();
  }

  /** Read-only view of the current tier — exposed for tests and for a future UI affordance to react to it; the overlay's own rendering already applies it internally regardless of any reader. */
  get currentTier(): PresenceDensityTier {
    return densityTierFor(this.participants.size);
  }

  /** Read-only view of currently-tracked participants — exposed for tests (structural assertions) rather than reaching into private state. */
  get participantCount(): number {
    return this.participants.size;
  }

  /** Schedules a re-render with no roster change — e.g. after ANY document mutation (a peer's cursor position shifts relative to newly-inserted/deleted content even though THEY sent nothing new), or after a scroll/resize (this class's own listeners already call this internally; exposed publicly for a caller like `EditorView.tsx` that has its own additional reasons to know "something changed"). */
  refresh(): void {
    this.scheduleRender();
  }

  handlePresenceEvent(event: PresenceClientEvent): void {
    switch (event.kind) {
      case "join":
        this.participants.set(event.replicaId, {
          userId: event.userId,
          displayName: event.displayName,
          anchor: null,
          focus: null,
          collapsed: true,
          hasPosition: false,
          lastMovedAtMs: this.now(),
          hovered: false,
        });
        break;
      case "roster":
        // A complete point-in-time snapshot (Phase 31's own doc comment) — replaces whatever this
        // overlay already tracked, rather than merging, since ROSTER is sent exactly once, right
        // after this session's own handshake completes, when nothing could legitimately already be
        // tracked from an EARLIER join/update for the SAME connection.
        this.participants.clear();
        for (const p of event.participants) {
          this.participants.set(p.replicaId, {
            userId: p.userId,
            displayName: p.displayName,
            anchor: null,
            focus: null,
            collapsed: true,
            hasPosition: false,
            lastMovedAtMs: this.now(),
            hovered: false,
          });
        }
        break;
      case "update": {
        const p = this.participants.get(event.replicaId);
        if (!p) break; // an update for a replica we never saw JOIN/ROSTER for -- nothing to attach it to
        const moved =
          !p.hasPosition ||
          !identifierEquals(p.anchor, event.anchor) ||
          !identifierEquals(p.focus, event.focus);
        p.anchor = event.anchor;
        p.focus = event.focus;
        p.collapsed = event.collapsed;
        p.hasPosition = true;
        if (moved) {
          p.lastMovedAtMs = this.now();
        }
        break;
      }
      case "leave":
        this.participants.delete(event.replicaId);
        break;
    }
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.frameScheduled) return;
    this.frameScheduled = true;
    this.requestFrame(() => {
      this.frameScheduled = false;
      this.render();
    });
  }

  private render(): void {
    const container = this.deps.overlayContainer;
    container.replaceChildren();
    const engine = this.deps.getEngine();
    if (!engine) return; // nothing to resolve positions against yet (not synced)

    const tier = densityTierFor(this.participants.size);
    const containerRect = container.getBoundingClientRect();
    const index = this.deps.getDomWriterIndex();
    const total = totalVisibleLength(index);
    const nowMs = this.now();

    const clampVis = (v: number): number => Math.max(0, Math.min(v, total));

    const toLocalRect = (rect: DOMRect): { left: number; top: number; width: number; height: number } => ({
      left: rect.left - containerRect.left,
      top: rect.top - containerRect.top,
      width: rect.width,
      height: rect.height,
    });

    const visibleIndexToDomPosition = (visibleIndex: number) => visToDom(index, this.deps.editorRoot, clampVis(visibleIndex));

    for (const [replicaId, p] of this.participants) {
      if (!p.hasPosition) continue;
      const color = caretColor(p.userId);
      const focusVis = engine.resolveCaret(p.focus);
      const focusPos = visibleIndexToDomPosition(focusVis);

      if (!p.collapsed && tier === "full") {
        // A real, non-empty selection -- one wash rectangle PER VISUAL LINE via getClientRects(),
        // never a single enclosing box (API Spec §8.2's own explicit "must render 3 rectangles,
        // not one enclosing box" requirement for a 3-line selection).
        const anchorVis = engine.resolveCaret(p.anchor);
        const startVis = Math.min(anchorVis, focusVis);
        const endVis = Math.max(anchorVis, focusVis);
        if (endVis > startVis) {
          const startPos = visibleIndexToDomPosition(startVis);
          const endPos = visibleIndexToDomPosition(endVis);
          const range = document.createRange();
          try {
            range.setStart(startPos.node, startPos.offset);
            range.setEnd(endPos.node, endPos.offset);
            for (const rect of Array.from(range.getClientRects())) {
              const local = toLocalRect(rect);
              if (local.width <= 0 || local.height <= 0) continue;
              const wash = document.createElement("div");
              wash.dataset.presenceReplicaId = String(replicaId);
              wash.dataset.presenceKind = "selection";
              Object.assign(wash.style, {
                position: "absolute",
                left: `${local.left}px`,
                top: `${local.top}px`,
                width: `${local.width}px`,
                height: `${local.height}px`,
                background: selectionColor(p.userId),
              });
              container.appendChild(wash);
            }
          } catch {
            // The resolved DOM position no longer exists (e.g. a race between a remote batch
            // remounting the whole subtree and this render pass) -- skip this participant's
            // selection wash for this one frame; the next presence update or the next
            // scroll/resize-triggered render will simply try again against fresh DOM state.
          }
        }
      }

      // The caret marker itself: ALWAYS drawn at the FOCUS end (API Spec §8.2: "caret drawn at
      // the focus end only"), for every tier -- carets are never suppressed, only names/washes are.
      const caretRects = (() => {
        const range = document.createRange();
        try {
          range.setStart(focusPos.node, focusPos.offset);
          range.collapse(true);
          const rects = Array.from(range.getClientRects());
          return rects.length > 0 ? rects : [this.deps.editorRoot.getBoundingClientRect()];
        } catch {
          return [] as DOMRect[];
        }
      })();
      const caretRect = caretRects[0];
      if (!caretRect) continue;
      const local = toLocalRect(caretRect);
      const caretEl = document.createElement("div");
      caretEl.dataset.presenceReplicaId = String(replicaId);
      caretEl.dataset.presenceKind = "caret";
      Object.assign(caretEl.style, {
        position: "absolute",
        left: `${local.left}px`,
        top: `${local.top}px`,
        width: "2px",
        height: `${local.height || 16}px`,
        background: color,
      });
      container.appendChild(caretEl);

      // Name labels: only in the two denser-than-16 tiers ("full" and "caretsAndNames"), never in
      // "caretsOnly" (API Spec §8.3: "carets only, no names"), and even then only while recently
      // moved or currently hovered (§8.2: "shown on hover and for 2s after cursor moves, then
      // fades").
      if (tier !== "caretsOnly") {
        const recentlyMoved = nowMs - p.lastMovedAtMs < NAME_LABEL_VISIBLE_MS;
        if (recentlyMoved || p.hovered) {
          const label = document.createElement("div");
          label.dataset.presenceReplicaId = String(replicaId);
          label.dataset.presenceKind = "label";
          label.textContent = p.displayName;
          Object.assign(label.style, {
            position: "absolute",
            left: `${local.left}px`,
            top: `${local.top - 18}px`,
            background: color,
            color: "white",
            fontSize: "11px",
            padding: "1px 4px",
            borderRadius: "2px",
            whiteSpace: "nowrap",
            // The caret itself is `pointer-events: none` (inherited from the container), but the
            // label is given its own small `pointer-events: auto` hit-area so hover detection
            // (this same "shown on hover" requirement) can work at all -- the container's own
            // blanket `pointer-events: none` never blocks ordinary editor clicks BENEATH it, since
            // this is one small, deliberate, tag-scoped exception, not a change to the container.
            pointerEvents: "auto",
          });
          label.addEventListener("mouseenter", () => {
            p.hovered = true;
            this.scheduleRender();
          });
          label.addEventListener("mouseleave", () => {
            p.hovered = false;
            this.scheduleRender();
          });
          container.appendChild(label);
        }
      }
    }

    if (tier === "caretsOnly") {
      this.renderOverflowChip(container);
    }
  }

  /** API Spec §8.3's 16+ tier: "stacked-avatar overflow chip showing count, expands to a list on click." */
  private renderOverflowChip(container: HTMLElement): void {
    const chip = document.createElement("div");
    chip.dataset.presenceKind = "overflowChip";
    chip.textContent = `${this.participants.size} people`;
    Object.assign(chip.style, {
      position: "absolute",
      right: "8px",
      top: "8px",
      background: "#333",
      color: "white",
      fontSize: "11px",
      padding: "2px 8px",
      borderRadius: "10px",
      cursor: "pointer",
      // Locally re-enables pointer events for this ONE small element only (see the name label's
      // own identical comment above) -- Scope-IN's "pointer-events: none" describes the overlay
      // CONTAINER, not every element ever placed inside it; a clickable chip is the one named
      // exception in the spec text itself ("expands to a list on click").
      pointerEvents: "auto",
    });
    chip.addEventListener("click", () => {
      this.expandedOverflowList = !this.expandedOverflowList;
      this.scheduleRender();
    });
    container.appendChild(chip);

    if (this.expandedOverflowList) {
      const list = document.createElement("div");
      list.dataset.presenceKind = "overflowList";
      Object.assign(list.style, {
        position: "absolute",
        right: "8px",
        top: "28px",
        background: "white",
        border: "1px solid #ccc",
        borderRadius: "4px",
        padding: "4px",
        pointerEvents: "auto",
        maxHeight: "200px",
        overflowY: "auto",
      });
      for (const p of this.participants.values()) {
        const row = document.createElement("div");
        row.textContent = p.displayName;
        row.style.color = caretColor(p.userId);
        row.style.fontSize = "12px";
        list.appendChild(row);
      }
      container.appendChild(list);
    }
  }
}
