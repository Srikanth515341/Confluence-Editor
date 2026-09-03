// API Spec §7.9 — the durable local queue: an IndexedDB database backing
// UnackedQueue so unacknowledged operations survive a tab close or browser
// crash (PRD FR-OF-2). Exactly the three stores/fields the spec names, no
// more:
//
//   IndexedDB database: obseq
//     store  unacked   keyPath: ['documentId','stampR','stampC']  -- origin stamp
//     store  rejected  keyPath: ['documentId','stampR','stampC']  -- preserved OP_REJECTs
//     store  meta      keyPath: 'documentId'  { lastServerSeq, replicaId, updatedAt }
//
// - Written in applyLocal before or concurrently with transmission, never
//   after (enforced by call-site ordering in syncClient.ts, not here).
// - Removed on OP_ACK: durable store first, then memory (see
//   unackedQueue.ts's `ack()` — the order matters for an accurate unsynced
//   count).
// - Writes are batched on a 200ms TRAILING-EDGE debounce (reset on every
//   new write, per the literal spec wording) and never awaited on the
//   keystroke path (PRD M3's 16ms budget) -- see `scheduleFlush` below. A
//   sustained sub-200ms-interval typing burst defers the actual write
//   until typing pauses; a crash inside that window loses whatever hasn't
//   flushed yet. This is the literal, disclosed DUR-08 behavior, not a bug.
// - If IndexedDB is unavailable (private browsing, quota, disabled), this
//   module resolves to `null` rather than throwing, so the caller
//   (syncClient.ts) can degrade to in-memory queueing and surface PRD
//   A-11's warning explicitly.

import type { Identifier, Operation } from "@collab-editor/engine";
import type { RejectReason } from "@collab-editor/protocol";

const DB_NAME = "obseq";
const DB_VERSION = 1;
const STORE_UNACKED = "unacked";
const STORE_REJECTED = "rejected";
const STORE_META = "meta";

/** Trailing-edge batching window (API Spec §7.9, literal value). */
export const FLUSH_DEBOUNCE_MS = 200;

/** `meta`'s exact field list per API Spec §7.9 -- do not add fields beyond these three. */
export interface QueueMeta {
  readonly documentId: string;
  readonly lastServerSeq: number;
  readonly replicaId: number;
  readonly updatedAt: number;
}

/** One preserved rejection (§3.5.8's RejectReason, plus the shared `detail` string that frame carried). */
export interface RejectedRecord {
  readonly documentId: string;
  readonly op: Operation;
  readonly reason: RejectReason;
  readonly detail: string;
  readonly rejectedAt: number;
}

interface UnackedRow {
  readonly documentId: string;
  readonly stampR: number;
  readonly stampC: number;
  readonly op: Operation;
}

interface RejectedRow {
  readonly documentId: string;
  readonly stampR: number;
  readonly stampC: number;
  readonly op: Operation;
  readonly reason: RejectReason;
  readonly detail: string;
  readonly rejectedAt: number;
}

/**
 * The durable backend `UnackedQueue`/`SyncClient` write through to. An
 * interface (not just the concrete class below) so tests can substitute a
 * trivial fake without touching real IndexedDB machinery at all, mirroring
 * this project's existing `WebSocketLike` injection pattern (syncClient.ts).
 */
export interface DurableQueue {
  loadUnacked(documentId: string): Promise<Operation[]>;
  loadMeta(documentId: string): Promise<QueueMeta | undefined>;
  /** Fire-and-forget: enqueues the write into the next batched flush. Never awaited on the keystroke path (PRD M3). */
  scheduleWriteUnacked(op: Operation, documentId: string): void;
  scheduleRemoveUnacked(id: Identifier, documentId: string): void;
  scheduleWriteRejected(record: RejectedRecord): void;
  scheduleWriteMeta(meta: QueueMeta): void;
  /** Forces any pending batch to commit immediately, resolving once done. Not called on any production keystroke path -- exists for tests and for a deliberate flush point (e.g. right before a known-risky moment), which no Phase 22 call site currently needs. */
  flush(): Promise<void>;
  /** Releases the underlying IDBDatabase handle. Production code never calls this (a live tab keeps its queue open for its whole lifetime) -- exists for test cleanup. */
  close(): void;
}

type PendingWrite =
  | { readonly kind: "putUnacked"; readonly row: UnackedRow }
  | { readonly kind: "deleteUnacked"; readonly key: readonly [string, number, number] }
  | { readonly kind: "putRejected"; readonly row: RejectedRow }
  | { readonly kind: "putMeta"; readonly row: QueueMeta };

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_UNACKED)) {
        db.createObjectStore(STORE_UNACKED, { keyPath: ["documentId", "stampR", "stampC"] });
      }
      if (!db.objectStoreNames.contains(STORE_REJECTED)) {
        db.createObjectStore(STORE_REJECTED, { keyPath: ["documentId", "stampR", "stampC"] });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "documentId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked (another tab holds an older version open)"));
  });
}

/** Real implementation, backed by a real (or fake-indexeddb-provided, in tests) `IDBDatabase`. */
export class IndexedDbDurableQueue implements DurableQueue {
  private pending: PendingWrite[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly db: IDBDatabase) {}

