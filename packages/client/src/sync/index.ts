// Browser-side connection manager (Phase 10). No UI, no DOM binding — see
// syncClient.ts's own doc comment for the full scope. API Spec §3.10
// (backoff), §7.9 (unacked queue), §3.7.5 (sequence gaps).

export {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_FACTOR,
  BACKOFF_RESET_AFTER_MS,
  Backoff,
} from "./backoff.js";
export { ObservableValue, type ConnectionState, type Observable } from "./connectionState.js";
export { GAP_RECONNECT_TIMEOUT_MS, SequenceGapTracker } from "./gapTracker.js";
export {
  connectPair,
  runConvergenceWorkload,
  waitForConvergence,
  waitForState,
  type HeadlessPair,
} from "./headlessHarness.js";
export { seedEngineFromSnapshot } from "./snapshotSeed.js";
export {
  PING_INTERVAL_MS,
  SyncClient,
  WS_PATH,
  WS_SUBPROTOCOL,
  type SyncClientOptions,
  type WebSocketLike,
} from "./syncClient.js";
export { UnackedQueue } from "./unackedQueue.js";
export { operationToOpsMessage, toOperations } from "./wireHelpers.js";
