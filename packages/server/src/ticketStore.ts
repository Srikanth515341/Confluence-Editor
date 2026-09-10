// Phase 29 — WebSocket admission tickets (API Spec §1.5/§4.10). A small, generic, in-memory
// single-use-token store — the SAME "in-memory, per-process, no multi-instance story yet"
// scoping this project's other short-lived security primitives already disclose
// (rateLimiter.ts's own header comment is the direct precedent; GcConfig/OfflineWindowConfig are
// the same shape one layer up). A ticket's own 30-second default lifetime makes durable storage
// unnecessary — a process restart mid-ticket-lifetime simply invalidates it, which is
// indistinguishable from ordinary expiry to the client (it just requests a fresh one).

import { randomBytes } from "node:crypto";

/** API Spec §4.10's own literal prefix, `"rt_..."` — real-time ticket. */
const TICKET_PREFIX = "rt_";
const TICKET_RANDOM_BYTES = 24; // 192 bits — comfortably unguessable for a 30s-lived, single-use secret.

export function generateTicketId(): string {
  return TICKET_PREFIX + randomBytes(TICKET_RANDOM_BYTES).toString("base64url");
}

interface TicketRecord {
  readonly documentId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly expiresAtMs: number;
  used: boolean;
}

export type ConsumeTicketOutcome =
  | { readonly outcome: "ok"; readonly userId: string; readonly displayName: string }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "already-used" }
  | { readonly outcome: "expired" }
  | { readonly outcome: "wrong-document" };

/**
 * Single-use, 30-second (configurable), scoped-to-one-(document,user) admission tokens
 * (API Spec §4.10). `consume()` burns the ticket on ANY presentation — a wrong-document or
 * already-expired presentation still marks it used, not just a successful one, matching the
 * spec's own literal "single-use" wording read as "the first HELLO that ever presents this
 * string, full stop," not "the first SUCCESSFUL admission" — closing any replay/guessing window
 * a "only successful uses burn it" reading would leave open.
 */
export class InMemoryTicketStore {
  private readonly tickets = new Map<string, TicketRecord>();

  /** `POST /v1/documents/{id}/rt-ticket`'s own issuance — `displayName` is captured now (from the caller's own already-verified JWT claims, httpApp.ts) specifically so `consume()` never needs a second DB round trip just to populate WELCOME's participant list. */
  issue(
    documentId: string,
    userId: string,
    displayName: string,
    ttlMs: number,
    nowMs: number = Date.now(),
  ): { readonly ticket: string; readonly expiresAtMs: number } {
    this.pruneExpired(nowMs);
    const ticket = generateTicketId();
    const expiresAtMs = nowMs + ttlMs;
    this.tickets.set(ticket, { documentId, userId, displayName, expiresAtMs, used: false });
    return { ticket, expiresAtMs };
  }

  /** `gateway.ts`'s own HELLO handler — see this class's own doc comment for the "burns on any presentation" rule. */
  consume(ticket: string, claimedDocumentId: string, nowMs: number = Date.now()): ConsumeTicketOutcome {
    const record = this.tickets.get(ticket);
    if (!record) {
      return { outcome: "not-found" };
    }
    if (record.used) {
      return { outcome: "already-used" };
    }
    record.used = true; // burned regardless of which failure (if any) below fires
    if (nowMs > record.expiresAtMs) {
      return { outcome: "expired" };
    }
    if (record.documentId !== claimedDocumentId) {
      return { outcome: "wrong-document" };
    }
    return { outcome: "ok", userId: record.userId, displayName: record.displayName };
  }

  /** Lazy pruning on every `issue()` call — same bounded-per-call-cost discipline as `InMemoryRateLimiter`'s own pruning, so a long-running process's map stays bounded by recent traffic, not by its entire uptime. */
  private pruneExpired(nowMs: number): void {
    for (const [ticket, record] of this.tickets) {
      // A used-but-not-yet-expired ticket is ALSO safe to prune early — it can never be
      // legitimately consumed again regardless of its own expiry, so there is no reason to keep
      // it resident just to let it expire "naturally."
      if (record.used || nowMs > record.expiresAtMs) {
        this.tickets.delete(ticket);
      }
    }
  }

  /** Test-only introspection — never called by production code. */
  sizeForTesting(): number {
    return this.tickets.size;
  }
}
