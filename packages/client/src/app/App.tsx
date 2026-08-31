// The demo application shell (Phase 14 Scope-IN: "A minimal React app: open
// a document by URL, edit it, see a connection-state indicator"). This is
// the file Milestone M1's manual two-window demo actually runs — see
// CLAUDE.md's Phase 14 entry for exact instructions. Composition only: URL
// parsing (urlParams.ts), connecting (`SyncClient`, Phase 10), rendering
// (`EditorView`, Phases 11-13). No new editing logic lives here.

import { useEffect, useState } from "react";
import type { ConnectionState } from "../sync/connectionState.js";
import { SyncClient } from "../sync/syncClient.js";
import { EditorView } from "../editor/index.js";
import { ConnectionIndicator } from "./ConnectionIndicator.js";
import { getOrCreateDocumentId, getServerUrl } from "./urlParams.js";

function replaceUrlSearch(search: string): void {
  const url = new URL(window.location.href);
  url.search = search;
  window.history.replaceState(null, "", url.toString());
}

/** Constructed once per mount via `useState`'s lazy initializer — never on a later re-render, since a `SyncClient` is a stateful connection, not a value to recompute. */
function createClient(): SyncClient {
  const documentId = getOrCreateDocumentId(window.location, replaceUrlSearch);
  const url = getServerUrl(window.location);
  return new SyncClient({ url, documentId });
}

export function App(): React.JSX.Element {
  const [sync] = useState(createClient);
  const [state, setState] = useState<ConnectionState>(sync.state.value);

  useEffect(() => {
    const unsubscribe = sync.state.subscribe(setState);
    sync.connect();
    // Test/observability hook (Phase 14, Test Plan §2.7 E2E-CONV-01 assertions 2 and 4): the
    // E2E-CONV suite needs `engine.text()`/`engine.pending.length` INDEPENDENT of what the DOM
    // shows, to prove the DOM actually matches the engine rather than just matching itself. No
    // auth/security posture exists yet in this project (consistent with the server's own
    // `/v1/documents/:id/replay` diagnostic endpoint, added the same phase for the same reason).
    (window as unknown as { __collabDebug?: unknown }).__collabDebug = {
      getEngineText: () => sync.engine?.text(),
      getPendingCount: () => sync.engine?.pending.length,
      // Diagnostic-only addition (not part of any phase's Scope-IN): dumps the full node
      // structure (ids/origins/bind/tombstone state), not just materialized text, so a
      // divergence between two clients can be root-caused at the node level rather than only
      // detected at the text level. Added while investigating a real cross-client divergence
      // found during Phase 14 DoD verification (see CLAUDE.md's Phase 14 entry).
      getEngineNodes: () =>
        sync.engine?.nodes.map((n) => ({
          id: n.id,
          originLeft: n.originLeft,
          originRight: n.originRight,
          bind: n.bind,
          deleted: n.deleted,
          deletedBy: n.deletedBy,
          value: n.value,
        })),
      // Diagnostic-only addition, added while root-causing a Firefox-specific divergence found
      // during Phase 14 DoD verification (tests/regression/R0005-R0007): exposes connection
      // lifecycle signals so a diverging client's reconnect/backoff behavior can be correlated,
      // over time, against exactly when its node count starts to drift from the server's.
      getReconnectAttemptCount: () => sync.reconnectAttemptCount,
      getConnectionState: () => sync.state.value,
      getReplicaId: () => sync.replicaId,
    };
    return () => {
      unsubscribe();
      sync.disconnect();
    };
  }, [sync]);

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.75em 1em",
          borderBottom: "1px solid #ddd",
        }}
      >
        <strong>Confluence Editor</strong>
        <ConnectionIndicator state={state} />
      </header>
      <EditorView sync={sync} className="editor-root" />
    </div>
  );
}
