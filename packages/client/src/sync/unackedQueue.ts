import { serializeId, type Identifier, type Operation } from "@collab-editor/engine";
import type { DurableQueue } from "./durableQueue.js";

/**
 * In-memory unacked queue, keyed by origin stamp, now BACKED (Phase 22, API
 * Spec §7.9) by an optional `DurableQueue` (IndexedDB in production) rather
 * than replaced by one — SyncClient still calls the same `add`/`ack`/
 * `values`/`ids` surface it always has; persistence is transparent to every
 * existing call site. `attachDurable`/`restoreEntries` are the only two
 * additions, both called once, at startup, from syncClient.ts's init
 * sequence (Scope-IN: "On document open, read before connecting").
 */
export class UnackedQueue {
  private readonly entries = new Map<string, Operation>();
  private durable: DurableQueue | null = null;
  private documentId: string | null = null;

  /**
   * Wires this queue to a durable backend so every subsequent `add`/`ack`
   * also schedules a batched IndexedDB write/removal (durableQueue.ts).
   * Entries already present (e.g. from a prior `restoreEntries` call) are
   * NOT re-written — they came FROM the durable store, writing them back
   * would be redundant. Called at most once per page load, from
   * syncClient.ts's connect() init sequence, never on every reconnect
   * within the same page session.
   */
  attachDurable(durable: DurableQueue, documentId: string): void {
    this.durable = durable;
    this.documentId = documentId;
  }

  /**
   * Populates entries from a durable restore (a prior session's unacked
   * operations, read back before this client even opens a socket) WITHOUT
   * scheduling redundant durable writes — they are already on disk.
   */
  restoreEntries(ops: readonly Operation[]): void {
    for (const op of ops) {
      this.entries.set(serializeId(op.id), op);
    }
  }

  add(op: Operation): void {
    this.entries.set(serializeId(op.id), op);
    if (this.durable && this.documentId !== null) {
      this.durable.scheduleWriteUnacked(op, this.documentId);
    }
  }

  ack(id: Identifier): void {
    // Durable store first, then memory (API Spec §7.9 — "the order matters for an accurate
    // unsynced count"): scheduling the durable removal before mutating the in-memory map keeps
    // a crash between the two steps from ever leaving the durable store's own record of "what's
    // still unacked" ahead of (more optimistic than) what this client has actually confirmed.
    if (this.durable && this.documentId !== null) {
      this.durable.scheduleRemoveUnacked(id, this.documentId);
      // Flush immediately, don't wait for the 200ms trailing edge. Found necessary (not
      // anticipated in advance) by Phase 22's own DUR-07 e2e test: an operation that gets acked
      // and then the browser crashes before the SCHEDULED removal has flushed leaves it still
      // present in the durable store on the next restart — reconcileOfflineQueue.ts's replay
      // would then RE-MINT and resend it under a brand-new identity, producing a genuine
      // DUPLICATE in the document (not merely a lost keystroke, which is DUR-08's accepted
      // failure mode — this is worse, and not something any DoD scenario sanctions). The
      // 200ms-batching rule (API Spec §7.9) exists to keep WRITES off the keystroke latency
      // path (PRD M3's 16ms budget); handling an inbound OP_ACK is not on that path, so nothing
      // is lost by flushing this one write path immediately. Fire-and-forget (not awaited) —
      // `ack()` stays synchronous, matching every existing call site; a flush failure here
      // degrades no differently than any other durable-write failure (see durableQueue.ts's own
      // "no retry logic this phase" comment).
      this.durable.flush().catch(() => {});
    }
    this.entries.delete(serializeId(id));
  }

  has(id: Identifier): boolean {
    return this.entries.has(serializeId(id));
  }

  get(id: Identifier): Operation | undefined {
    return this.entries.get(serializeId(id));
  }

  get size(): number {
    return this.entries.size;
  }

  values(): Operation[] {
    return Array.from(this.entries.values());
  }

  ids(): Identifier[] {
    return Array.from(this.entries.values(), (op) => op.id);
  }

  clear(): void {
    this.entries.clear();
  }
}