  async loadUnacked(documentId: string): Promise<Operation[]> {
    const rows = await this.getAll<UnackedRow>(STORE_UNACKED);
    // A plain `getAll()` + JS filter, not a composite IDBKeyRange prefix scan: this database
    // holds rows for however many documents a browser profile has ever opened, but any single
    // client's own unacked queue is at most a few hundred entries (PRD FR-OF-2's scope is
    // surviving a crash mid-edit, not an unbounded offline history) -- simplicity and
    // correctness win over a micro-optimization at this data volume.
    return rows
      .filter((row) => row.documentId === documentId)
      .sort((a, b) => a.stampC - b.stampC) // restore in original local mint order (Invariant I0: one replica's own counter only ever increases)
      .map((row) => row.op);
  }

  async loadMeta(documentId: string): Promise<QueueMeta | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_META], "readonly");
      const request = tx.objectStore(STORE_META).get(documentId);
      request.onsuccess = () => resolve(request.result as QueueMeta | undefined);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB meta read failed"));
    });
  }

  scheduleWriteUnacked(op: Operation, documentId: string): void {
    this.pending.push({
      kind: "putUnacked",
      row: { documentId, stampR: op.id.r, stampC: op.id.c, op },
    });
    this.scheduleFlush();
  }

  scheduleRemoveUnacked(id: Identifier, documentId: string): void {
    this.pending.push({ kind: "deleteUnacked", key: [documentId, id.r, id.c] });
    this.scheduleFlush();
  }

  scheduleWriteRejected(record: RejectedRecord): void {
    this.pending.push({
      kind: "putRejected",
      row: {
        documentId: record.documentId,
        stampR: record.op.id.r,
        stampC: record.op.id.c,
        op: record.op,
        reason: record.reason,
        detail: record.detail,
        rejectedAt: record.rejectedAt,
      },
    });
    this.scheduleFlush();
  }

  scheduleWriteMeta(meta: QueueMeta): void {
    this.pending.push({ kind: "putMeta", row: meta });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    // Trailing edge: every new write RESETS the window, per the literal API Spec §7.9 wording
    // ("batched on a 200ms trailing edge") -- see this file's header comment for the accepted
    // consequence (a sustained sub-200ms typing burst defers persistence until it pauses).
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flush().catch(() => {
        // No retry/error-surfacing logic this phase (matches the existing "no retry on
        // OP_REJECT" precedent, syncClient.ts) -- a mid-session write failure (e.g. quota
        // exceeded well after a successful open) is a disclosed, out-of-DoD-scope gap. DUR-09
        // is specifically about UPFRONT unavailability, checked once at `openDurableQueue`.
      });
    }, FLUSH_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.pending.length === 0) {
      return;
    }
    const batch = this.pending;
    this.pending = [];
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction([STORE_UNACKED, STORE_REJECTED, STORE_META], "readwrite");
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB flush failed"));
      tx.oncomplete = () => resolve();
      const unackedStore = tx.objectStore(STORE_UNACKED);
      const rejectedStore = tx.objectStore(STORE_REJECTED);
      const metaStore = tx.objectStore(STORE_META);
      for (const write of batch) {
        switch (write.kind) {
          case "putUnacked":
            unackedStore.put(write.row);
            break;
          case "deleteUnacked":
            unackedStore.delete(write.key as unknown as IDBValidKey);
            break;
          case "putRejected":
            rejectedStore.put(write.row);
            break;
          case "putMeta":
            metaStore.put(write.row);
            break;
        }
      }
    });
  }

  close(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.db.close();
  }

  private getAll<T>(storeName: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([storeName], "readonly");
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error ?? new Error(`IndexedDB getAll(${storeName}) failed`));
    });
  }
}

/**
 * Opens (creating if necessary) the `obseq` database and returns a
 * `DurableQueue`, or `null` if IndexedDB is unavailable (private browsing,
 * quota exceeded, disabled entirely) -- PRD A-11: the caller is expected to
 * degrade to in-memory queueing and display the warning, never fail
 * silently. `factory` defaults to the real global `indexedDB` (present in
 * every real browser and, as of Phase 22, absent in this project's own
 * Vitest/jsdom test environment -- see durableQueue.test.ts, which injects
 * `fake-indexeddb`'s `IDBFactory` instead of relying on jsdom to provide
 * one). Also the DUR-09 injection point: a test can pass a stub `IDBFactory`
 * whose `open()` throws or whose request rejects, exactly matching Test
 * Plan §3.6 DUR-09's own suggested approach over trying to launch real
 * private-browsing browser contexts across three engines.
 */
export function openDurableQueue(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB,
): DurableQueue | null | Promise<DurableQueue | null> {
  if (!factory) {
    // Synchronous, deliberately NOT wrapped in a resolved Promise: `SyncClient.connect()`
    // branches on whether this call returns a Promise at all (`instanceof Promise`) to decide
    // whether it needs to defer `openSocket()` behind a microtask. When there is genuinely no
    // IndexedDB to open (no global at all -- this project's own Vitest/jsdom suite, and any
    // browser context without one), there is nothing to await, so nothing should defer --
    // preserving `connect()`'s exact pre-Phase-22 synchronous timing for that case. See
    // syncClient.ts's `beginConnect` for the consuming side of this contract.
    return null;
  }
  return openDatabase(factory)
    .then((db): DurableQueue => new IndexedDbDurableQueue(db))
    .catch(() => null);
}
