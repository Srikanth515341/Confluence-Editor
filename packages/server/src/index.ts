// Express + WebSocket gateway, Document Coordinator. Persistence is real
// as of Phase 16 (operations are durably committed before being
// acknowledged — API Spec §6.3) when run directly, below, via a real
// `PostgresOperationStore`. Real user accounts/login (API Spec §4.1/§4.2)
// are built as of Phase 26 — POST /v1/auth/login, /refresh, /logout.
// Phase 27 adds the REST document lifecycle (create/list/get/rename/
// revoke-access, API Spec §4.3-§4.6/§4.16) behind the SAME real Bearer-
// token auth (authMiddleware.ts) — but the WebSocket gateway's own
// handshake still does NOT verify an access token (that remains a later
// phase — see gateway.ts's own `testOnlyQueueRoleOverride` citations for
// the still-standing no-auth-on-the-WS-path stance).

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
  buildAlreadyHaveMessage,
  buildCatchupMessages,
  buildSnapshotMessage,
  buildWelcomeMessage,
  chunkCatchupOperations,
  decideSyncMode,
} from "./handshake.js";
export {
  InMemoryOperationStore,
  PostgresOperationStore,
  type OperationStore,
} from "./db/operationStore.js";
export { createPool, type DbPool } from "./db/pool.js";
export { AckBatcher } from "./ackBatcher.js";
export {
  isAckBeforeCommitMutationActive,
  processIncomingOperation,
  sendOpReject,
  type WritePathTestHooks,
} from "./writePath.js";
export { auditDocument, replayThrough, type AuditOptions, type AuditResult } from "./audit.js";
export {
  DEFAULT_AUDIT_INTERVAL_MS,
  startAuditScheduler,
  type AuditScheduler,
} from "./auditScheduler.js";
export { startGcScheduler, runOneDocument as runOneGcCycle, type GcScheduler } from "./gcScheduler.js";
export {
  startOfflineWindowScheduler,
  runOneDocument as runOneOfflineWindowSweep,
  type OfflineWindowScheduler,
} from "./offlineWindowScheduler.js";
export type { GcConfig, OfflineWindowConfig } from "./config.js";
export {
  ALL_CRASH_SITES,
  armCrashSite,
  disarmCrashSite,
  SimulatedCrash,
  type CrashSite,
} from "./testOnlyCrashInjection.js";
export { writeSnapshotNow } from "./snapshotter.js";
export type { AuthConfig, RateLimitRule } from "./config.js";
export { hashPassword, verifyPassword, getDummyPasswordHash } from "./passwordHash.js";
export {
  accessTokenTtlSeconds,
  signAccessToken,
  verifyAccessToken,
  generateRawRefreshToken,
  hashRefreshToken,
  type AccessTokenClaims,
} from "./tokens.js";
export { InMemoryRateLimiter } from "./rateLimiter.js";
export {
  attemptLogin,
  issueAccessToken,
  createRefreshFamily,
  rotateRefreshToken,
  revokeRefreshFamilyByRawToken,
  type IssuedRefreshToken,
  type RotateRefreshTokenResult,
} from "./authService.js";
export {
  findUserByEmail,
  findUserById,
  insertRefreshToken,
  findRefreshTokenByHash,
  markRefreshTokenUsed,
  revokeFamily,
  type UserRow,
  type RefreshTokenRow,
} from "./db/authStore.js";
export { verifyAccessTokenDetailed, type AccessTokenVerification } from "./tokens.js";
export { requireAuth, type AuthLocals } from "./authMiddleware.js";
export { sendError, requestIdMiddleware, type ErrorEnvelopeDetails, type RequestIdLocals } from "./restErrors.js";
export {
  createDocument,
  getDocumentById,
  getUserRole,
  listPermissions,
  updateDocumentTitle,
  revokeDocumentAccess,
  listDocumentsForUser,
  searchUsers,
  findIdempotencyRecord,
  saveIdempotencyRecord,
  type DocumentRole,
  type DocumentRow,
  type PermissionEntry,
  type DocumentListEntry,
  type ListDocumentsInput,
  type SearchUserRow,
  type IdempotencyRecord,
} from "./db/documentStore.js";
export {
  ALL_DOCUMENT_ROLES,
  DEFAULT_TITLE,
  MAX_TITLE_LENGTH,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  isDocumentRole,
  maskEmail,
  canonicalJsonStringify,
  hashRequestBody,
  resolveTitleForCreate,
  resolveTitleForUpdate,
  toDocumentSummary,
  createDocumentForUser,
  getDocumentForUser,
  renameDocument,
  deleteDocumentAccess,
  encodeDocumentListCursor,
  decodeDocumentListCursor,
  listDocumentsForUserService,
  searchUsersForResponse,
  type DocumentSummaryResponse,
  type CreateDocumentOutcome,
  type GetDocumentOutcome,
  type PatchDocumentOutcome,
  type DeleteDocumentOutcome,
  type ListDocumentsOutcome,
  type DocumentListItem,
  type SearchUserResult,
} from "./documentService.js";

import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { PostgresOperationStore } from "./db/operationStore.js";
import { createCollabServer } from "./server.js";
import { startAuditScheduler } from "./auditScheduler.js";
import { startGcScheduler } from "./gcScheduler.js";
import { startOfflineWindowScheduler } from "./offlineWindowScheduler.js";

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
  // Real persistence (Phase 16) — every server test still defaults to
  // InMemoryOperationStore (server.ts's own default); only an actually-run
  // server ever talks to a real database. ONE pool, shared between the CRDT write path
  // (via operationStore) and Phase 26's own auth routes — a real server has no reason to open
  // two separate connection pools to the same database.
  const pool = createPool(config.databaseUrl);
  const operationStore = new PostgresOperationStore(pool);
  const server = createCollabServer({
    operationStore,
    auth: { pool, authConfig: config.auth },
  });
  void server.listen(config.port);
  // Phase 18: the continuously-running production control — audits every currently-open
  // document on a fixed interval. Never started for `createCollabServer()` calls elsewhere
  // (every test constructs its own server directly, not through this direct-run block), so no
  // test needs to remember to stop it.
  startAuditScheduler(server.gateway);
  // Phase 21: tombstone garbage collection — same "only the direct-run block starts this"
  // reasoning as the audit scheduler immediately above.
  startGcScheduler(server.gateway, config.gc);
  // Phase 24: the offline-window sweep (Engine Spec §7.6 Rule 7.2) — same reasoning again.
  startOfflineWindowScheduler(server.gateway, config.offlineWindow);
}
