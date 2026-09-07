// Phase 26 — a small, generic, in-memory sliding-window rate limiter (Test Plan's own
// "Rate limiting per IP and per account" requirement; API Spec §4.1's `429 rate_limited`).
// In-memory and per-process, the SAME scoping limitation this project's other tunables already
// disclose (GcConfig/OfflineWindowConfig, Phase 21/24) — this project has no multi-instance/
// horizontal-scaling story yet, so a per-process counter is consistent with every other piece of
// server-side state here, not a new gap specific to this file.

export interface RateLimitRule {
  readonly max: number;
  readonly windowMs: number;
}

/**
 * Sliding-window LOG (not a fixed-window counter): stores each attempt's own timestamp and
 * prunes everything older than `windowMs` on every check. Chosen over a fixed-window counter
 * specifically to avoid the classic fixed-window boundary flaw (a burst straddling the reset
 * boundary can admit close to 2x `max` attempts in a short span) — worth the small extra memory
 * per key for a security-sensitive limiter, unlike, say, a metrics counter where that flaw would
 * be harmless.
 */
export class InMemoryRateLimiter {
  private readonly hits = new Map<string, number[]>();

  /**
   * Records this attempt AND reports whether it's allowed, in one call — a rate limiter that
   * only checked without recording would let an attacker retry instantly forever without ever
   * actually being counted. Returns `true` (and records the hit) if under `rule.max` within
   * `rule.windowMs`; returns `false` (does NOT record — a rejected attempt shouldn't itself
   * count against the caller a second time) otherwise.
   */
  consume(key: string, rule: RateLimitRule, nowMs: number = Date.now()): boolean {
    const cutoff = nowMs - rule.windowMs;
    const existing = this.hits.get(key);
    // Pruning on every access (rather than a separate periodic sweep) is what keeps a key's own
    // array bounded regardless of how long this process runs — the ONE disclosed, accepted gap
    // is that a key which is checked ONCE and never again keeps its (now-tiny, single-element)
    // array resident forever; a real deployment with unboundedly many distinct IPs/accounts over
    // a long uptime would eventually want a periodic full-map sweep too, not implemented here
    // (the same class of "known, disclosed, not chased" scope boundary as OfflineWindowConfig's
    // own map-growth footnotes elsewhere in this project).
    const pruned = existing ? existing.filter((ts) => ts > cutoff) : [];
    if (pruned.length >= rule.max) {
      if (pruned.length !== existing?.length) this.hits.set(key, pruned);
      return false;
    }
    pruned.push(nowMs);
    this.hits.set(key, pruned);
    return true;
  }

  /** Test-only introspection — never called by production code. */
  countForTesting(key: string): number {
    return this.hits.get(key)?.length ?? 0;
  }
}
