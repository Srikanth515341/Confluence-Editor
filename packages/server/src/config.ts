// Environment config (.env.example's `PORT`/`DATABASE_URL`). JWT_* is also
// listed in .env.example but belongs to auth (Phases 26-29) — not read
// anywhere yet. DATABASE_URL is read as of Phase 15, but only by
// src/db/pool.ts (used by the seed script and by schema.db.test.ts) — no
// coordinator/gateway code opens a database connection yet; that's the
// write path, Phases 16-17.

/**
 * Phase 21 (Engine Spec §7.4/§7.7, Test Plan M8-c/M8-d) — garbage collection tunables, as
 * CONFIGURATION rather than hardcoded constants (this phase's own explicit Scope-IN item for
 * the undo horizon: "as configuration, not a constant" — the proposed 5min/200ops values are
 * flagged in Engine Spec §7.7 itself as "unvalidated," so a deployment needs to be able to
 * change them without a code change). `gcIntervalMs` (the 60s per-document cycle) is grouped
 * here for the same reason, even though the brief's own wording for it is less emphatic.
 */
export interface GcConfig {
  /** Rule 7.3's "5 minutes" half of `min(5 minutes, 200 operations)`. */
  readonly undoHorizonMaxAgeMs: number;
  /** Rule 7.3's "200 operations by that user" half — pre-auth, approximated as "that replica" (see engine.ts's own CollectOptions doc comment). */
  readonly undoHorizonMaxOpsPerReplica: number;
  /** How often each open document's GC cycle runs. */
  readonly gcIntervalMs: number;
  /**
   * Wall-clock safety cap on ONE `collect()` fixpoint sweep (Phase 21 safety net — a
   * pathological long unresolved anchor chain measured at 853s for a single uncapped cycle;
   * CLAUDE.md's Phase 21 entry). Conservative by design: `collect()`'s fixpoint runs entirely
   * synchronously with no `await`, so this bounds how long ONE document's GC can block the
   * ENTIRE Node event loop — every other document's traffic on the same process — not just
   * how long that document's own GC takes.
   */
  readonly gcFixpointBudgetMs: number;
}

export interface ServerConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly gc: GcConfig;
}

const DEFAULT_PORT = 8080;
const DEFAULT_UNDO_HORIZON_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_UNDO_HORIZON_MAX_OPS_PER_REPLICA = 200;
const DEFAULT_GC_INTERVAL_MS = 60 * 1000;
// Conservative: a single document's GC must never meaningfully stall the event loop for other
// documents/clients, even under a pathological anchor chain (see GcConfig's own doc comment).
const DEFAULT_GC_FIXPOINT_BUDGET_MS = 150;

function positiveIntFromEnv(env: NodeJS.ProcessEnv, key: string, defaultValue: number): number {
  const raw = env[key];
  if (raw === undefined) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`loadConfig: ${key} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const raw = env.PORT ?? String(DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`loadConfig: PORT must be an integer in 1..65535, got "${raw}"`);
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("loadConfig: DATABASE_URL is required (see .env.example)");
  }
  const gc: GcConfig = {
    undoHorizonMaxAgeMs: positiveIntFromEnv(
      env,
      "GC_UNDO_HORIZON_MAX_AGE_MS",
      DEFAULT_UNDO_HORIZON_MAX_AGE_MS,
    ),
    undoHorizonMaxOpsPerReplica: positiveIntFromEnv(
      env,
      "GC_UNDO_HORIZON_MAX_OPS_PER_REPLICA",
      DEFAULT_UNDO_HORIZON_MAX_OPS_PER_REPLICA,
    ),
    gcIntervalMs: positiveIntFromEnv(env, "GC_INTERVAL_MS", DEFAULT_GC_INTERVAL_MS),
    gcFixpointBudgetMs: positiveIntFromEnv(
      env,
      "GC_FIXPOINT_BUDGET_MS",
      DEFAULT_GC_FIXPOINT_BUDGET_MS,
    ),
  };
  return { port, databaseUrl, gc };
}
