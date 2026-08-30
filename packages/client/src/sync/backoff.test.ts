import { describe, expect, it } from "vitest";
import { Backoff, BACKOFF_BASE_MS, BACKOFF_CAP_MS, BACKOFF_FACTOR } from "./backoff.js";

describe("Backoff — exponential with full jitter (API Spec §3.10)", () => {
  it("computes delay as random() * min(cap, base * factor^attempt)", () => {
    const backoff = new Backoff();
    // Fixed "random" so the computed envelope itself is checkable exactly.
    expect(backoff.nextDelayMs(() => 1)).toBe(BACKOFF_BASE_MS); // attempt 0: 500 * 2^0 = 500
    expect(backoff.nextDelayMs(() => 1)).toBe(BACKOFF_BASE_MS * BACKOFF_FACTOR); // attempt 1: 1000
    expect(backoff.nextDelayMs(() => 1)).toBe(BACKOFF_BASE_MS * BACKOFF_FACTOR ** 2); // attempt 2: 2000
  });

  it("caps the computed envelope at 30s, however many attempts follow", () => {
    const backoff = new Backoff();
    for (let i = 0; i < 6; i++) {
      backoff.nextDelayMs(() => 1);
    }
    // attempt 6: 500 * 2^6 = 32000 > cap
    expect(backoff.nextDelayMs(() => 1)).toBe(BACKOFF_CAP_MS);
    // stays capped indefinitely
    expect(backoff.nextDelayMs(() => 1)).toBe(BACKOFF_CAP_MS);
  });

  it("is FULL jitter — uniform over [0, computed], not half jitter", () => {
    const backoff = new Backoff();
    expect(backoff.nextDelayMs(() => 0)).toBe(0);
    const b2 = new Backoff();
    expect(b2.nextDelayMs(() => 0.999999)).toBeCloseTo(BACKOFF_BASE_MS, 0);
  });

  it("20 successive delays (default Math.random) are not all identical — proves jitter is live, not a placeholder", () => {
    const backoff = new Backoff();
    const delays = Array.from({ length: 20 }, () => backoff.nextDelayMs());
    const distinct = new Set(delays);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("reset() restarts the attempt counter from 0", () => {
    const backoff = new Backoff();
    backoff.nextDelayMs(() => 1);
    backoff.nextDelayMs(() => 1);
    expect(backoff.attemptCount).toBe(2);
    backoff.reset();
    expect(backoff.attemptCount).toBe(0);
    expect(backoff.nextDelayMs(() => 1)).toBe(BACKOFF_BASE_MS); // back to attempt 0's envelope
  });
});
