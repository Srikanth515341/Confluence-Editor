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

import { loadConfig } from "./config.js";
import { createCollabServer } from "./server.js";

// Only start listening when this module is run directly (`node dist/index.js`
// or `tsx src/index.ts`) — not when imported by tests, which construct their
// own `createCollabServer()` bound to an ephemeral port.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const server = createCollabServer();
  void server.listen(config.port);
}
