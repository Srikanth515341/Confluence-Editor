// Test-only bundle entry point for Phase 12's real-browser input pipeline
// specs (e2e/inputPipeline.spec.ts). Kept OUT of packages/client/src — this
// exists purely to give the e2e bundle access to `Engine` (to seed a
// `SyncClient` directly, the same "no network needed" trick the Vitest
// unit tests use, since `SyncClient.sendFrame` no-ops when `ws` is null)
// alongside the production `DomWriter`/`SyncClient`/`attachInputPipeline`,
// without adding a test-only re-export to the real package's public index.

export { Engine } from "@collab-editor/engine";
export { DomWriter } from "../../src/binding/index.js";
export { SyncClient } from "../../src/sync/syncClient.js";
export { attachInputPipeline } from "../../src/input/inputPipeline.js";
export { MutationSentinel } from "../../src/sentinel/mutationSentinel.js";
