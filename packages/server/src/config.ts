// Environment config (.env.example's `PORT`/`DATABASE_URL`/`JWT_*`).
// DATABASE_URL is read as of Phase 15. JWT_ACCESS_SECRET/JWT_REFRESH_SECRET
// are read as of Phase 26 (API Spec §4.1/§4.2) — both REQUIRED, matching
// DATABASE_URL's own precedent, since both are already present (with
// placeholder "replace-me" values) in the tracked .env.example/.env.

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

/**
 * Phase 24 (API Spec §5.5/§6.5/§10.5, Test Plan RC-30) — the server-side half of offline
 * window enforcement: a still-BUFFERED (pending, Engine Spec §4.2) operation this old is
 * declared permanently unresolvable and explicitly rejected (Engine Spec §7.6 Rule 7.2, left
 * unbuilt by Phase 21) rather than left in `engine.pending` forever. As CONFIGURATION, not a
 * hardcoded constant, for the same reason Phase 21's `GcConfig` is: Scope-IN's own number
 * (30s) is a starting point, not a value this project has independently validated at
 * production scale.
 */
export interface OfflineWindowConfig {
  /** Scope-IN: "an operation buffered > 30 s ... → OP_REJECT{offline_window_exceeded}". */
  readonly pendingRejectTimeoutMs: number;
  /** How often each open document's `engine.pending` is swept for operations past `pendingRejectTimeoutMs`. */
  readonly sweepIntervalMs: number;
}

/**
 * Phase 26 (API Spec §4.1/§4.2, Test Plan §11.1/SEC-11g) — authentication tunables. The two
 * JWT secrets are the only genuinely REQUIRED-with-no-safe-default values in this whole config
 * module (alongside `databaseUrl`) — an auto-generated or empty secret would make every access
 * token forgeable/replayable across restarts, unlike GcConfig/OfflineWindowConfig's own tunables,
 * where "unvalidated but reasonable" defaults are an acceptable starting point.
 *
 * `accessTokenTtlMs` (15 minutes) and the cookie attributes (HttpOnly/Secure/SameSite=Strict/
 * Path=/v1/auth/refresh) are literal, spec-given numbers/values (API Spec §4.1/§4.2) — NOT
 * configuration in the same "unvalidated, deployment may need to tune this" sense GcConfig's own
 * undo horizon is. They're still exposed as fields (rather than inline constants in tokens.ts)
 * purely so tests can construct a config with a DIFFERENT ttl without needing to wait out a real
 * 15-minute window, the same reasoning Phase 17's `DocumentCoordinator` constructor-injectable
 * snapshot thresholds already established for an identical problem.
 *
 * `refreshTokenTtlMs` and both rate-limit thresholds ARE genuinely "unvalidated, reasonable
 * defaults" in the GcConfig sense — neither API Spec §4.1/§4.2 nor Test Plan SEC-11g gives a
 * literal number for a refresh token's own lifetime or for how many login attempts should be
 * allowed before rate-limiting kicks in; both are disclosed, defensible starting points, safe to
 * override in a real deployment without a code change.
 */
export interface AuthConfig {
  readonly jwtAccessSecret: string;
  readonly jwtRefreshSecret: string;
  /** API Spec §4.1: "expiresIn: 900" (15 minutes), literal. */
  readonly accessTokenTtlMs: number;
  /** Not spec-mandated — a disclosed, reasonable default (30 days), overridable via config. */
  readonly refreshTokenTtlMs: number;
  /** Test Plan's own "per-IP... throttling" requirement, exact thresholds unspecified — a disclosed, reasonable default. */
  readonly loginRateLimitPerIp: RateLimitRule;
  /** Test Plan's own "per-account... throttling" requirement, exact thresholds unspecified — a disclosed, reasonable default. */
  readonly loginRateLimitPerAccount: RateLimitRule;
}

export interface RateLimitRule {
  readonly max: number;
  readonly windowMs: number;
}

export interface ServerConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly gc: GcConfig;
  readonly offlineWindow: OfflineWindowConfig;
  readonly auth: AuthConfig;
}

