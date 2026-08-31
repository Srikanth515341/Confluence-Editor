// The demo app shell (Phase 14). Exported for testability (App.test.tsx)
// only — NOT re-exported from packages/client/src/index.ts's library
// barrel, the same "bootstrap concerns stay out of the library surface"
// line e2e/ and app/main.tsx's own side effect already draw.

export { App } from "./App.js";
export { ConnectionIndicator, type ConnectionIndicatorProps } from "./ConnectionIndicator.js";
export { getOrCreateDocumentId, getServerUrl, readDocumentId } from "./urlParams.js";
