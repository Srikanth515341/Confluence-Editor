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
// `sentinel.applyPatches()` wrapper — and does a best-effort caret restore
// (capture this session's own visible-index position, remount, restore
// that SAME numeric index). This is NOT cursor transformation (Phase 32):
// a remote insert/delete before the local caret should shift its index by
// the change's length to stay in the same RELATIVE spot, which this does
// not do — restoring the identical raw index is the simplest thing that
// keeps typing usable at all when remote edits interleave (discovered
// necessary by actually running a two-window manual test during this
// phase's own development — without ANY re-render on remote ops, a peer's
// edits never appeared in this session's DOM at all, only in `engine.text()`,
// which would have made Milestone M1's whole premise unverifiable in a
// real browser). Real relative-position preservation across concurrent
// remote edits remains Phase 32's job.

import { useEffect, useRef } from "react";
import type { Engine } from "@collab-editor/engine";
import { DomWriter, domToVis, totalVisibleLength, visToDom } from "../binding/index.js";
import { attachInputPipeline } from "../input/index.js";
import { MutationSentinel } from "../sentinel/index.js";
import type { SyncClient } from "../sync/syncClient.js";

export interface EditorViewProps {
  readonly sync: SyncClient;
  readonly className?: string;
}

export function EditorView({ sync, className }: EditorViewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const domWriterRef = useRef<DomWriter | null>(null);
  const mountedEngineRef = useRef<Engine | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const domWriter = new DomWriter();
    domWriterRef.current = domWriter;
    const sentinel = new MutationSentinel({
      root,
      domWriter,
      getEngineText: () => sync.engine?.text(),
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

    // Arrow expressions, not function declarations — TS narrows a captured `const` (here, `root`
    // after the early-return above) through an arrow closure but not reliably through a hoisted
    // function declaration, since the latter could in principle be invoked before the narrowing
    // check runs.
    /** Best-effort: see this file's own header comment for why this is a numeric-index restore, not real cursor transformation. */
    const captureCaretVisIndex = (): number => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        return 0;
      }
      try {
        const range = sel.getRangeAt(0);
        return domToVis(domWriter.index, range.startContainer, range.startOffset);
      } catch {
        return 0;
      }
    };

    const restoreCaretVisIndex = (visIndex: number): void => {
      const sel = window.getSelection();
      if (!sel) {
        return;
      }
      const total = totalVisibleLength(domWriter.index);
      const clamped = Math.max(0, Math.min(visIndex, total));
      const pos = visToDom(domWriter.index, root, clamped);
      const range = document.createRange();
      range.setStart(pos.node, pos.offset);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    };

    const unsubscribeRemoteOps = sync.onRemoteOpsApplied(() => {
      const engine = sync.engine;
      if (!engine || engine !== mountedEngineRef.current) {
        return; // a SNAPSHOT re-mount (mountIfNewEngine) already covers a brand-new engine
      }
      const savedVisIndex = captureCaretVisIndex();
      sentinel.applyPatches(() => domWriter.mount(root, engine.text()));
      restoreCaretVisIndex(savedVisIndex);
    });

    const detachInput = attachInputPipeline(root, { domWriter, sync, sentinel });

    return () => {
      unsubscribe();
      unsubscribeRemoteOps();
      detachInput();
      sentinel.stop();
      domWriterRef.current = null;
      mountedEngineRef.current = null;
    };
  }, [sync]);

  return (
    <div
      ref={rootRef}
      className={className}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      role="textbox"
      aria-multiline="true"
    />
  );
}
