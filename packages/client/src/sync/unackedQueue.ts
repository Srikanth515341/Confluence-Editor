import { serializeId, type Identifier, type Operation } from "@collab-editor/engine";

/**
 * In-memory unacked queue, keyed by origin stamp (Scope-IN: "In-memory
 * unacked queue keyed by origin stamp (IndexedDB in Phase 22)"). Tracks
 * every locally-originated operation this client has sent but not yet had
 * acknowledged by the server (API Spec §7.9). No real server sends OP_ACK
 * yet (Phase 16 builds persistence/acks), so `ack()` is exercised only by
 * unit tests with synthetic OP_ACK frames this phase — the queue still
 * needs to be correct now so Phase 16 has something to plug into, and so a
 * later phase's resend-on-reconnect logic has a real source of truth for
 * "what has this client sent that it doesn't know landed."
 */
export class UnackedQueue {
  private readonly entries = new Map<string, Operation>();

  add(op: Operation): void {
    this.entries.set(serializeId(op.id), op);
  }

  ack(id: Identifier): void {
    this.entries.delete(serializeId(id));
  }

  has(id: Identifier): boolean {
    return this.entries.has(serializeId(id));
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
