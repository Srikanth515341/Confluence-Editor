// Connection-state indicator (Phase 14 Scope-IN: "see a connection-state
// indicator"). A plain presentational component — `App.tsx` owns the
// subscription to `sync.state` (connectionState.ts's `Observable`) and
// passes the current value down, so this component stays trivially
// testable without a real `SyncClient`.

import type { ConnectionState } from "../sync/connectionState.js";

const LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  synced: "Synced",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

// Colors chosen for at-a-glance status, not for any design system this project has yet.
const COLORS: Record<ConnectionState, string> = {
  connecting: "#b58900",
  synced: "#2e7d32",
  reconnecting: "#b58900",
  offline: "#c62828",
};

export interface ConnectionIndicatorProps {
  readonly state: ConnectionState;
}

export function ConnectionIndicator({ state }: ConnectionIndicatorProps): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4em",
        fontFamily: "system-ui, sans-serif",
        fontSize: "0.85rem",
        padding: "0.25em 0.6em",
        borderRadius: "999px",
        border: `1px solid ${COLORS[state]}`,
        color: COLORS[state],
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "0.6em",
          height: "0.6em",
          borderRadius: "50%",
          backgroundColor: COLORS[state],
        }}
      />
      {LABELS[state]}
    </div>
  );
}
