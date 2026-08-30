// MutationSentinel — DOM reconciliation (Phase 13). API Spec §7.7 (the
// sentinel), §11.11 (why takeRecords() must be synchronous); PRD FR-CE-14;
// RFC R5 (the risk this whole mechanism exists to catch: SOME code path
// other than DomWriter mutates the editor subtree — a browser extension,
// devtools, a future bug in this project's own code — and the DOM silently
// drifts from the engine's authoritative content). The engine is always
// authoritative: reconciliation never asks "what did the foreign mutation
// intend," it simply re-renders from `engine.text()` and discards whatever
// the foreign write did.

import { domToVis, totalVisibleLength, visToDom, type DomWriter } from "../binding/index.js";

/**
 * Reconciliation/desync counts, queryable at any time via
 * {@link MutationSentinel.metrics} (Scope-IN: "a real metric, not a log
 * line"). Per-instance rather than a page-global singleton — deliberately:
 * a global mutable counter would leak state across tests (and across
 * multiple editors on one page, once that's ever a real scenario) the same
 * way a shared module-level counter would, which this project's other
 * metrics-shaped state (e.g. `ClockEvent` logs, Phase 4) has always avoided
 * by attaching to a specific instance instead.
 */
export interface SentinelMetrics {
  /** Number of times a foreign (non-DomWriter) DOM mutation was detected and reverted. RFC R5's only early-warning instrument. */
  readonly reconciliation: number;
  /** Number of times a reconciliation's own re-render still didn't match `engine.text()` afterward — a genuine bug signal, never expected to fire on a correct DomWriter. */
  readonly desync_error: number;
}

export interface MutationSentinelDeps {
  readonly root: Element;
  readonly domWriter: DomWriter;
  /** Reads the CURRENT authoritative document text. `undefined` before the client has ever synced — reconciliation has nothing to reconcile against yet. */
  readonly getEngineText: () => string | undefined;
}

/**
 * Watches `root` for any DOM mutation NOT made through {@link applyPatches}
 * and reverts it by re-rendering from the engine's materialized text
 * (Engine Spec Definition 2.4) — `DomWriter.mount()` reused as-is, since a
 * full reconciliation and a fresh mount are the same operation (replace
 * the whole subtree with what the engine says it should be).
 */
export class MutationSentinel {
  private readonly deps: MutationSentinelDeps;
  private readonly observer: MutationObserver;
  private observing = false;
  private reconciliationCount = 0;
  private desyncErrorCount = 0;

  constructor(deps: MutationSentinelDeps) {
    this.deps = deps;
    this.observer = new MutationObserver((records) => this.handleRecords(records));
  }

  get metrics(): SentinelMetrics {
    return { reconciliation: this.reconciliationCount, desync_error: this.desyncErrorCount };
  }

  /** Begins observing `root` (Scope-IN's exact option set: childList, subtree, characterData, characterDataOldValue). Idempotent. */
  start(): void {
    if (this.observing) {
      return;
    }
    this.observer.observe(this.deps.root, {
      childList: true,
      subtree: true,
      characterData: true,
      characterDataOldValue: true,
    });
    this.observing = true;
  }

  /** Stops observing. Idempotent. */
  stop(): void {
    this.observer.disconnect();
    this.observing = false;
  }

  /**
   * The ONLY sanctioned way any of this project's own code mutates the
   * editor subtree from this phase on — every `DomWriter` call (including
   * this sentinel's own reconciliation re-render) must run inside this
   * wrapper, never bare.
   *
   * takeRecords() must be called SYNCHRONOUSLY here, not guarded by a boolean flag.
   * MutationObserver callbacks are microtasks that run AFTER the synchronous write
   * block finishes and clears any flag, so a flag-based guard makes our own writes
   * look foreign and triggers a full re-render per keystroke — destroying PRD M3.
   * API Spec §7.7.1, §11.11.
   */
  applyPatches(fn: () => void): void {
    try {
      fn();
    } finally {
      this.observer.takeRecords();
    }
  }

  private handleRecords(records: readonly MutationRecord[]): void {
    if (records.length === 0) {
      return; // nothing left after every legitimate write already drained itself via applyPatches()
    }
    this.reconcile();
  }

  /**
   * Capture caret → re-render from `engine.text()` → restore caret →
   * increment the reconciliation metric (Scope-IN's exact ordering). Emits
   * NO engine operation — the DOM is corrected TO match the engine, never
   * the other way around; a foreign mutation is discarded, not interpreted.
   */
  private reconcile(): void {
    const engineText = this.deps.getEngineText();
    if (engineText === undefined) {
      return; // not synced yet — no authoritative text exists to reconcile against
    }
    const visIndex = this.captureCaret();
    this.applyPatches(() => {
      this.deps.domWriter.mount(this.deps.root, engineText);
    });
    this.restoreCaret(visIndex);
    this.reconciliationCount += 1;
    if (this.deps.domWriter.materializedText() !== engineText) {
      // Should be unreachable — mount() builds the render index directly from `engineText` — so
      // this firing at all means reconciliation's OWN re-render failed to restore parity, a
      // strictly worse bug than the foreign mutation it was trying to fix. Scope-IN's
      // "renderIndex disagrees with materialize()" metric exists specifically to surface that.
      this.desyncErrorCount += 1;
    }
  }

  /**
   * Best-effort: a foreign mutation may have altered the DOM in a shape
   * `domWriter.index` (still describing the PRE-mutation structure) can't
   * resolve a position against — `domToVis` can throw in that case (an
   * unknown text node, an out-of-range offset). Falling back to 0 is a
   * defensible default (the alternative, throwing out of a MutationObserver
   * callback, would abort reconciliation entirely and leave the corrupted
   * DOM in place), not a silent guess dressed up as a real caret position.
   */
  private captureCaret(): number {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      return 0;
    }
    try {
      const range = sel.getRangeAt(0);
      return domToVis(this.deps.domWriter.index, range.startContainer, range.startOffset);
    } catch {
      return 0;
    }
  }

  /** Restores the caret after re-rendering, clamped to the NEW document's length (the reconciled text may be shorter/longer than what the caret was captured against). */
  private restoreCaret(visIndex: number): void {
    const sel = window.getSelection();
    if (!sel) {
      return;
    }
    const total = totalVisibleLength(this.deps.domWriter.index);
    const clamped = Math.max(0, Math.min(visIndex, total));
    const pos = visToDom(this.deps.domWriter.index, this.deps.root, clamped);
    const range = document.createRange();
    range.setStart(pos.node, pos.offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}
