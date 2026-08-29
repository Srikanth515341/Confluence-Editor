import { describe, expect, it } from "vitest";
import { ConnectionSendQueues } from "./sendQueues.js";

function frame(label: string): Uint8Array {
  return new TextEncoder().encode(label);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * pump() dequeues and starts sending the very first frame the instant a
 * queue transitions from idle to non-idle — real network writes can't be
 * un-sent once started, so once something is "in flight" no reordering is
 * possible for it. That's correct (and unavoidable) production behavior,
 * but it means a test that enqueues everything in one synchronous burst
 * lets whatever landed in the otherwise-idle queue first "jump the line"
 * as the in-flight frame — an artifact of synchronous test setup, not a
 * departure from priority-draining. Every test below that cares about
 * ORDER first primes the queue with a send that blocks until the test
 * explicitly releases it, so every subsequent `enqueue` happens while the
 * queue is genuinely idle-but-busy (nothing draining) — exactly what "N
 * frames already queued" means. `releasePrimer()` lets real draining begin.
 */
function primedQueues(
  sendRaw: (frame: Uint8Array) => Promise<void>,
  isBackpressured: () => boolean = () => false,
): { queues: ConnectionSendQueues; releasePrimer: () => void } {
  let releasePrimer: () => void = () => {};
  const primerGate = new Promise<void>((resolve) => {
    releasePrimer = resolve;
  });
  const queues = new ConnectionSendQueues(async (frameBytes) => {
    const label = new TextDecoder().decode(frameBytes);
    if (label === "__primer__") {
      await primerGate;
      return;
    }
    await sendRaw(frameBytes);
  }, isBackpressured);
  queues.enqueue("control", frame("__primer__")); // channel choice is arbitrary — it never reaches `sent`
  return { queues, releasePrimer };
}

describe("ConnectionSendQueues — priority draining (API/Protocol/Data Spec §3.3)", () => {
  it("uses three separate physical queue objects, not one shared array", () => {
    const { queues } = primedQueues(() => Promise.resolve());

    queues.enqueue("ops", frame("o1"));
    queues.enqueue("control", frame("c1"));
    queues.enqueue("control", frame("c2"));
    queues.enqueue("presence", frame("p1"));
    queues.enqueue("presence", frame("p2"));
    queues.enqueue("presence", frame("p3"));

    // Each queue's length reflects exactly what was pushed to IT, unaffected by the others —
    // still true even though the primer itself is sitting in the control queue's "already sent"
    // slot (in flight, blocked), since it was shifted out before any of these enqueues ran.
    expect(queues.lengths).toEqual({ ops: 1, control: 2, presence: 3 });
  });

  it("sends an operation before 200 already-queued presence frames", async () => {
    const sent: string[] = [];
    const { queues, releasePrimer } = primedQueues(async (frameBytes) => {
      sent.push(new TextDecoder().decode(frameBytes));
    });

    for (let i = 0; i < 200; i++) {
      queues.enqueue("presence", frame(`presence-${i}`));
    }
    queues.enqueue("ops", frame("the-operation"));

    expect(queues.lengths).toEqual({ ops: 1, control: 0, presence: 200 });
    expect(sent).toEqual([]); // nothing has drained yet — everything is genuinely still queued behind the primer

    releasePrimer();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(sent[0]).toBe("the-operation");
    expect(sent).toHaveLength(201);
    expect(queues.lengths).toEqual({ ops: 0, control: 0, presence: 0 });
  });

  it("drains OPS fully, then CONTROL fully, then PRESENCE", async () => {
    const sent: string[] = [];
    const { queues, releasePrimer } = primedQueues(async (frameBytes) => {
      sent.push(new TextDecoder().decode(frameBytes));
    });

    queues.enqueue("presence", frame("p1"));
    queues.enqueue("control", frame("c1"));
    queues.enqueue("ops", frame("o1"));
    queues.enqueue("ops", frame("o2"));
    queues.enqueue("control", frame("c2"));

    releasePrimer();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(sent).toEqual(["o1", "o2", "c1", "c2", "p1"]);
  });

  it("a higher-priority frame enqueued mid-drain preempts a lower-priority backlog, re-evaluated after every single frame sent", async () => {
    const sent: string[] = [];
    const releases: Array<() => void> = [];
    const { queues, releasePrimer } = primedQueues(
      (frameBytes) =>
        new Promise<void>((resolve) => {
          releases.push(() => {
            sent.push(new TextDecoder().decode(frameBytes));
            resolve();
          });
        }),
    );

    queues.enqueue("presence", frame("p1"));
    queues.enqueue("presence", frame("p2"));

    releasePrimer();
    await flushMicrotasks(); // p1 is now shifted out and "in flight", blocked on releases[0]

    // While p1 is in flight, an operation arrives — the pump must choose it next, ahead of p2.
    queues.enqueue("ops", frame("urgent-op"));

    releases[0]?.(); // p1 completes
    await flushMicrotasks();
    releases[1]?.(); // whatever the pump chose next, completes
    await flushMicrotasks();
    releases[2]?.();
    await flushMicrotasks();

    expect(sent).toEqual(["p1", "urgent-op", "p2"]);
  });

  it("PRESENCE sheds the current newest frame before appending a new one under backpressure, leaving OPS/CONTROL untouched", () => {
    const { queues } = primedQueues(
      () => new Promise<void>(() => {}), // never resolves — the primer keeps the queue permanently blocked for this test
      () => true, // always backpressured
    );

    queues.enqueue("presence", frame("p1"));
    queues.enqueue("presence", frame("p2"));
    queues.enqueue("presence", frame("p3"));
    // Under constant backpressure, each new presence enqueue sheds the current newest first:
    // [] -> push p1 -> [p1] -> shed p1, push p2 -> [p2] -> shed p2, push p3 -> [p3]
    expect(queues.lengths.presence).toBe(1);

    queues.enqueue("ops", frame("o1"));
    queues.enqueue("ops", frame("o2"));
    expect(queues.lengths.ops).toBe(2); // OPS is never shed, even under backpressure
  });

  it("a late enqueue after close() is a silent no-op", () => {
    const queues = new ConnectionSendQueues(
      () => Promise.resolve(),
      () => false,
    );
    queues.close();
    queues.enqueue("ops", frame("o1"));
    expect(queues.lengths).toEqual({ ops: 0, control: 0, presence: 0 });
  });
});
