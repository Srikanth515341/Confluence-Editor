/**
 * Shared helper for the adversarial suite (Test Plan §2.4/§2.4.1).
 *
 * §2.4.1's rule: any test whose outcome could depend on replica-id
 * ordering must run in ALL orderings, not one. Engine Spec §10.8 showed
 * a missing binding flag is caught only when the combining mark
 * originates on the HIGHER-numbered replica — a test that hardcodes the
 * mark onto replica 1 passes on a broken implementation. This helper
 * exists so that rule is enforced structurally (every ADV-01/04/17/18/19
 * case iterates it) rather than left to each test author to remember.
 */

function permutations(values: readonly number[]): number[][] {
  if (values.length <= 1) {
    return [values.slice()];
  }
  const result: number[][] = [];
  for (let i = 0; i < values.length; i++) {
    const rest = [...values.slice(0, i), ...values.slice(i + 1)];
    for (const tail of permutations(rest)) {
      result.push([values[i] as number, ...tail]);
    }
  }
  return result;
}

/**
 * Calls `fn` once per permutation of `roleCount` distinct replica ids
 * (1..roleCount). For `roleCount === 2` this is exactly the two orderings
 * Test Plan §2.4.1 requires; written generically so a future case needing
 * 3+ order-sensitive roles doesn't need a second helper.
 */
export function forEachReplicaOrdering(
  roleCount: number,
  fn: (replicaIds: readonly number[]) => void,
): void {
  const base = Array.from({ length: roleCount }, (_, i) => i + 1);
  for (const ordering of permutations(base)) {
    fn(ordering);
  }
}

export function cp(ch: string): number {
  const c = ch.codePointAt(0);
  if (c === undefined) {
    throw new Error("empty string passed to cp()");
  }
  return c;
}
