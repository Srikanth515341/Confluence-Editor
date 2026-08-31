// Express + WebSocket gateway, Document Coordinator (in-memory, Phase 8).
// Persistence (Phases 15-17) and auth (Phases 26-29) are not built yet —
// state lives only in memory and is lost on restart, which is correct for
// this phase (Scope-IN: "In-memory only").

export const SERVER_PACKAGE_NAME = "@collab-editor/server";

export { loadConfig, type ServerConfig } from "./config.js";
export { logger, type LogFields } from "./logger.js";
export { ConnectionSendQueues, type QueueChannel } from "./sendQueues.js";
export {
  DocumentCoordinator,
  SERVER_REPLICA_ID,
  type CoordinatorSession,
} from "./documentCoordinator.js";
export { toOperations } from "./ingest.js";
export { createHttpApp } from "./httpApp.js";
export { createGateway, WS_PATH, WS_SUBPROTOCOL, type Gateway } from "./gateway.js";
export { createCollabServer, type CollabServer } from "./server.js";
export {
  armPresenceStaleTimer,
  disarmPresenceStaleTimer,
  onPingReceived,
  PING_INTERVAL_MS,
  PRESENCE_STALE_MS,
  SESSION_INACTIVE_MS,
} from "./heartbeat.js";
export {
  assertSnapshotFormAllowed,
  buildSnapshotMessage,
  buildWelcomeMessage,
} from "./handshake.js";

import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createCollabServer } from "./server.js";

// Only start listening when this module is run directly (`node dist/index.js`
// or `tsx src/index.ts`, Phase 14's `pnpm --filter @collab-editor/server run
// dev`) — not when imported by tests, which construct their own
// `createCollabServer()` bound to an ephemeral port. Compares via
// `pathToFileURL`, NOT a hand-built `file://${process.argv[1]}` string:
// `process.argv[1]` is a plain OS path (backslashes and no leading slash on
// Windows — `C:\Users\...\index.ts`), while `import.meta.url` is always a
// proper `file:///C:/Users/...` URL. The naive string-concatenation version
// silently never matched on Windows, so the server never actually started
// this way — caught only by actually running `pnpm run dev` for Phase 14's
// milestone demo, not by any prior phase's tests (all of which construct
// `createCollabServer()` directly and never exercise this branch at all).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = loadConfig();
  const server = createCollabServer();
  void server.listen(config.port);
}