const DEFAULT_PORT = 8080;
const DEFAULT_UNDO_HORIZON_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_UNDO_HORIZON_MAX_OPS_PER_REPLICA = 200;
const DEFAULT_GC_INTERVAL_MS = 60 * 1000;
// Conservative: a single document's GC must never meaningfully stall the event loop for other
// documents/clients, even under a pathological anchor chain (see GcConfig's own doc comment).
const DEFAULT_GC_FIXPOINT_BUDGET_MS = 150;
// Scope-IN's own literal number (Phase 24).
const DEFAULT_OFFLINE_WINDOW_PENDING_REJECT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_OFFLINE_WINDOW_SWEEP_INTERVAL_MS = 5 * 1000;

// Phase 26 — API Spec §4.1's own literal number.
const DEFAULT_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
// Not spec-mandated — a disclosed, reasonable default (see AuthConfig's own doc comment).
const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LOGIN_RATE_LIMIT_PER_IP_MAX = 20;
const DEFAULT_LOGIN_RATE_LIMIT_PER_IP_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_LOGIN_RATE_LIMIT_PER_ACCOUNT_MAX = 5;
const DEFAULT_LOGIN_RATE_LIMIT_PER_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;

/** No safe default exists for a secret — see AuthConfig's own doc comment for why these two are the only genuinely required env vars besides `DATABASE_URL`. */
function requiredStringFromEnv(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key];
  if (!raw) {
    throw new Error(`loadConfig: ${key} is required (see .env.example)`);
  }
  return raw;
}

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
  const offlineWindow: OfflineWindowConfig = {
    pendingRejectTimeoutMs: positiveIntFromEnv(
      env,
      "OFFLINE_WINDOW_PENDING_REJECT_TIMEOUT_MS",
      DEFAULT_OFFLINE_WINDOW_PENDING_REJECT_TIMEOUT_MS,
    ),
    sweepIntervalMs: positiveIntFromEnv(
      env,
      "OFFLINE_WINDOW_SWEEP_INTERVAL_MS",
      DEFAULT_OFFLINE_WINDOW_SWEEP_INTERVAL_MS,
    ),
  };
  const auth: AuthConfig = {
    jwtAccessSecret: requiredStringFromEnv(env, "JWT_ACCESS_SECRET"),
    jwtRefreshSecret: requiredStringFromEnv(env, "JWT_REFRESH_SECRET"),
    accessTokenTtlMs: positiveIntFromEnv(env, "AUTH_ACCESS_TOKEN_TTL_MS", DEFAULT_ACCESS_TOKEN_TTL_MS),
    refreshTokenTtlMs: positiveIntFromEnv(
      env,
      "AUTH_REFRESH_TOKEN_TTL_MS",
      DEFAULT_REFRESH_TOKEN_TTL_MS,
    ),
    loginRateLimitPerIp: {
      max: positiveIntFromEnv(env, "AUTH_LOGIN_RATE_LIMIT_PER_IP_MAX", DEFAULT_LOGIN_RATE_LIMIT_PER_IP_MAX),
      windowMs: positiveIntFromEnv(
        env,
        "AUTH_LOGIN_RATE_LIMIT_PER_IP_WINDOW_MS",
        DEFAULT_LOGIN_RATE_LIMIT_PER_IP_WINDOW_MS,
      ),
    },
    loginRateLimitPerAccount: {
      max: positiveIntFromEnv(
        env,
        "AUTH_LOGIN_RATE_LIMIT_PER_ACCOUNT_MAX",
        DEFAULT_LOGIN_RATE_LIMIT_PER_ACCOUNT_MAX,
      ),
      windowMs: positiveIntFromEnv(
        env,
        "AUTH_LOGIN_RATE_LIMIT_PER_ACCOUNT_WINDOW_MS",
        DEFAULT_LOGIN_RATE_LIMIT_PER_ACCOUNT_WINDOW_MS,
      ),
    },
  };
  return { port, databaseUrl, gc, offlineWindow, auth };
}
