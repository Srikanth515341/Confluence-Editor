// Phase 37 (RFC §5 C-14, PRD FR-PS-6/D-14) — the client-side half of the RUM ("Real User
// Monitoring") beacon: "the RUM beacon for local echo (client-only, batched)" per this phase's own
// Scope-IN, generalized to the full "Client (RUM beacon)" metric group this phase's own reference
// table names (binding.reconciliation, binding.desync_error, binding.composition_watchdog_fired,
// binding.indexeddb_unavailable, and local-echo latency). Batches samples and POSTs them to the
// server's own `POST /v1/rum` endpoint (httpApp.ts) — the same shared metrics registry every
// server-side metric already writes into, so the dashboard shows one unified picture.
//
// Deliberately NOT wired to fire on every single event — `reconciliation`/`desync_error` are
// CUMULATIVE counters on `MutationSentinel` (Phase 13's own design, one instance per editor, never
// a page-global), so this beacon polls them on its own flush interval and reports only the DELTA
// since the last flush, exactly the same "counter, not gauge" semantics the server's own
// `metrics.counter(...)` primitive expects.

export interface RumSample {
  readonly name: string;
  readonly value: number;
  readonly kind?: "counter" | "histogram";
}

export interface RumBeaconOptions {
  /** Where to POST batches. Defaults to the relative path `/v1/rum`, assuming this page is served by the same origin as the collab server (true for this project's own dev/demo setup, `scripts/serveApp.mjs` aside — a real deployment behind a different origin would need to override this). */
  readonly endpoint?: string;
  /** How often to flush a non-empty batch. Default 5000ms — frequent enough for a live dashboard to feel responsive, infrequent enough that this is never a meaningful fraction of a real user's own network traffic. */
  readonly flushIntervalMs?: number;
  /** Injectable for tests — defaults to the real global `fetch`. */
  readonly sendFn?: (endpoint: string, body: string) => void;
}

/**
 * Collects samples in memory and flushes them as one batched POST on a fixed interval (never per
 * sample — a beacon that fires once per keystroke would itself become the kind of hot-path
 * overhead this project's own PRD M3 exists to guard against). Uses `navigator.sendBeacon` when
 * available (survives page unload, per its own browser contract) and falls back to a fire-and-
 * forget `fetch` otherwise (e.g. this project's own jsdom test environment, which has no
 * `sendBeacon`). A failed send is silently dropped — a lost metrics sample is never worth risking
 * any visible impact on the actual editing experience.
 */
export class RumBeacon {
  private readonly endpoint: string;
  private readonly flushIntervalMs: number;
  private readonly sendFn: (endpoint: string, body: string) => void;
  private queue: RumSample[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: RumBeaconOptions = {}) {
    this.endpoint = options.endpoint ?? "/v1/rum";
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.sendFn = options.sendFn ?? defaultSend;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    // Never keep a page's own JS runtime "busy" solely for this timer's sake in an environment
    // that supports `unref()` (Node-based test harnesses; browsers have no such concept and
    // silently ignore a missing method here).
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.flush(); // best-effort: send whatever's queued rather than silently dropping it
  }

  recordCounter(name: string, delta = 1): void {
    if (delta <= 0) return;
    this.queue.push({ name, value: delta, kind: "counter" });
  }

  recordTiming(name: string, ms: number): void {
    this.queue.push({ name, value: ms, kind: "histogram" });
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    const samples = this.queue;
    this.queue = [];
    this.sendFn(this.endpoint, JSON.stringify({ samples }));
  }
}

function defaultSend(endpoint: string, body: string): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
      return;
    }
  } catch {
    // fall through to fetch
  }
  if (typeof fetch === "function") {
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      // a lost metrics sample is never worth surfacing to the user
    });
  }
}

export interface AttachRumBeaconDeps {
  readonly beacon: RumBeacon;
  /** Polled once per flush interval; only the DELTA since the last poll is reported. */
  readonly getSentinelMetrics?: () => { readonly reconciliation: number; readonly desync_error: number };
  /** Polled once per flush interval; reports `binding.indexeddb_unavailable` exactly once, the first time this returns `true` (a page-load-lifetime degradation, mirroring `SyncClient.durableQueueUnavailable`'s own "never reset" semantics). */
  readonly getDurableQueueUnavailable?: () => boolean;
}

/**
 * Wires the beacon's own polling loop for the two metrics that are naturally CUMULATIVE state on
 * some other object (`MutationSentinel.metrics`, `SyncClient.durableQueueUnavailable`) rather than
 * a per-event callback (`onWatchdogFired`/`onLocalEcho`, wired directly at their own call sites —
 * see `compositionController.ts`/`inputPipeline.ts`). Returns a cleanup function.
 */
export function attachRumBeaconPolling(deps: AttachRumBeaconDeps): () => void {
  let lastReconciliation = 0;
  let lastDesyncError = 0;
  let reportedIndexeddbUnavailable = false;
  const interval = setInterval(() => {
    if (deps.getSentinelMetrics) {
      const current = deps.getSentinelMetrics();
      deps.beacon.recordCounter("binding.reconciliation", current.reconciliation - lastReconciliation);
      deps.beacon.recordCounter("binding.desync_error", current.desync_error - lastDesyncError);
      lastReconciliation = current.reconciliation;
      lastDesyncError = current.desync_error;
    }
    if (
      deps.getDurableQueueUnavailable &&
      !reportedIndexeddbUnavailable &&
      deps.getDurableQueueUnavailable()
    ) {
      deps.beacon.recordCounter("binding.indexeddb_unavailable", 1);
      reportedIndexeddbUnavailable = true;
    }
  }, 5000);
  (interval as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(interval);
}
