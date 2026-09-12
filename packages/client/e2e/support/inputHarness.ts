// Test-only bundle entry point for Phase 12's real-browser input pipeline
// specs (e2e/inputPipeline.spec.ts). Kept OUT of packages/client/src — this
// exists purely to give the e2e bundle access to `Engine` (to seed a
// `SyncClient` directly, the same "no network needed" trick the Vitest
// unit tests use, since `SyncClient.sendFrame` no-ops when `ws` is null)
// alongside the production `DomWriter`/`SyncClient`/`attachInputPipeline`,
// without adding a test-only re-export to the real package's public index.

export { Engine } from "@collab-editor/engine";
export { DomWriter, visToDom, domToVis } from "../../src/binding/index.js";
export { SyncClient } from "../../src/sync/syncClient.js";
export { attachInputPipeline } from "../../src/input/inputPipeline.js";
export { MutationSentinel } from "../../src/sentinel/mutationSentinel.js";
// Phase 33 (Test Plan PRES-02/PRES-07) — the real-browser half of presence rendering needs REAL
// text layout (`getClientRects()` genuinely wrapping across multiple lines, a real `scroll`/
// `resize`-triggered reflow), which jsdom cannot provide (see `presenceOverlay.test.ts`'s own
// header comment for exactly what jsdom mocks instead). Bundled here rather than a separate entry
// point, the same "reuse the existing bundle rather than add a new esbuild build step" choice this
// file already made for every export above.
export { PresenceOverlay } from "../../src/presence/presenceOverlay.js";
