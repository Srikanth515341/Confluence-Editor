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

export interface HarnessIdentifier {
  readonly c: number;
  readonly r: number;
}

export interface HarnessNode {
  readonly id: HarnessIdentifier;
  readonly value: number;
  readonly parent: HarnessIdentifier | null;
  readonly side: "L" | "R";
  readonly bind: boolean;
  readonly deleted: boolean;
  readonly deletedBy: HarnessIdentifier | null;
}

export interface HarnessInsertOperation {
  readonly kind: "insert";
  readonly id: HarnessIdentifier;
  readonly value: number;
  readonly parent: HarnessIdentifier | null;
  readonly side: "L" | "R";
  readonly bind: boolean;
}

export interface HarnessEngine {
  text(): string;
  stats(): {
    readonly totalElements: number;
    readonly tombstones: number;
    readonly visibleLength: number;
  };
  localInsert(visibleIndex: number, codePoint: number): { readonly id: HarnessIdentifier };
  /** Phase 32 — the visible sequence, in order; `.id` is what a presence anchor/focus identifier is. */
  visible(): readonly { readonly id: HarnessIdentifier }[];
  /** Phase 32 (API Spec §7.5.3) — resolves an anchor identifier back to a live visible index. */
  resolveCaret(id: HarnessIdentifier | null): number;
  /** Phase 34's own IME-02/03 fixtures — full node list (in document order), for seeding a second, independent engine to the same starting content, and for relaying a real remote operation directly (no wire encoding needed, the same "two simulated clients, no real network" technique this project's own DUR-01/audit tests use). */
  readonly nodes: readonly HarnessNode[];
  applyRemote(op: HarnessInsertOperation): unknown;
}

export interface HarnessSyncClient {
  engine: HarnessEngine | null;
  readonly state: { readonly value: string };
  /** TEST-ONLY (SyncClient's own doc comment) — sets `engine` AND flips `state` to "synced" together, bypassing a real handshake. */
  seedForTesting(engine: HarnessEngine): void;
  localInsertText(visibleIndex: number, text: string): readonly HarnessInsertOperation[];
  localDelete(visibleIndex: number, count: number): unknown;
}

export interface HarnessCaretSnapshot {
  readonly anchor: HarnessIdentifier | null;
  readonly focus: HarnessIdentifier | null;
}

export interface HarnessCompositionController {
  readonly isComposing: boolean;
  readonly bufferedRemoteOpsCount: number;
  noteRemoteOpsApplied(): boolean;
  handleCompositionStart(): void;
  handleCompositionUpdate(ev: CompositionEvent): void;
  handleCompositionEnd(ev: CompositionEvent): void;
  dispose(): void;
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

/** Phase 33 — the same `PresenceClientEvent` union `SyncClient.onPresenceEvent` delivers (`sync/syncClient.ts`), loosely typed here since the harness only needs to construct and pass these, never inspect their real shape further. */
export type HarnessPresenceEvent =
  | { readonly kind: "join"; readonly replicaId: number; readonly userId: string; readonly displayName: string; readonly role: number }
  | { readonly kind: "leave"; readonly replicaId: number; readonly reason: number }
  | {
      readonly kind: "update";
      readonly replicaId: number;
      readonly anchor: HarnessIdentifier | null;
      readonly focus: HarnessIdentifier | null;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "roster";
      readonly participants: readonly {
        readonly replicaId: number;
        readonly userId: string;
        readonly displayName: string;
        readonly role: number;
      }[];
    };

export interface HarnessPresenceOverlay {
  handlePresenceEvent(event: HarnessPresenceEvent): void;
  refresh(): void;
  start(): void;
  stop(): void;
  readonly currentTier: string;
  readonly participantCount: number;
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
      visToDom: (index: readonly HarnessRenderRun[], root: Element, v: number) => { node: Node; offset: number };
      domToVis: (index: readonly HarnessRenderRun[], node: Node, offset: number) => number;
      PresenceOverlay: new (deps: {
        editorRoot: Element;
        overlayContainer: HTMLElement;
        getDomWriterIndex: () => readonly HarnessRenderRun[];
        getEngine: () => HarnessEngine | null;
      }) => HarnessPresenceOverlay;
      /** Phase 34 — see compositionController.ts's own doc comment. */
      CompositionController: new (deps: {
        domWriter: HarnessDomWriter;
        sync: HarnessSyncClient;
        sentinel: HarnessMutationSentinel;
        root: Element;
        watchdogMs?: number;
      }) => HarnessCompositionController;
      attachCompositionHandlers: (root: Element, controller: HarnessCompositionController) => () => void;
      captureCaret: (index: readonly HarnessRenderRun[], engine: HarnessEngine) => HarnessCaretSnapshot | null;
      restoreCaret: (
        snapshot: HarnessCaretSnapshot,
        root: Element,
        index: readonly HarnessRenderRun[],
        engine: HarnessEngine,
      ) => void;
    };
  }
}
