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
// No cursor transformation under remote edits (Phase 32) exists yet: this
// component re-mounts DomWriter's ENTIRE content from `engine.text()` on
// every fresh SNAPSHOT (a real (re)connect), and otherwise reflects only
// this session's OWN local edits — a remote peer's concurrent edit updates
// `sync.engine` correctly (Phase 3's engine, proven convergent) but is not
// yet reflected in this session's live DOM, exactly as the project's "what
// is NOT yet built" section documents.

import { useEffect, useRef } from "react";
import type { Engine } from "@collab-editor/engine";
import { DomWriter } from "../binding/index.js";
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
    const detachInput = attachInputPipeline(root, { domWriter, sync, sentinel });

    return () => {
      unsubscribe();
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
