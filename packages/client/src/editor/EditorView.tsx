// The React editor component (Phase 12 Scope-IN: "A React editor component
// with a contenteditable root"). Owns nothing about connection lifecycle —
// the caller constructs and connects a `SyncClient` and hands it in as a
// prop, the same "compose the primitives" shape Phase 10's headless harness
// already uses — this component's only job is to mount `DomWriter` against
// the contenteditable root once synced, and wire `beforeinput` through the
// input pipeline (Phase 12) so the browser never mutates the DOM itself.
//
// Phase 13 added the MutationSentinel: every DomWriter write this component
// performs (the initial mount, every SNAPSHOT re-mount) now runs through
// `sentinel.applyPatches()`, and the sentinel watches the whole subtree for
// any OTHER mutation — a browser extension, devtools, a future bug — and
// reverts it, treating the engine as authoritative (API Spec §7.7, RFC R5).
//
// Phase 14 wires `sync.onRemoteOpsApplied` in too: on every batch of
// REMOTE operations (this session's own edits already update the DOM
// directly, via DomWriter, from the input pipeline), this component
// re-mounts the WHOLE subtree from `engine.text()` — through the SAME
// `sentinel.applyPatches()` wrapper — and restores the caret/selection
// afterward.
//
// Phase 32 (API Spec §7.5/§11.7, Test Plan CUR-01..05, blocker B19) replaced
// Phase 14's own "capture the raw numeric visible index, remount, restore
// that SAME numeric index" stand-in — which kept typing usable but did NOT
// keep the caret attached to the character the user actually placed it on,
// since a remote insert/delete before that index shifts what that index now
// points at. `captureCaret`/`restoreCaret` (caretTracker.ts) instead resolve
// the live selection's anchor AND focus to stable node identifiers
// (`resolvePresenceAnchor`, the same identifier-resolution convention Phase
// 31's presence protocol already uses) before the remount, then resolve
// those identifiers back to a CURRENT visible index (`Engine.resolveCaret`,
// this phase) afterward — tracking the same character even through a
// remote edit that shifted or deleted content around it.
//
// Phase 33 (API Spec §8, Test Plan PRES-02/03/06/07) renders OTHER
// participants' own carets/selections into a NEW overlay element — a
// SIBLING of the contenteditable root, absolutely positioned inside a
// shared `position: relative` wrapper, `pointer-events: none` (Scope-IN's
// own literal layout requirement). The wrapper element is new this phase;
// the contenteditable root itself is otherwise unchanged, still the exact
// same element every prior phase's tests query via `[contenteditable="true"]`.
// `PresenceOverlay` is refreshed via TWO triggers: `sync.onPresenceEvent`
// (a peer's own join/leave/update/roster) AND `sentinel`'s new
// `onApplyPatches` hook (ANY document mutation, local or remote — typing
// before a peer's cursor shifts where it visually sits too, even though
// that peer sent nothing new).

import { useEffect, useRef } from "react";
import type { Engine } from "@collab-editor/engine";
import { DomWriter } from "../binding/index.js";
import { attachInputPipeline } from "../input/index.js";
import { PresenceOverlay } from "../presence/index.js";
import { MutationSentinel } from "../sentinel/index.js";
import type { SyncClient } from "../sync/syncClient.js";
import { captureCaret, restoreCaret } from "./caretTracker.js";

export interface EditorViewProps {
  readonly sync: SyncClient;
  readonly className?: string;
}

export function EditorView({ sync, className }: EditorViewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const domWriterRef = useRef<DomWriter | null>(null);
  const mountedEngineRef = useRef<Engine | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const overlayEl = overlayRef.current;
    if (!root || !overlayEl) {
      return;
    }
    const domWriter = new DomWriter();
    domWriterRef.current = domWriter;
    const presenceOverlay = new PresenceOverlay({
      editorRoot: root,
      overlayContainer: overlayEl,
      getDomWriterIndex: () => domWriter.index,
      getEngine: () => sync.engine,
    });
    presenceOverlay.start();
    const unsubscribePresence = sync.onPresenceEvent((event) => {
      presenceOverlay.handlePresenceEvent(event);
    });
    const sentinel = new MutationSentinel({
      root,
      domWriter,
      getEngineText: () => sync.engine?.text(),
      onApplyPatches: () => presenceOverlay.refresh(),
    });
    sentinel.start();

    const mountIfNewEngine = () => {
      const engine = sync.engine;
      if (engine && engine !== mountedEngineRef.current) {
        sentinel.applyPatches(() => domWriter.mount(root, engine.text()));
        mountedEngineRef.current = engine;
      }
    };
    mountIfNewEngine(); // covers the case where `sync` is already synced before this effect runs

    const unsubscribe = sync.state.subscribe((state) => {
      if (state === "synced") {
        mountIfNewEngine();
      }
    });

    const unsubscribeRemoteOps = sync.onRemoteOpsApplied(() => {
      const engine = sync.engine;
      if (!engine || engine !== mountedEngineRef.current) {
        return; // a SNAPSHOT re-mount (mountIfNewEngine) already covers a brand-new engine
      }
      // capture() BEFORE the mutation (Scope-IN's own ordering) -- the live selection's DOM
      // node/offset only means something relative to the CURRENT, pre-mutation render index.
      const snapshot = captureCaret(domWriter.index, engine);
      sentinel.applyPatches(() => domWriter.mount(root, engine.text()));
      // restore() AFTER all of them -- against the FRESH render index `mount()` just produced.
      if (snapshot) {
        restoreCaret(snapshot, root, domWriter.index, engine);
      }
    });

    const detachInput = attachInputPipeline(root, { domWriter, sync, sentinel });

    return () => {
      unsubscribe();
      unsubscribeRemoteOps();
      unsubscribePresence();
      detachInput();
      sentinel.stop();
      presenceOverlay.stop();
      domWriterRef.current = null;
      mountedEngineRef.current = null;
    };
  }, [sync]);

  return (
    // The wrapper exists ONLY to give the overlay a `position: relative` positioning ancestor
    // (Scope-IN's own literal layout requirement). `className` stays on the contenteditable
    // element itself, unchanged from every prior phase, so its own styling (`.editor-root`'s
    // padding/font/overflow-y:auto in app/index.html — the actual SCROLLING element PRES-07's own
    // `scroll` listener attaches to) is unaffected — but `App.tsx`'s own flex layout previously
    // sized `.editor-root` DIRECTLY as a flex child of its column container via `.editor-root`'s
    // own `flex: 1`; inserting this wrapper between them means the WRAPPER is now that flex child
    // instead, so it needs the identical `flex: 1` (to still fill the remaining vertical space)
    // plus `display: flex` and `min-height: 0` (so `.editor-root`'s own `flex: 1` — now measured
    // against ITS immediate parent, the wrapper, not `App.tsx`'s column — continues to fill that
    // space and its own `overflow-y: auto` continues to govern scrolling exactly as before).
    <div style={{ position: "relative", display: "flex", flex: 1, minHeight: 0 }}>
      <div
        ref={rootRef}
        className={className}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        role="textbox"
        aria-multiline="true"
      />
      <div
        ref={overlayRef}
        style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
        aria-hidden="true"
      />
    </div>
  );
}
