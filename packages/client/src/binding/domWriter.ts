import {
  RUN_MAX_SCALARS,
  findRunForVis,
  totalVisibleLength,
  type RenderRun,
} from "./renderIndex.js";
import { scalarToUtf16 } from "./unicodeOffsets.js";

/**
 * The ONLY module permitted to mutate the editor subtree (Scope-IN) —
 * established now, before there is anything to write, so no later phase
 * (input handling, Phase 12; remote-patch application, Phase 13+) ever
 * reaches for `textNode.data = ...` or `element.appendChild(...)` directly.
 * Every other module that needs the current document shape reads
 * `domWriter.index` (readonly) or calls `visToDom`/`domToVis` against it.
 */
export class DomWriter {
  private root: Element | null = null;
  private runs: RenderRun[] = [];

  /** Set `false` to disable the dev-build consistency assertion (e.g. a production build) — on by default, since no such build distinction exists yet in this project. */
  assertionsEnabled = true;

  /** Current render index — readonly to callers; only DomWriter's own patch methods mutate it. */
  get index(): readonly RenderRun[] {
    return this.runs;
  }

  get rootElement(): Element | null {
    return this.root;
  }

  /** Replaces the entire editor subtree with `initialText`, rebuilding the render index from scratch. */
  mount(root: Element, initialText: string): void {
    this.root = root;
    root.replaceChildren();
    this.runs = [];
    if (initialText.length > 0) {
      this.appendRunsForText(initialText, 0);
    }
    // Deliberately NOT inserting a synthetic <br> for an empty document — leaving root genuinely
    // empty lets DOM-03's tests observe whatever the REAL browser does to an empty contenteditable
    // on focus (Chromium inserts one itself; WebKit does not), rather than a shape we invented.
    this.assertConsistent();
  }

  /**
   * Inserts `text` at visible (scalar) index `visOffset`. `expectedText`,
   * when given, is the document text the CALLER's oracle (a real `Engine`,
   * in this phase's own tests) says the result should be — compared by
   * {@link assertConsistent} in addition to this method's own internal
   * bookkeeping check.
   */
  insertText(visOffset: number, text: string, expectedText?: string): void {
    if (!this.root) {
      throw new Error("DomWriter.insertText: not mounted");
    }
    if (text.length === 0) {
      return;
    }
    const total = totalVisibleLength(this.runs);
    if (!Number.isInteger(visOffset) || visOffset < 0 || visOffset > total) {
      throw new RangeError(`DomWriter.insertText: ${visOffset} is out of range [0, ${total}]`);
    }

    if (this.runs.length === 0) {
      // First content in an empty document (see mount()'s own comment on why no synthetic <br> exists to clean up).
      this.appendRunsForText(text, 0);
      this.assertConsistent(expectedText);
      return;
    }

    const found = findRunForVis(this.runs, visOffset)!;
    const { run, runIndex } = found;
    const localScalar = visOffset - run.startVis;
    const utf16Offset = scalarToUtf16(run.textNode.data, localScalar);
    const newData =
      run.textNode.data.slice(0, utf16Offset) + text + run.textNode.data.slice(utf16Offset);
    run.textNode.data = newData;
    const insertedScalarLen = Array.from(text).length;
    run.scalarLen += insertedScalarLen;
    run.utf16Len = newData.length;

    for (let i = runIndex + 1; i < this.runs.length; i++) {
      this.runs[i]!.startVis += insertedScalarLen;
    }

    if (run.scalarLen > RUN_MAX_SCALARS) {
      this.splitOversizedRun(runIndex);
    }

    this.assertConsistent(expectedText);
  }

  /** Deletes `count` scalars starting at visible index `visOffset`. */
  deleteRange(visOffset: number, count: number, expectedText?: string): void {
    if (!this.root) {
      throw new Error("DomWriter.deleteRange: not mounted");
    }
    if (count <= 0) {
      return;
    }
    const total = totalVisibleLength(this.runs);
    if (!Number.isInteger(visOffset) || visOffset < 0 || visOffset + count > total) {
      throw new RangeError(
        `DomWriter.deleteRange: [${visOffset}, ${visOffset + count}) out of range [0, ${total}]`,
      );
    }

    let remaining = count;
    while (remaining > 0) {
      const found = findRunForVis(this.runs, visOffset);
      if (!found) {
        throw new Error("DomWriter.deleteRange: renderIndex is inconsistent");
      }
      const { run, runIndex } = found;
      const localScalar = visOffset - run.startVis;
      const deletable = Math.min(run.scalarLen - localScalar, remaining);
      const utf16Start = scalarToUtf16(run.textNode.data, localScalar);
      const utf16End = scalarToUtf16(run.textNode.data, localScalar + deletable);
      run.textNode.data =
        run.textNode.data.slice(0, utf16Start) + run.textNode.data.slice(utf16End);
      run.scalarLen -= deletable;
      run.utf16Len = run.textNode.data.length;
      remaining -= deletable;

      if (run.scalarLen === 0) {
        run.textNode.parentNode?.removeChild(run.textNode);
        this.runs.splice(runIndex, 1);
      }

      // Renumber on EVERY iteration, not just once at the end: a deletion spanning multiple runs
      // must see each subsequent run's TRUE current startVis before continuing, or findRunForVis
      // keeps re-resolving `visOffset` to the same (now-exhausted) run forever — an infinite loop
      // this exact bug produced the first time this method was written and tested.
      this.renumberStartVis();
    }
    this.assertConsistent(expectedText);
  }

