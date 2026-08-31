// Ambient typing for `window.InputHarness` (e2e/support/inputHarness.ts,
// bundled by build-bundle.mjs) — shared by e2e/inputPipeline.spec.ts.
// Deliberately loose (structural, not the real classes' full type surface):
// this file only needs to describe what the specs actually call across the
// `page.evaluate` boundary.

export interface HarnessRenderRun {
  readonly textNode: Text;
  startVis: number;
  scalarLen: number;
  utf16Len: number;
}

export interface HarnessDomWriter {
  mount(root: Element, text: string): void;
  materializedText(): string;
  readonly index: readonly HarnessRenderRun[];
  readonly rootElement: Element | null;
}

export interface HarnessEngine {
  text(): string;
  stats(): {
    readonly totalElements: number;
    readonly tombstones: number;
    readonly visibleLength: number;
  };
}

export interface HarnessSyncClient {
  engine: HarnessEngine | null;
  readonly state: { readonly value: string };
  /** TEST-ONLY (SyncClient's own doc comment) — sets `engine` AND flips `state` to "synced" together, bypassing a real handshake. */
  seedForTesting(engine: HarnessEngine): void;
  localInsertText(visibleIndex: number, text: string): unknown;
  localDelete(visibleIndex: number, count: number): unknown;
}

export interface HarnessSentinelMetrics {
  readonly reconciliation: number;
  readonly desync_error: number;
}

export interface HarnessMutationSentinel {
  readonly metrics: HarnessSentinelMetrics;
  start(): void;
  stop(): void;
  applyPatches(fn: () => void): void;
}

declare global {
  interface Window {
    InputHarness: {
      Engine: new (replicaId: number) => HarnessEngine;
      DomWriter: new () => HarnessDomWriter;
      SyncClient: new (opts: { url: string; documentId: string }) => HarnessSyncClient;
      MutationSentinel: new (deps: {
        root: Element;
        domWriter: HarnessDomWriter;
        getEngineText: () => string | undefined;
      }) => HarnessMutationSentinel;
      attachInputPipeline: (
        root: Element,
        deps: {
          domWriter: HarnessDomWriter;
          sync: HarnessSyncClient;
          sentinel: HarnessMutationSentinel;
        },
      ) => () => void;
    };
  }
}
