import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceUpdateCoalescer, type PresencePosition } from "./presence.js";

const posA: PresencePosition = { anchor: "A", focus: "A", collapsed: true };
const posB: PresencePosition = { anchor: "B", focus: "B", collapsed: true };
const posC: PresencePosition = { anchor: "C", focus: "C", collapsed: true };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("PresenceUpdateCoalescer (API Spec §9.3 points 1-2)", () => {
  it("does not send synchronously — the first send happens only after the 50ms trailing edge", () => {
    const sent: PresencePosition[] = [];
    const c = new PresenceUpdateCoalescer((p) => sent.push(p));
    c.update(posA);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(49);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([posA]);
  });

  it("REPLACES the pending position rather than queuing every update — only the newest is sent", () => {
    const sent: PresencePosition[] = [];
    const c = new PresenceUpdateCoalescer((p) => sent.push(p));
    c.update(posA);
    c.update(posB);
    c.update(posC);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([posC]); // A and B were never sent at all
  });

  it("a sustained stream of updates sends on a steady ~50ms cadence, never faster", () => {
    const sent: PresencePosition[] = [];
    const c = new PresenceUpdateCoalescer((p) => sent.push(p));
    for (let ms = 0; ms < 500; ms += 5) {
      c.update({ anchor: `t${ms}`, focus: `t${ms}`, collapsed: true });
      vi.advanceTimersByTime(5);
    }
    // 500ms of continuous updates at the 50ms cadence yields ~10 sends, never anywhere close to
    // the 100 updates that were actually made (500/5).
    expect(sent.length).toBeGreaterThanOrEqual(8);
    expect(sent.length).toBeLessThanOrEqual(11);
  });

  it("client-side hard cap: drops updates once 20 have been sent within the trailing second, independent of coalescing", () => {
    const sent: PresencePosition[] = [];
    // The injected clock and the fake setTimeout clock are deliberately DECOUPLED here: each
    // iteration advances the real (fake) timer by a full 50ms — enough to force its own,
    // un-coalesced flush every time, isolating the hard-cap check from coalescing entirely — while
    // the RATE-LIMITER's own clock (`fakeNow`) advances by only 1ms per send, so all 25 attempts
    // land inside the SAME 1-second sliding window from the cap's point of view. This is exactly
    // what the injectable `now` parameter exists for.
    let fakeNow = 0;
    const c = new PresenceUpdateCoalescer((p) => sent.push(p), () => fakeNow);
    for (let i = 0; i < 25; i++) {
      c.update({ anchor: `u${i}`, focus: `u${i}`, collapsed: true });
      fakeNow += 1;
      vi.advanceTimersByTime(50);
    }
    expect(sent.length).toBe(20); // exactly the cap — the 21st through 25th were dropped
  });

  it("the hard cap is a genuine sliding window — capacity frees up as old sends age out", () => {
    const sent: PresencePosition[] = [];
    let fakeNow = 0;
    const c = new PresenceUpdateCoalescer((p) => sent.push(p), () => fakeNow);
    for (let i = 0; i < 20; i++) {
      c.update({ anchor: `u${i}`, focus: `u${i}`, collapsed: true });
      fakeNow += 10; // 20 sends inside one 200ms span — well under the cap
      vi.advanceTimersByTime(50);
    }
    expect(sent.length).toBe(20);
    fakeNow += 1000; // now outside the trailing-second window for all 20 prior sends
    c.update(posA);
    vi.advanceTimersByTime(50);
    expect(sent.length).toBe(21);
  });

  it("dispose cancels a pending, not-yet-flushed update", () => {
    const sent: PresencePosition[] = [];
    const c = new PresenceUpdateCoalescer((p) => sent.push(p));
    c.update(posA);
    c.dispose();
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(0);
  });
});
