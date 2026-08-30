// DOM render model and position mapping (Phase 11). API Spec §7.1
// (architecture), §7.2 (position mapping), §11.10. Input handling (Phase
// 12), the sentinel (Phase 13), and cursor transformation (Phase 32) are
// NOT built here — this phase only establishes DomWriter as the sole
// mutator of the editor subtree, the render index, and the bidirectional
// visible-index <-> DOM-position mapping.

export { DomWriter } from "./domWriter.js";
export {
  RUN_MAX_SCALARS,
  findRunForVis,
  totalVisibleLength,
  type RenderRun,
} from "./renderIndex.js";
export {
  type DomPosition,
  domToVis,
  normalizeElementPosition,
  visToDom,
} from "./positionMapping.js";
export { isInsideSurrogatePair, scalarToUtf16, utf16ToScalar } from "./unicodeOffsets.js";
