// Connection-state indicator (Phase 14 Scope-IN: "see a connection-state
// indicator"). A plain presentational component — `App.tsx` owns the
// subscription to `sync.state` (connectionState.ts's `Observable`) and
// passes the current value down, so this component stays trivially
// testable without a real `SyncClient`.
//
// Phase 22 adds two more presentational-only props, both PRD-mandated
// (FR-OF-3, A-11) and both driven the same way — `App.tsx` subscribes to
// the relevant `SyncClient` observable/value and passes the current
// snapshot down; this component owns no subscription logic of its own.

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

const WARNING_COLOR = "#c62828";

export interface ConnectionIndicatorProps {
  readonly state: ConnectionState;
  /** PRD FR-OF-3: the number of locally-made edits not yet acknowledged by the server (`SyncClient.unsyncedCount`). 0 renders nothing extra — this is meant to be quiet when everything is synced. */
  readonly unsyncedCount?: number;
  /** PRD A-11: true once this client has confirmed IndexedDB is unavailable and degraded to in-memory-only queueing (Test Plan DUR-09 — silent degradation of a durability promise is the failure condition this exists to prevent). */
  readonly durableQueueUnavailable?: boolean;
}

export function ConnectionIndicator({
  state,
  unsyncedCount = 0,
  durableQueueUnavailable = false,
}: ConnectionIndicatorProps): React.JSX.Element {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "0.5em" }}>
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
        {unsyncedCount > 0 && (
          <span data-testid="unsynced-count">
            {" "}
            · {unsyncedCount} unsynced
          </span>
        )}
      </div>
      {durableQueueUnavailable && (
        <div
          role="alert"
          data-testid="durable-queue-warning"
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: "0.8rem",
            padding: "0.25em 0.6em",
            borderRadius: "999px",
            border: `1px solid ${WARNING_COLOR}`,
            color: WARNING_COLOR,
          }}
        >
          Offline storage unavailable — edits will not survive closing this tab
        </div>
      )}
    </div>
  );
}
