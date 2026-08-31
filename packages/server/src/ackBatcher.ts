// Per-session OP_ACK batching (Phase 16 scope: "up to 64 acks or 20 ms").
// Coalesces individually-added AckEntry items into as few OP_ACK frames as
// possible, flushing whichever limit is hit first — the same "batch
// window" shape as Phase 12's OP_INSERT_RUN wire coalescing, one layer
// later in the pipeline (acks, not inserts). Purely a wire-efficiency
// concern: WHEN an entry is handed to `add()` — before or after the
// operation's own transaction commits — is the write path's (writePath.ts)
// job, not this class's; this class only decides when to actually flush
// whatever's already been added.

import type { AckEntry } from "@collab-editor/protocol";

const ACK_BATCH_MAX_ENTRIES = 64;
const ACK_BATCH_MAX_DELAY_MS = 20;

export class AckBatcher {
  private buffer: AckEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly flush: (entries: readonly AckEntry[]) => void) {}

  add(entries: readonly AckEntry[]): void {
    this.buffer.push(...entries);
    // A single run/batch message can ack far more than 64 entries at once (e.g. a 2,000-
    // character paste) — flush in 64-entry chunks immediately rather than let one `add()` call
    // produce one oversized frame.
    while (this.buffer.length >= ACK_BATCH_MAX_ENTRIES) {
      const batch = this.buffer.splice(0, ACK_BATCH_MAX_ENTRIES);
      this.cancelTimer();
      this.flush(batch);
    }
    if (this.buffer.length > 0 && this.timer === undefined) {
      this.timer = setTimeout(() => this.flushNow(), ACK_BATCH_MAX_DELAY_MS);
    }
  }

  private flushNow(): void {
    this.cancelTimer();
    if (this.buffer.length === 0) {
      return;
    }
    const batch = this.buffer;
    this.buffer = [];
    this.flush(batch);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Called on disconnect (gateway.ts's `ws.on("close", ...)`) — discards whatever's still buffered rather than attempting to send it over a socket that's already gone, and clears the timer so it can't fire after this session no longer exists. */
  close(): void {
    this.cancelTimer();
    this.buffer = [];
  }
}
