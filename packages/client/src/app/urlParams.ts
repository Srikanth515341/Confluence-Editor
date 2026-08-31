// URL-driven document identity and server address (Phase 14 Scope-IN: "open
// a document by URL"). Pure functions over a `Location`-shaped input so
// they're testable without a real browser navigation — the app's own
// `App.tsx` calls these against `window.location`/`window.history`.

import { WS_PATH } from "../sync/syncClient.js";

const DOC_PARAM = "doc";
const SERVER_PARAM = "server";

/** The backend's own default port (packages/server/src/config.ts's `DEFAULT_PORT`) — restated here for the same reason SyncClient restates `WS_PATH`/`WS_SUBPROTOCOL`: a client must never depend on `@collab-editor/server`. */
const DEFAULT_SERVER_PORT = 8080;

/**
 * Reads `?doc=<id>` from `search`. Returns `null` if absent or empty — the
 * caller (`getOrCreateDocumentId`) is responsible for minting one and
 * writing it back to the URL; this function itself never mutates anything,
 * so it stays trivially testable.
 */
export function readDocumentId(search: string): string | null {
  const params = new URLSearchParams(search);
  const id = params.get(DOC_PARAM);
  return id && id.length > 0 ? id : null;
}

/**
 * Returns the current `?doc=` value, or mints a fresh one via `newId()` and
 * writes it into the URL (`?doc=<id>`) using `replaceState` — replace, not
 * push, so opening the app with no `?doc=` doesn't leave a back-button
 * entry for the id-less URL. Two browser WINDOWS opened with the SAME
 * `?doc=` value (the manual two-window demo, Phase 14's own DoD) join the
 * same document; opening the app fresh with no `?doc=` always starts a
 * brand-new, empty document.
 */
export function getOrCreateDocumentId(
  location: Pick<Location, "search">,
  replaceUrl: (search: string) => void,
  newId: () => string = () => crypto.randomUUID(),
): string {
  const existing = readDocumentId(location.search);
  if (existing) {
    return existing;
  }
  const id = newId();
  const params = new URLSearchParams(location.search);
  params.set(DOC_PARAM, id);
  replaceUrl(`?${params.toString()}`);
  return id;
}

/**
 * The full WebSocket URL (up to and including {@link WS_PATH}) `SyncClient`
 * connects to. `?server=ws://host:port/v1/rt` is a full override — used by
 * Phase 14's own E2E-CONV suite, which runs the real server on an ephemeral
 * test port behind an in-process delay relay (see e2e/support/delayRelay.ts)
 * and has no other way to tell this app which port to reach. Absent that
 * override, defaults to the SAME host the app itself was served from (so
 * opening the app via any hostname — `localhost`, a LAN IP, ngrok, etc. —
 * still reaches a same-host backend) on {@link DEFAULT_SERVER_PORT}, over
 * `wss:` iff the page itself was loaded over `https:`.
 */
export function getServerUrl(location: Pick<Location, "search" | "protocol" | "hostname">): string {
  const params = new URLSearchParams(location.search);
  const override = params.get(SERVER_PARAM);
  if (override) {
    return override;
  }
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.hostname}:${DEFAULT_SERVER_PORT}${WS_PATH}`;
}
