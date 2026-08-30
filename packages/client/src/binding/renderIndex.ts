/**
 * One contiguous span of the document, backed by exactly one DOM Text node
 * (Scope-IN: "renderIndex: array of { textNode, startVis, scalarLen,
 * utf16Len }, runs capped at 512 scalars"). `startVis`/`scalarLen`/
 * `utf16Len` are mutable — they shift as earlier runs in the array grow,
 * shrink, or split, which is exactly what DomWriter's incremental patch
 * maintenance does rather than rebuilding the whole index from scratch.
 */
export interface RenderRun {
  readonly textNode: Text;
  startVis: number;
  scalarLen: number;
  utf16Len: number;
}

/** Runs are capped at this many Unicode scalar values (Scope-IN). Kept small enough that scalar<->UTF-16 conversion within one run (a linear scan, unicodeOffsets.ts) stays cheap regardless of total document size. */
export const RUN_MAX_SCALARS = 512;

/** The document's total visible (scalar) length, per this render index — the end-of-document position `visToDom` accepts one-past the last run. */
export function totalVisibleLength(index: readonly RenderRun[]): number {
  if (index.length === 0) {
    return 0;
  }
  const last = index[index.length - 1]!;
  return last.startVis + last.scalarLen;
}

/**
 * Binary search (Scope-IN: "visToDom(v) via binary search over
 * renderIndex") for the run containing global visible index `v`. Finds the
 * LAST run whose `startVis <= v`; at an exact run boundary (v equal to both
 * one run's end and the next run's start) this resolves to the START of the
 * later run — a deliberate, consistent tie-break, not left undefined,
 * though {@link domToVis} must (and does) treat both a run's end position
 * and the next run's start position as equal, valid representations of the
 * same boundary regardless of which this function would have picked.
 */
export function findRunForVis(
  index: readonly RenderRun[],
  v: number,
): { readonly run: RenderRun; readonly runIndex: number } | null {
  if (index.length === 0) {
    return null;
  }
  let lo = 0;
  let hi = index.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index[mid]!.startVis <= v) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const run = index[lo]!;
  if (v < run.startVis || v > run.startVis + run.scalarLen) {
    return null; // v is out of range for the whole index (caller's job to validate against totalVisibleLength first)
  }
  return { run, runIndex: lo };
}
