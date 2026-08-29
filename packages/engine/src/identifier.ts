/**
 * An identifier is a pair (c, r): a Lamport counter and a replica id.
 * Engine Spec Definition 3.1.
 */
export interface Identifier {
  readonly c: number;
  readonly r: number;
}

/**
 * Strict total order on identifiers (Engine Spec Definition 3.2):
 *   a ≺ b  iff  (a.c < b.c)  or  (a.c === b.c  and  a.r < b.r)
 *
 * This is lexicographic order on ℕ⁺ × ℕ⁺, so it is total, irreflexive, and
 * transitive by construction — the comparison reads only the two
 * identifiers, never local state, arrival order, or a clock (PRD FR-CE-2).
 *
 * Returns a negative number if a ≺ b, positive if b ≺ a, and 0 iff the two
 * identifiers are equal. Engine Spec I1 guarantees two DISTINCT identifiers
 * are never equal in a correct system, so 0 in practice only ever occurs
 * when comparing an identifier to itself.
 */
export function compareIds(a: Identifier, b: Identifier): number {
  if (a.c !== b.c) {
    return a.c - b.c;
  }
  return a.r - b.r;
}

/** Serializes an identifier to a stable map key. Engine Spec §2.2's K map is keyed on exactly this. */
export function serializeId(id: Identifier): string {
  return `${id.c}:${id.r}`;
}
