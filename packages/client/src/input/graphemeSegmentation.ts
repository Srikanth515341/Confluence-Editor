// Grapheme-cluster and word boundary resolution for the input pipeline (API
// Spec §7.4.2/§7.4.3). Deliberately independent of DomWriter/renderIndex —
// these functions operate on a plain string (the WHOLE document text,
// `domWriter.materializedText()`) and UTF-16 offsets into it, the same unit
// `Intl.Segmenter` itself reports positions in. The input pipeline converts
// to/from the engine's scalar-index space at its own boundary (via
// `scalarToUtf16`/`utf16ToScalar`, binding/unicodeOffsets.ts) — this module
// never touches scalar indices, so it can't silently duplicate that logic
// and drift from it.
//
// GRA-02 (Test Plan §7.1) requires backspace to remove a WHOLE grapheme
// cluster (e.g. a ZWJ family emoji, several code points) in ONE step, not
// one code point at a time — `Intl.Segmenter(undefined, { granularity:
// "grapheme" })` is the browser's own Unicode-correct cluster boundary
// authority, used here rather than re-deriving cluster boundaries from
// `isClusterContinuing` (Engine Spec Definition 2.5) a second time, which
// exists for a different purpose (the disambiguator's tie-break, Engine
// Spec §4.4) and is not itself a full boundary-finding algorithm.

/** One resolved span of `text`, in UTF-16 code-unit offsets — the same unit `Intl.Segmenter` reports. */
export interface TextSpan {
  readonly utf16Start: number;
  readonly utf16End: number;
  readonly text: string;
}

function segmentsOf(text: string, granularity: "grapheme" | "word"): Intl.SegmentData[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity }).segment(text));
}

/**
 * The grapheme cluster ending exactly at `utf16Offset` — the cluster
 * `deleteContentBackward` (API Spec §7.4.2) removes when the caret sits at
 * `utf16Offset` with no active selection. Returns `null` at the very start
 * of `text` (nothing to delete) or if `utf16Offset` does not land on a
 * cluster boundary (a caller bug — a real caret position always does).
 */
export function clusterBefore(text: string, utf16Offset: number): TextSpan | null {
  if (utf16Offset <= 0) {
    return null;
  }
  for (const seg of segmentsOf(text, "grapheme")) {
    const end = seg.index + seg.segment.length;
    if (end === utf16Offset) {
      return { utf16Start: seg.index, utf16End: end, text: seg.segment };
    }
  }
  return null;
}

/** The grapheme cluster starting exactly at `utf16Offset` — mirrors {@link clusterBefore} for `deleteContentForward`. */
export function clusterAfter(text: string, utf16Offset: number): TextSpan | null {
  if (utf16Offset >= text.length) {
    return null;
  }
  for (const seg of segmentsOf(text, "grapheme")) {
    if (seg.index === utf16Offset) {
      return { utf16Start: seg.index, utf16End: seg.index + seg.segment.length, text: seg.segment };
    }
  }
  return null;
}

/**
 * The span `deleteWordBackward` (API Spec §7.4.2, "use Intl.Segmenter
 * 'word', not a regex") removes: walk backward from `utf16Offset` over any
 * non-word-like segments immediately preceding it (whitespace/punctuation),
 * then consume the one word-like segment before those — mirroring the
 * common "delete trailing separator, then the word" shape of Ctrl+Backspace.
 * If nothing word-like precedes the caret (e.g. only leading whitespace),
 * falls back to deleting just the immediately-preceding non-word run rather
 * than nothing, since a Ctrl+Backspace at that position must delete SOME
 * text (an application-level call — Intl.Segmenter defines cluster
 * boundaries, not this fallback policy, which no reference text specifies).
 */
export function wordBefore(text: string, utf16Offset: number): TextSpan | null {
  if (utf16Offset <= 0) {
    return null;
  }
  const segs = segmentsOf(text, "word").filter((s) => s.index + s.segment.length <= utf16Offset);
  if (segs.length === 0) {
    return null;
  }
  let i = segs.length - 1;
  while (i >= 0 && !segs[i]!.isWordLike) {
    i -= 1;
  }
  const start = i >= 0 ? segs[i]!.index : segs[segs.length - 1]!.index;
  return { utf16Start: start, utf16End: utf16Offset, text: text.slice(start, utf16Offset) };
}

/** Mirrors {@link wordBefore} for `deleteWordForward`. */
export function wordAfter(text: string, utf16Offset: number): TextSpan | null {
  if (utf16Offset >= text.length) {
    return null;
  }
  const segs = segmentsOf(text, "word").filter((s) => s.index >= utf16Offset);
  if (segs.length === 0) {
    return null;
  }
  let i = 0;
  while (i < segs.length && !segs[i]!.isWordLike) {
    i += 1;
  }
  const last = i < segs.length ? segs[i]! : segs[segs.length - 1]!;
  const end = last.index + last.segment.length;
  return { utf16Start: utf16Offset, utf16End: end, text: text.slice(utf16Offset, end) };
}

/**
 * The start of the "line" containing `utf16Offset`, for
 * `deleteSoftLineBackward`/`deleteHardLineBackward` (API Spec §7.4.2). This
 * editor has no line-wrapping/rendering concept yet (a flat run of text,
 * Phase 11) — no reference text distinguishes "soft" from "hard" line
 * without one, so both are treated identically here: "line" means "since
 * the previous U+000A or the start of the document." This is a documented,
 * defensible application-level call in the same vein as earlier phases'
 * WELCOME-membership/documentId-binding decisions, not a byte-layout
 * invention — revisit once a later phase actually renders soft wrapping.
 */
export function lineStartBefore(text: string, utf16Offset: number): number {
  const nl = text.lastIndexOf("\n", utf16Offset - 1);
  return nl === -1 ? 0 : nl + 1;
}
