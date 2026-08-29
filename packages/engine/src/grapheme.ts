/**
 * Cluster-continuation classifier — API Spec §7.4.4, realizing Engine Spec
 * Definition 2.5. Lives in the engine (not the binding layer) because
 * `bind` is a NODE FIELD the engine itself reasons about at integration
 * time: the disambiguator's tie-break (Engine Spec §4.4, Invariant I8)
 * ranks a cluster-continuing node nearer its left origin than any ordinary
 * node, which is the entire mechanism that keeps a concurrent insert from
 * splitting a grapheme cluster. The binding layer only ever CALLS this
 * once, when constructing a local Insert (Phase 3+); it must never
 * reimplement the classification itself, or the two could silently
 * disagree about which scalars bind.
 *
 * A scalar is cluster-continuing iff it cannot begin a grapheme cluster
 * under Unicode UAX #29: a combining mark (Grapheme_Extend), a spacing
 * combining mark (Mc), a zero-width joiner, a variation selector, or a
 * regional-indicator continuation.
 */

const GRAPHEME_EXTEND_OR_MARK = /\p{Grapheme_Extend}|\p{Mn}|\p{Me}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;
const SPACING_COMBINING_MARK = /\p{Mc}/u;

const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_SELECTOR_START = 0xfe00;
const VARIATION_SELECTOR_END = 0xfe0f;
const VARIATION_SELECTOR_SUPPLEMENT_START = 0xe0100;
const VARIATION_SELECTOR_SUPPLEMENT_END = 0xe01ef;

export function isClusterContinuing(codePoint: number): boolean {
  const s = String.fromCodePoint(codePoint);

  return (
    GRAPHEME_EXTEND_OR_MARK.test(s) ||
    codePoint === ZERO_WIDTH_JOINER ||
    (codePoint >= VARIATION_SELECTOR_START && codePoint <= VARIATION_SELECTOR_END) ||
    (codePoint >= VARIATION_SELECTOR_SUPPLEMENT_START &&
      codePoint <= VARIATION_SELECTOR_SUPPLEMENT_END) ||
    REGIONAL_INDICATOR.test(s) ||
    SPACING_COMBINING_MARK.test(s)
  );
}
