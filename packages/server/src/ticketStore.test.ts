// Phase 29 — WebSocket admission tickets (API Spec §1.5/§4.10, Test Plan SEC-11b/c/d). Pure,
// clock-injectable unit tests — no server/DB needed, mirroring this project's own established
// split (e.g. OfflineWindowTracker, Phase 24) between a fast, deterministic logic suite here and
// a real end-to-end proof over the actual wire protocol in db/tickets.db.test.ts.

import { describe, expect, it } from "vitest";
import { InMemoryTicketStore } from "./ticketStore.js";

describe("InMemoryTicketStore (Phase 29, API Spec §4.10)", () => {
  it("issues a ticket that can be consumed exactly once, for the document it was scoped to", () => {
    const store = new InMemoryTicketStore();
    const { ticket } = store.issue("doc-1", "user-1", "Alice", 30_000, 1_000);
    expect(ticket.startsWith("rt_")).toBe(true);

    const result = store.consume(ticket, "doc-1", 1_500);
    expect(result).toEqual({ outcome: "ok", userId: "user-1", displayName: "Alice" });
  });

  it("SEC-11b: a ticket reused on a second HELLO is rejected with 'already-used', not re-admitted", () => {
    const store = new InMemoryTicketStore();
    const { ticket } = store.issue("doc-1", "user-1", "Alice", 30_000, 1_000);
    expect(store.consume(ticket, "doc-1", 1_500).outcome).toBe("ok");
    expect(store.consume(ticket, "doc-1", 1_600)).toEqual({ outcome: "already-used" });
  });

  it("SEC-11c: a ticket presented after its own TTL has elapsed is rejected as 'expired', tested from both sides of the boundary", () => {
    const store = new InMemoryTicketStore();
    const { ticket: t1 } = store.issue("doc-1", "user-1", "Alice", 30_000, 1_000);
    // Exactly at the boundary (nowMs === expiresAtMs, i.e. elapsed === ttl) is still valid — only
    // a presentation STRICTLY AFTER expiry is rejected.
    expect(store.consume(t1, "doc-1", 31_000).outcome).toBe("ok");

    const { ticket: t2 } = store.issue("doc-1", "user-1", "Alice", 30_000, 1_000);
    expect(store.consume(t2, "doc-1", 31_001)).toEqual({ outcome: "expired" });
  });

  it("SEC-11d: a ticket for document X presented on a socket claiming document Y is rejected as 'wrong-document'", () => {
    const store = new InMemoryTicketStore();
    const { ticket } = store.issue("doc-X", "user-1", "Alice", 30_000, 1_000);
    expect(store.consume(ticket, "doc-Y", 1_500)).toEqual({ outcome: "wrong-document" });
  });

  it("burns the ticket on ANY presentation, even a failing one (single-use is 'first touch,' not 'first success') — a wrong-document attempt cannot be retried against the correct document afterward", () => {
    const store = new InMemoryTicketStore();
    const { ticket } = store.issue("doc-X", "user-1", "Alice", 30_000, 1_000);
    expect(store.consume(ticket, "doc-Y", 1_500).outcome).toBe("wrong-document");
    expect(store.consume(ticket, "doc-X", 1_600)).toEqual({ outcome: "already-used" });
  });

  it("a ticket that was never issued (garbage/guessed string) is rejected as 'not-found'", () => {
    const store = new InMemoryTicketStore();
    expect(store.consume("rt_never-issued", "doc-1", 1_000)).toEqual({ outcome: "not-found" });
  });

  it("issuing a new ticket lazily prunes already-expired/used tickets, keeping the store bounded", () => {
    const store = new InMemoryTicketStore();
    const { ticket: expired } = store.issue("doc-1", "user-1", "Alice", 100, 1_000);
    expect(store.sizeForTesting()).toBe(1);
    // Well past expiry, and a fresh issue() call is what triggers the lazy prune.
    store.issue("doc-1", "user-2", "Bob", 30_000, 50_000);
    expect(store.sizeForTesting()).toBe(1); // the expired one was pruned, only the fresh one remains
    // The pruned ticket is now indistinguishable from one that was never issued.
    expect(store.consume(expired, "doc-1", 50_100)).toEqual({ outcome: "not-found" });
  });
});
