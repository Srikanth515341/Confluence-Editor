// Phase 22 DoD — "Keystroke latency unaffected — measure p99 with and
// without the queue" (API Spec §7.9 / PRD M3's 16ms budget). Lives under
// `benchmark/` so the root vitest config's `**/benchmark/**/*.bench.test.ts`
// exclude keeps it out of the default `pnpm test` run, the same pattern
// Phase 19's scaling benchmark and Phase 21's gcSafetyCap benchmark
// already established — a real wall-clock measurement doesn't belong in
// a shared-CPU inner-loop suite.
//
// What's measured: `SyncClient.localInsert()` end to end — mint, apply
// to the engine, `UnackedQueue.add()` (which, when a durable queue is
// attached, synchronously pushes onto a pending array and resets a
// `setTimeout` — no `await`, no I/O, per API Spec §7.9's own "never
// awaited on the keystroke path" requirement), and `sendFrame`. This is
// literally the call a real keystroke triggers via the input pipeline.
// Run with a REAL `fake-indexeddb`-backed durable queue attached (so the
// scheduling overhead is real, not a stubbed no-op) against an otherwise
// IDENTICAL client with no durable queue at all (the pre-Phase-22
// baseline), same document, same operation count, same machine, back to
// back in one process.

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import {
  encodeControlFrame,
  encodeStructureSnapshotBody,
  SessionRole,
  SnapshotForm,
  SyncMode,
} from "@collab-editor/protocol";
import { openDurableQueue } from "../durableQueue.js";
import { SyncClient, type WebSocketLike } from "../syncClient.js";

class NullWebSocket implements WebSocketLike {
  binaryType = "arraybuffer";
  readyState = 1;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(): void {
    // discarded — this benchmark measures local call latency, not real network I/O
  }
  close(): void {}
}

async function makeSyncedClient(withDurableQueue: boolean): Promise<SyncClient> {
  let ws: NullWebSocket;
  const client = new SyncClient({
    url: "ws://bench",
    documentId: randomUUID(),
    createSocket: () => {
      ws = new NullWebSocket();
      return ws;
    },
    openDurableQueue: withDurableQueue ? () => openDurableQueue(new IDBFactory()) : () => null,
  });
  client.connect();
  // The durable-queue branch is genuinely async (a real IndexedDB open) — wait for it to settle
  // and the socket to actually open before proceeding.
  await new Promise((resolve) => setTimeout(resolve, 50));
  ws!.readyState = 1;
  ws!.onopen?.({});
  ws!.onmessage?.({
    data: toArrayBuffer(
      encodeControlFrame({
        kind: "welcome",
        sessionId: randomUUID(),
        replicaId: 1,
        role: SessionRole.EDITOR,
        serverSeq: 0,
        syncMode: SyncMode.SNAPSHOT,
        participants: [],
      }),
    ),
  });
  ws!.onmessage?.({
    data: toArrayBuffer(
      encodeControlFrame({
        kind: "snapshot",
        seq: 0,
        form: SnapshotForm.STRUCTURE,
        body: encodeStructureSnapshotBody([]),
      }),
    ),
  });
  return client;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function percentile(sortedMs: readonly number[], p: number): number {
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx]!;
}

async function measureLocalInsertLatencies(
  client: SyncClient,
  count: number,
): Promise<{ p50: number; p95: number; p99: number }> {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    client.localInsert(i, 0x61 + (i % 26));
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { p50: percentile(samples, 50), p95: percentile(samples, 95), p99: percentile(samples, 99) };
}

describe("Phase 22 DoD — keystroke latency, with vs. without the durable queue", () => {
  it("p99 with a real durable queue attached stays comfortably under PRD M3's 16ms budget, and is not meaningfully worse than without one", async () => {
    const COUNT = 2_000;

    const withoutQueue = await makeSyncedClient(false);
    const baseline = await measureLocalInsertLatencies(withoutQueue, COUNT);

    const withQueue = await makeSyncedClient(true);
    const withDurable = await measureLocalInsertLatencies(withQueue, COUNT);

    console.log(
      `[keystroke-latency] without queue: p50=${baseline.p50.toFixed(3)}ms p95=${baseline.p95.toFixed(3)}ms p99=${baseline.p99.toFixed(3)}ms\n` +
        `[keystroke-latency] with durable queue: p50=${withDurable.p50.toFixed(3)}ms p95=${withDurable.p95.toFixed(3)}ms p99=${withDurable.p99.toFixed(3)}ms`,
    );

    // The DoD's own number (PRD M3): a single keystroke's handling must stay well under 16ms.
    expect(withDurable.p99).toBeLessThan(16);
    // Generous headroom above the theoretical "should be near-identical" expectation (both
    // paths are pure in-memory work plus, for the durable case, one array push and one
    // clearTimeout/setTimeout pair — no I/O, no await) — real timer/GC-pause noise gets room
    // without masking an actual regression, which would look like an order-of-magnitude jump,
    // not a fractional-millisecond one.
    expect(withDurable.p99).toBeLessThan(Math.max(5, baseline.p99 * 5));
  });
});