  /** `concat(index[*].textNode.data)` — DomWriter's own view of the current document text (Scope-IN's dev-assertion formula). */
  materializedText(): string {
    return this.runs.map((r) => r.textNode.data).join("");
  }

  /**
   * Dev-build assertion (Scope-IN), run after every patch:
   * `concat(renderIndex[*].textNode.data) === engine.materialize()`. Two
   * checks:
   *
   * 1. If `expectedOracleText` is given (a real engine's `.text()`, in this
   *    phase's own DOM-01 test), DomWriter's materialized text must match
   *    it exactly — this is the literal formula from Scope-IN.
   * 2. Always: every run's own bookkeeping (`startVis`/`scalarLen`/
   *    `utf16Len`) must match the DOM Text node it describes. This is what
   *    actually fires when a test deliberately corrupts `renderIndex` —
   *    the formula above alone wouldn't catch e.g. a wrong `startVis` that
   *    happens not to change the concatenated text.
   *
   * Throws (rather than merely logging) on either failure — a dev-build
   * assertion that doesn't stop execution isn't one.
   */
  assertConsistent(expectedOracleText?: string): void {
    if (!this.assertionsEnabled) {
      return;
    }
    const actual = this.materializedText();
    if (expectedOracleText !== undefined && actual !== expectedOracleText) {
      throw new Error(
        `DomWriter consistency assertion failed: concat(renderIndex[*].textNode.data) = ${JSON.stringify(actual)}, engine.text() = ${JSON.stringify(expectedOracleText)}`,
      );
    }
    let expectedVis = 0;
    for (const run of this.runs) {
      if (run.startVis !== expectedVis) {
        throw new Error(
          `DomWriter consistency assertion failed: run.startVis = ${run.startVis}, expected ${expectedVis}`,
        );
      }
      const actualScalarLen = Array.from(run.textNode.data).length;
      if (run.scalarLen !== actualScalarLen) {
        throw new Error(
          `DomWriter consistency assertion failed: run.scalarLen = ${run.scalarLen}, but textNode.data has ${actualScalarLen} scalar value(s)`,
        );
      }
      if (run.utf16Len !== run.textNode.data.length) {
        throw new Error(
          `DomWriter consistency assertion failed: run.utf16Len = ${run.utf16Len}, but textNode.data.length = ${run.textNode.data.length}`,
        );
      }
      expectedVis += run.scalarLen;
    }
  }

  private appendRunsForText(text: string, startVis: number): void {
    const scalars = Array.from(text); // one entry per Unicode scalar value — string iteration handles surrogate pairs
    let vis = startVis;
    for (let i = 0; i < scalars.length; i += RUN_MAX_SCALARS) {
      const chunkScalars = scalars.slice(i, i + RUN_MAX_SCALARS);
      const chunkText = chunkScalars.join("");
      const textNode = document.createTextNode(chunkText);
      this.root!.appendChild(textNode);
      this.runs.push({
        textNode,
        startVis: vis,
        scalarLen: chunkScalars.length,
        utf16Len: chunkText.length,
      });
      vis += chunkScalars.length;
    }
  }

  /** Re-chunks one run's text back under {@link RUN_MAX_SCALARS}, reusing the original Text node for the first chunk and inserting new sibling Text nodes for the rest. */
  private splitOversizedRun(runIndex: number): void {
    const run = this.runs[runIndex]!;
    if (run.scalarLen <= RUN_MAX_SCALARS) {
      return;
    }
    const scalars = Array.from(run.textNode.data);
    const chunks: string[] = [];
    for (let i = 0; i < scalars.length; i += RUN_MAX_SCALARS) {
      chunks.push(scalars.slice(i, i + RUN_MAX_SCALARS).join(""));
    }

    const firstChunk = chunks[0]!;
    run.textNode.data = firstChunk;
    run.scalarLen = Array.from(firstChunk).length;
    run.utf16Len = firstChunk.length;

    const newRuns: RenderRun[] = [];
    let vis = run.startVis + run.scalarLen;
    let refNode: Node = run.textNode;
    for (let c = 1; c < chunks.length; c++) {
      const chunkText = chunks[c]!;
      const textNode = document.createTextNode(chunkText);
      refNode.parentNode!.insertBefore(textNode, refNode.nextSibling);
      refNode = textNode;
      const scalarLen = Array.from(chunkText).length;
      newRuns.push({ textNode, startVis: vis, scalarLen, utf16Len: chunkText.length });
      vis += scalarLen;
    }
    this.runs.splice(runIndex + 1, 0, ...newRuns);
  }

  private renumberStartVis(): void {
    let vis = 0;
    for (const run of this.runs) {
      run.startVis = vis;
      vis += run.scalarLen;
    }
  }
}
