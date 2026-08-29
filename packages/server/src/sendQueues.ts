// Per-connection send-side queueing (API/Protocol/Data Spec §3.3). Two
// logical channels are multiplexed over one physical socket, plus a third
// for the not-yet-built PRESENCE channel; each gets a fully separate
// physical queue (three distinct arrays, not one FIFO with a priority
// field), because §3.3's own worked example is exactly why: "a presence
// burst already enqueued would sit ahead of a later operation" in a single
// prioritized FIFO, whereas draining three independent queues strictly in
// priority order never lets a lower-priority backlog delay a higher-
// priority frame that arrives after it.
//
// This module operates on already-encoded frames (`Uint8Array`) and knows
// nothing about what's inside them — OPS frames are fully specified
// (Phase 7); CONTROL and PRESENCE message content is not (Phases 9, 31),
// so this queue is deliberately payload-agnostic. It only implements the
// generic transport-level behavior §3.3 specifies for all three channels.

export type QueueChannel = "ops" | "control" | "presence";

/**
 * PRESENCE backpressure policy (§3.3: "Shed newest-but-one"). Interpreted
 * as: while the connection is backpressured, enqueuing a new presence
 * frame drops whatever is CURRENTLY the newest frame in the presence queue
 * before appending the new one — so the frame about to become
 * "newest-but-one" (the just-pushed new frame is the new newest; the item
 * that was newest a moment ago becomes newest-but-one) is the one that
 * gets shed. Net effect: the presence queue never grows under sustained
 * backpressure, the very latest presence state always makes it in, and the
 * oldest queued frame is left alone rather than evicted FIFO-style. OPS
 * and CONTROL take the opposite policy under backpressure — "Queue and
 * block" / "Queue" — i.e. no shedding at all; those queues are left
 * unbounded here and rely on the caller to apply real backpressure
 * upstream (e.g. pausing reads) if they grow unreasonably.
 */
function shedForBackpressure(queue: Uint8Array[]): void {
  if (queue.length > 0) {
    queue.pop();
  }
}

/**
 * The three physical send queues for one connection, drained strictly in
 * priority order — OPS fully, then CONTROL, then PRESENCE (§3.3's
 * "Implementation requirement") — re-evaluated from the top after every
 * single frame sent, so a higher-priority frame enqueued mid-drain always
 * preempts whatever lower-priority draining was in progress.
 */
export class ConnectionSendQueues {
  private readonly opsQueue: Uint8Array[] = [];
  private readonly controlQueue: Uint8Array[] = [];
  private readonly presenceQueue: Uint8Array[] = [];
  private draining = false;
  private closed = false;

  constructor(
    /** Sends one frame over the underlying transport; resolves/calls back once the write completes. */
    private readonly sendRaw: (frame: Uint8Array) => Promise<void>,
    /** Whether the underlying transport is currently backpressured (e.g. `ws.bufferedAmount` over a threshold). Consulted only for PRESENCE's shed policy. */
    private readonly isBackpressured: () => boolean,
  ) {}

  enqueue(channel: QueueChannel, frame: Uint8Array): void {
    if (this.closed) {
      return;
    }
    switch (channel) {
      case "ops":
        this.opsQueue.push(frame);
        break;
      case "control":
        this.controlQueue.push(frame);
        break;
      case "presence":
        if (this.isBackpressured()) {
          shedForBackpressure(this.presenceQueue);
        }
        this.presenceQueue.push(frame);
        break;
    }
    void this.pump();
  }

  /** Stops draining — called once the underlying connection is gone, so a late `enqueue` is a silent no-op rather than an error. */
  close(): void {
    this.closed = true;
  }

  /** Test/diagnostic only: current length of each physical queue, proving they are three separate objects rather than one shared array. */
  get lengths(): { readonly ops: number; readonly control: number; readonly presence: number } {
    return {
      ops: this.opsQueue.length,
      control: this.controlQueue.length,
      presence: this.presenceQueue.length,
    };
  }

  private nextFrame(): Uint8Array | undefined {
    if (this.opsQueue.length > 0) {
      return this.opsQueue.shift();
    }
    if (this.controlQueue.length > 0) {
      return this.controlQueue.shift();
    }
    return this.presenceQueue.shift();
  }

  private async pump(): Promise<void> {
    if (this.draining || this.closed) {
      return;
    }
    this.draining = true;
    try {
      for (;;) {
        const frame = this.nextFrame();
        if (frame === undefined) {
          return;
        }
        await this.sendRaw(frame);
      }
    } finally {
      this.draining = false;
    }
  }
}
