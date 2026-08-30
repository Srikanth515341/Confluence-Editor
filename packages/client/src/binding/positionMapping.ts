import { scalarToUtf16, utf16ToScalar } from "./unicodeOffsets.js";
import { findRunForVis, totalVisibleLength, type RenderRun } from "./renderIndex.js";

export interface DomPosition {
  readonly node: Node;
  readonly offset: number;
}

/**
 * Maps a global visible (scalar) index to a concrete DOM (node, offset)
 * position (API Spec §7.2). Binary search over `index` locates the run in
 * O(log runs), then {@link scalarToUtf16} does a linear scan within just
 * that ONE run's text — never the whole document, however large.
 */
export function visToDom(index: readonly RenderRun[], root: Element, v: number): DomPosition {
  const total = totalVisibleLength(index);
  if (!Number.isInteger(v) || v < 0 || v > total) {
    throw new RangeError(`visToDom: ${v} is out of range [0, ${total}]`);
  }
  if (index.length === 0) {
    // Empty document: no text node exists to point at, so the caret goes into the root itself —
    // exactly the "selection on root" shape API Spec §7.2.3 describes browsers producing here too.
    return { node: root, offset: 0 };
  }
  const found = findRunForVis(index, v);
  if (!found) {
    throw new RangeError(`visToDom: ${v} not found in any run — renderIndex is inconsistent`);
  }
  const { run } = found;
  const localScalar = v - run.startVis;
  const utf16Offset = scalarToUtf16(run.textNode.data, localScalar);
  return { node: run.textNode, offset: utf16Offset };
}

/**
 * The reverse mapping (API Spec §7.2). `node` is either a Text node
 * belonging to one of `index`'s runs, or an Element node — the latter is a
 * real browser selection quirk (§7.2.3), handled by
 * {@link normalizeElementPosition}.
 */
export function domToVis(index: readonly RenderRun[], node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    const runIndex = index.findIndex((r) => r.textNode === textNode);
    if (runIndex === -1) {
      throw new RangeError("domToVis: text node does not belong to any known render run");
    }
    const run = index[runIndex]!;
    const localScalar = utf16ToScalar(run.textNode.data, offset);
    return run.startVis + localScalar;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    return normalizeElementPosition(index, node as Element, offset);
  }
  throw new RangeError(`domToVis: unsupported node type ${node.nodeType}`);
}

/**
 * API Spec §7.2.3's element-node selection cases: an empty editor in
 * Chromium (which inserts a `<br>`), an empty editor in WebKit (selection
 * lands directly on the root element, with `offset` counting CHILD
 * ELEMENTS, not characters), and selection immediately after a
 * browser-inserted `<br>`. All three resolve the same way here: `offset` is
 * a child-node index into `node.childNodes` (exactly what the DOM Range/
 * Selection API means by an element-node offset); walk the children before
 * that index and sum the scalar length each contributes — a run's own Text
 * node contributes its `scalarLen`, anything else (a `<br>`, or any other
 * non-run element) contributes 0.
 *
 * This assumes `node`'s children are exactly this editor's rendered runs in
 * document order, which holds for the flat, single-level editor structure
 * this phase builds (DomWriter never nests a run's Text node inside
 * anything but the root) — true in general only because there is nothing
 * else in scope yet to violate it.
 */
export function normalizeElementPosition(
  index: readonly RenderRun[],
  node: Element,
  offset: number,
): number {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(
      `normalizeElementPosition: offset must be a non-negative integer, got ${offset}`,
    );
  }
  let vis = 0;
  const children = node.childNodes;
  const limit = Math.min(offset, children.length);
  for (let i = 0; i < limit; i++) {
    const child = children[i]!;
    if (child.nodeType === Node.TEXT_NODE) {
      const run = index.find((r) => r.textNode === child);
      if (run) {
        vis += run.scalarLen;
      }
    }
  }
  return vis;
}
