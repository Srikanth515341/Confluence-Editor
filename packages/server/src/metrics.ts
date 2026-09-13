// Phase 37 (RFC §5 C-14, PRD FR-PS-6/D-14, Test Plan §14.1 compensating controls) — the metrics
// registry the Runbook's dashboard and alerting depend on. Deliberately in-process, no
// Prometheus/StatsD dependency: "a lightweight approach... is fine as long as it's real, live,
// and reachable from a phone browser" (this phase's own reference text), and this is a solo/
// portfolio deployment with one server process, not a fleet needing a separate metrics backend.
//
// Three primitives, matching what the Runbook's own metric table actually needs:
//   - Counter: monotonic, `.inc()`. Things that only ever go up (rejections, mismatches).
//   - Gauge: a current value, `.set()`. Things with a "right now" reading (active connections).
//   - Histogram: a bounded reservoir of recent samples, `.record()`, percentiles computed on
//     read. Things measured per-event where the DISTRIBUTION matters (latencies, batch sizes).
//
// Per-DOCUMENT metrics (GC/audit/structure/tombstones — the "Documents" and part of the
// "Convergence"/"GC" groups) are DELIBERATELY NOT stored here at all. They are computed ON READ
// directly from each `DocumentCoordinator`'s own already-tracked state (`lastGcSuccessAt`,
// `engine.stats()`, etc. — see documentCoordinator.ts) by whoever builds the dashboard/JSON
// payload (httpApp.ts) — that state already exists (Phases 18/21/30), and mirroring it into a
// second, parallel registry here would just be two sources of truth that could drift. This
// module is for metrics with no other natural home: connection lifecycle, wire-level latency,
// authz decisions, queue depths, and the client RUM beacon.

const HISTOGRAM_MAX_SAMPLES = 1000;

export class Counter {
  private count = 0;
  inc(n = 1): void {
    this.count += n;
  }
  get value(): number {
    return this.count;
  }
}

export class Gauge {
  private current = 0;
  set(value: number): void {
    this.current = value;
  }
  inc(n = 1): void {
    this.current += n;
  }
  dec(n = 1): void {
    this.current -= n;
  }
  get value(): number {
    return this.current;
  }
}

export interface HistogramSnapshot {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

/**
 * A bounded circular buffer of the most recent `HISTOGRAM_MAX_SAMPLES` values — old samples are
 * silently overwritten, not accumulated forever (a long-running process must not leak memory
 * proportional to total event count). Percentiles are computed on READ (a linear sort over at
 * most 1000 numbers), never maintained incrementally — simple, and cheap enough at dashboard-
 * refresh cadence (seconds, not per-request).
 */
export class Histogram {
  private readonly samples: number[] = new Array<number>(HISTOGRAM_MAX_SAMPLES);
  private writeIndex = 0;
  private filled = 0;

  record(value: number): void {
    this.samples[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % HISTOGRAM_MAX_SAMPLES;
    this.filled = Math.min(this.filled + 1, HISTOGRAM_MAX_SAMPLES);
  }

  snapshot(): HistogramSnapshot {
    if (this.filled === 0) {
      return { count: this.filled, p50: null, p95: null, p99: null };
    }
    const sorted = this.samples.slice(0, this.filled).sort((a, b) => a - b);
    const percentile = (p: number): number => {
      const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
      return sorted[idx]!;
    };
    return {
      count: this.filled,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
    };
  }
}

/**
 * Named lookup-or-create factories, mirroring `logger`'s own plain-singleton shape (this file
 * exports one shared `metrics` instance below) — every call site that wants "the counter named
 * X" just asks for it by name, with no separate registration step, and gets the SAME instance
 * back every time (a `Map`, not a fresh object per call).
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();

  counter(name: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter();
      this.counters.set(name, c);
    }
    return c;
  }

  gauge(name: string): Gauge {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge();
      this.gauges.set(name, g);
    }
    return g;
  }

  histogram(name: string): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram();
      this.histograms.set(name, h);
    }
    return h;
  }

  /** Every registered counter/gauge as `{name: value}`, and every histogram expanded to `${name}_p50`/`_p95`/`_p99`/`_count` — the flat shape the dashboard/JSON endpoint serves directly. */
  snapshot(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const [name, c] of this.counters) {
      out[name] = c.value;
    }
    for (const [name, g] of this.gauges) {
      out[name] = g.value;
    }
    for (const [name, h] of this.histograms) {
      const s = h.snapshot();
      out[`${name}_count`] = s.count;
      out[`${name}_p50`] = s.p50;
      out[`${name}_p95`] = s.p95;
      out[`${name}_p99`] = s.p99;
    }
    return out;
  }
}

/** One process-wide registry — every server module records into this same instance, exactly like every module already logs through the one shared `logger`. */
export const metrics = new MetricsRegistry();

/**
 * Runbook DoD: "every metric is emitted and visible on the dashboard." A counter/gauge/histogram
 * only appears in `MetricsRegistry.snapshot()` once something has actually looked it up by name
 * (the lazy create-on-first-use design above) — which means a metric whose triggering EVENT
 * hasn't happened yet (no operation has ever been rejected, no GC cycle has ever run) would be
 * silently ABSENT from the dashboard rather than present at its natural zero/null value, making
 * "is this metric even wired up" indistinguishable from "nothing has happened yet." Called once,
 * at server startup (httpApp.ts), to pre-touch every metric name this project's own Runbook table
 * names, so the dashboard always shows the complete list from the very first request.
 */
export function registerAllKnownMetricNames(): void {
  const counters = [
    "ws.connection_churn",
    "ws.handshake_incomplete",
    "presence.shed_count",
    "authz.op_rejected_count",
    "authz.identity_mismatch_count",
    "reconcile.offline_window_exceeded_count",
    "binding.reconciliation",
    "binding.desync_error",
    "binding.composition_watchdog_fired",
    "binding.indexeddb_unavailable",
  ];
  const gauges = [
    "ws.active_connections",
    "ws.abnormal_disconnect_rate",
    "ws.upgrade_rejection_rate",
    "reconcile.already_have_ratio",
    "reconcile.failure_rate",
    "queue.ops_depth",
    "queue.presence_depth",
  ];
  const histograms = [
    "op.remote_visibility",
    "op.server_apply",
    "op.commit_latency",
    "presence.latency",
    "reconcile.duration",
    "reconcile.catchup_ops",
    "reconcile.resend_ops",
    "gc.cycle_duration",
    "gc.nodes_collected_per_cycle",
    "engine.replica_bytes",
    "authz.revocation_effect",
    "client.local_echo",
  ];
  for (const name of counters) metrics.counter(name);
  for (const name of gauges) metrics.gauge(name);
  for (const name of histograms) metrics.histogram(name);
}
