import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "./rateLimiter.js";

describe("InMemoryRateLimiter (Phase 26 — Test Plan's own per-IP/per-account throttling requirement)", () => {
  it("allows up to `max` attempts within the window, then rejects the next one", () => {
    const limiter = new InMemoryRateLimiter();
    const rule = { max: 3, windowMs: 1000 };
    expect(limiter.consume("k", rule, 0)).toBe(true);
    expect(limiter.consume("k", rule, 10)).toBe(true);
    expect(limiter.consume("k", rule, 20)).toBe(true);
    expect(limiter.consume("k", rule, 30)).toBe(false); // 4th attempt within the window
  });

  it("a rejected attempt does not itself count toward the limit", () => {
    const limiter = new InMemoryRateLimiter();
    const rule = { max: 1, windowMs: 1000 };
    expect(limiter.consume("k", rule, 0)).toBe(true);
    expect(limiter.consume("k", rule, 10)).toBe(false);
    expect(limiter.consume("k", rule, 20)).toBe(false);
    expect(limiter.countForTesting("k")).toBe(1); // still just the one real, allowed attempt
  });

  it("attempts older than windowMs age out — a rejected key becomes allowed again once the window slides past its old hits", () => {
    const limiter = new InMemoryRateLimiter();
    const rule = { max: 2, windowMs: 1000 };
    expect(limiter.consume("k", rule, 0)).toBe(true);
    expect(limiter.consume("k", rule, 100)).toBe(true);
    expect(limiter.consume("k", rule, 200)).toBe(false); // still within 1000ms of both prior hits
    expect(limiter.consume("k", rule, 1050)).toBe(true); // the t=0 hit has now aged out (1050-0=1050>1000)
  });

  it("different keys are tracked completely independently", () => {
    const limiter = new InMemoryRateLimiter();
    const rule = { max: 1, windowMs: 1000 };
    expect(limiter.consume("account:a@b.com", rule, 0)).toBe(true);
    expect(limiter.consume("account:a@b.com", rule, 1)).toBe(false);
    expect(limiter.consume("account:c@d.com", rule, 1)).toBe(true); // unaffected by a@b.com's own limit
    expect(limiter.consume("ip:1.2.3.4", rule, 1)).toBe(true); // a totally different key namespace
  });

  it("countForTesting reports 0 for a key that has never been consumed", () => {
    const limiter = new InMemoryRateLimiter();
    expect(limiter.countForTesting("never-seen")).toBe(0);
  });
});
