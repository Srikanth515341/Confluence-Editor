// The engine counts Unicode SCALAR VALUES; the DOM counts UTF-16 CODE UNITS.
// They differ for every character outside the BMP. Using String.length here
// works for the entire ASCII test suite and breaks on the first emoji, placing
// the caret inside a surrogate pair. API Spec §7.2.2, §11.10.
//
// JS's `for...of` (and spread) over a string already iterates by CODE POINT,
// not code unit — the string iterator protocol handles surrogate pairs
// correctly by construction — so that's the primitive both conversions below
// are built on, rather than any hand-rolled surrogate arithmetic.

/** Converts a scalar-value offset into `text` to the equivalent UTF-16 code-unit offset (API Spec §7.2.2). */
export function scalarToUtf16(text: string, scalarOffset: number): number {
  if (!Number.isInteger(scalarOffset) || scalarOffset < 0) {
    throw new RangeError(
      `scalarToUtf16: scalarOffset must be a non-negative integer, got ${scalarOffset}`,
    );
  }
  let utf16 = 0;
  let scalar = 0;
  for (const ch of text) {
    if (scalar === scalarOffset) {
      return utf16;
    }
    scalar += 1;
    utf16 += ch.length; // 1 for a BMP code point, 2 for an astral one (a surrogate pair)
  }
  if (scalar === scalarOffset) {
    return utf16; // offset at the very end of `text`
  }
  throw new RangeError(
    `scalarToUtf16: offset ${scalarOffset} exceeds ${scalar} scalar value(s) in text`,
  );
}

/** Converts a UTF-16 code-unit offset into `text` to the equivalent scalar-value offset (API Spec §7.2.2). Throws if `utf16Offset` lands strictly inside a surrogate pair — that is never a valid position in either counting system. */
export function utf16ToScalar(text: string, utf16Offset: number): number {
  if (!Number.isInteger(utf16Offset) || utf16Offset < 0) {
    throw new RangeError(
      `utf16ToScalar: utf16Offset must be a non-negative integer, got ${utf16Offset}`,
    );
  }
  let utf16 = 0;
  let scalar = 0;
  for (const ch of text) {
    if (utf16 === utf16Offset) {
      return scalar;
    }
    if (utf16Offset < utf16 + ch.length) {
      throw new RangeError(
        `utf16ToScalar: offset ${utf16Offset} splits a surrogate pair at UTF-16 index ${utf16}`,
      );
    }
    utf16 += ch.length;
    scalar += 1;
  }
  if (utf16 === utf16Offset) {
    return scalar; // offset at the very end of `text`
  }
  throw new RangeError(
    `utf16ToScalar: offset ${utf16Offset} exceeds ${utf16} UTF-16 code unit(s) in text`,
  );
}

/**
 * True iff `offset` (a UTF-16 code-unit index into `text`) falls strictly
 * between the two halves of a surrogate pair. Deliberately independent of
 * {@link scalarToUtf16}/{@link utf16ToScalar}'s own logic — computed by
 * directly inspecting code units via `charCodeAt` — so a test asserting "the
 * caret is never inside a surrogate pair" (Test Plan DOM-01) is a real
 * cross-check against those two functions, not a tautology that would pass
 * even if both had the identical bug.
 */
export function isInsideSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) {
    return false;
  }
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  const isHighSurrogate = before >= 0xd800 && before <= 0xdbff;
  const isLowSurrogate = after >= 0xdc00 && after <= 0xdfff;
  return isHighSurrogate && isLowSurrogate;
}
