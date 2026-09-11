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
  /**
   * Phase 30 (RFC §8.7, Test Plan SEC-11i) — "the causal buffer is bounded in size AND age; an
   * operation whose dependencies never arrive is discarded ... not accumulated." Age is already
   * `pendingRejectTimeoutMs` above (Phase 24); this is the SIZE half — the maximum number of
   * still-buffered (pending) operations one document's engine may hold before the OLDEST are
   * evicted regardless of how long they've been waiting, so a flood of operations whose causal
   * dependency never arrives (or arrives too slowly to keep up) cannot grow `engine.pending`
   * without bound between sweeps. Checked in the SAME sweep as the age-based eviction above
   * (offlineWindowScheduler.ts) — one scheduler, one pass over `engine.pending`, two related
   * eviction reasons — rather than a second, separate scheduler for what is, per RFC §8.7's own
   * framing, one holistic "bounded causal buffer" requirement. A disclosed, reasonable default
   * (not spec-mandated) generous enough that no pre-Phase-30 test's ordinary buffering pattern
   * comes remotely close to it — see this field's own default constant below.
   */
  readonly maxPendingPerDocument?: number;
}

/**
 * Phase 30 (RFC §8.2 (T2), Test Plan SEC-08) — per-session and per-document operation-rate
 * limiting, the FIRST line of defense against the metadata-exhaustion attack this project's own
 * CRDT choice specifically creates: an authorized, well-formed insert-then-delete script at
 * scattered positions produces real tombstones that propagate to every peer through the ordinary
 * convergence mechanism, and no authorization/identity check (Phase 28/29) can distinguish it from
 * ordinary fast typing — only its RATE gives it away.
 *
 * Counted PER INCOMING MESSAGE, not per expanded engine operation — a deliberate design choice,
 * not an oversight: a single `OP_INSERT_RUN`/`OP_DELETE_BATCH` frame (a 2,000-character paste, or
 * a reconnection's own reconciled-operations resend, `wireHelpers.ts`'s `operationsToWireMessages`)
 * can legitimately represent thousands of engine operations in ONE frame a real user or a normal
 * reconnection sent all at once — counting by expanded operation count would reject an ordinary
 * large paste outright, a real product regression, not a security improvement. SEC-08's own attack
 * shape is exactly what this counts correctly instead: scattered-position insert-then-delete pairs
 * cannot be coalesced into a compact run/batch frame at all (this is SEC-09's own point — see
 * `snapshotBody.ts`'s chain-encoding doc comment for why), so the attack's own 1,000 ops/second
 * arrives as ~1,000-2,000 SEPARATE messages/second, comfortably tripping a 200-messages/second cap
 * while a real paste (one message, however large) never does.
 *
 * Disabled (no per-session/per-document check at all) unless explicitly supplied — the SAME
 * "undefined disables" pattern `DocumentCoordinator`'s own `lookupRole` already established (Phase
 * 29): dozens of pre-existing tests across this codebase construct a `DocumentCoordinator` (or a
 * whole server) directly and drive it through rapid, tight loops of many individual small
 * operations (e.g. `headlessHarness.test.ts`'s 1,000-operation convergence workload, RC-27's
 * repeated-reconnection reconciliation) — all completing in well under a second of REAL wall-clock
 * time, which would trip an always-on per-message cap for reasons having nothing to do with this
 * phase's own threat model. `index.ts`'s real, direct-run production path ALWAYS supplies this —
 * see that file's own construction site.
 */
export interface RateLimitConfig {
  /** Scope-IN's own literal number: "200 ops/s, then throttle" — see this interface's own header comment for what unit "ops" is actually counted in here. */
  readonly perSessionRule: RateLimitRule;
  /**
   * Scope-IN: "then disconnect" — SEC-08's disconnect trigger, redesigned after an empirical
   * measurement (this project's own real 1,000 ops/s attack, run against the real rate limiter)
   * found the ORIGINAL design ("disconnect once a session has been rejected CONTINUOUSLY, with
   * zero acceptances, for `perSessionSustainedViolationMs`") never actually fires against a real
   * sustained attacker: a sliding-window-log limiter that is successfully THROTTLING an attacker
   * admits roughly `perSessionRule.max` messages per `perSessionRule.windowMs` FOREVER, by design
   * — every acceptance reset the old streak-based clock to zero, and acceptances happen roughly
   * every `windowMs/max` (≈5ms at 200/1000ms), far more often than any plausible sustained-streak
   * threshold. "Throttle" and "require zero acceptances for a full window" are mutually exclusive
   * as that design was coded.
   *
   * This field instead bounds the VOLUME of rejections in a rolling window, via the SAME
   * `InMemoryRateLimiter.consume()` mechanism `perSessionRule` itself uses (a second,
   * independent key/rule pair, `violation:<sessionId>`) — an accepted message no longer resets
   * anything; only real time aging old violations out of the window ever lowers this count. The
   * default, `{max: 200, windowMs: 1000}` — the SAME numbers as `perSessionRule` itself —
   * disconnects once a session has been rejected as many times in one second as its own ENTIRE
   * allowed acceptance budget: its rejection rate has reached parity with its own cap, a strong,
   * unambiguous signal of sustained, overwhelming abuse. Hand-traced against a legitimate large
   * paste (coalesces into ONE `OP_INSERT_RUN` frame, Phase 12/24's wire helpers — never even
   * approaches either rule) and a legitimate, non-batchable burst moderately over the cap (e.g.
   * 250 msgs/s for 2s, then normal — accumulates only ~50 violations/s, well under this
   * threshold) — see `securityLimits.test.ts`'s own tests for both, run for real, not just on
   * paper.
   */
  readonly perSessionDisconnectRule: RateLimitRule;
  /**
   * SEC-08: "the per-document budget triggers independently of the per-session one" — an
   * AGGREGATE cap shared across every session currently connected to one document, so several
   * distinct sessions each individually under `perSessionRule`'s own cap can still, combined,
   * exceed this one. Deliberately more generous than `perSessionRule` alone (it is a SUM across
   * however many sessions are open), not a second copy of the same number.
   */
  readonly perDocumentRule: RateLimitRule;
}

/**
 * Phase 30 (RFC §8.2 (T2), Test Plan SEC-08) — the document-wide circuit breaker: beyond a hard
 * structure-size ceiling, a document stops accepting operations from ANYONE (including its own
 * owner) — "failing CLOSED protects other participants' clients," per SEC-08's own wording,
 * because every peer's own client integrates every tombstone this document ever accumulates
 * (Engine Spec's own convergence guarantee, applied here as the attack surface it also is). ALWAYS
 * active (unlike `RateLimitConfig` above) with a generous default ceiling — see this file's own
 * default constants for why no ordinary pre-Phase-30 test's document size comes remotely close to
 * it (Fugue's own O(N²) sequential-insertion cost, CLAUDE.md's Open Item 3, already makes building
 * a document anywhere near this scale prohibitively slow in a fast test's own real time budget).
 */
export interface CircuitBreakerConfig {
  /** Logged once (edge-triggered, not per operation) the first time `engine.stats().totalElements` crosses this — an early warning BEFORE the hard ceiling below. */
  readonly structureSizeAlertThreshold: number;
  /** The hard trip point: `engine.stats().totalElements` at or above this makes the document read-only for everyone until GC (Phase 21) reclaims enough tombstones to fall back under it. */
  readonly structureSizeCeiling: number;
  /** Logged once (edge-triggered) the first time `engine.stats().tombstones` crosses this — an independent signal from structure size (a document can have many tombstones without yet being near the total-size ceiling, or vice versa for a document with very little history but one recent burst). */
  readonly tombstoneCountAlertThreshold: number;
}

/**
 * Phase 30 (RFC §8.8) — per-IP and per-account WebSocket CONNECTION attempt limits, distinct from
 * (and in addition to) Phase 26's own login-attempt limiter and Phase 29's own ticket-issuance
 * limiter: this bounds how often a raw WS connection may be OPENED at all, regardless of whether
 * the attempt ever completes a HELLO handshake. Per-account is checked only once a real ticket has
 * been consumed (gateway.ts) — there is no "account" to key on before that; a server constructed
 * with no `auth` deps skips the per-account half entirely, the same conditional-on-real-auth
 * pattern this project has used since Phase 29's own ticket validation. Optional at the type level,
 * `undefined` disabling connection-level limiting entirely (every pre-Phase-30 test constructing a
 * gateway directly) — `index.ts`'s real, direct-run path always supplies it.
 */
export interface ConnectionRateLimitConfig {
  readonly perIp: RateLimitRule;
  readonly perAccount: RateLimitRule;
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
  /** API Spec §4.10's own literal number: "valid 30 seconds." Exposed as a field (not an inline constant) for the SAME reason `accessTokenTtlMs` is — tests need a short-lived variant to exercise SEC-11c's own expiry boundary without a real 30-second wait. */
  readonly ticketTtlMs: number;
  /** API Spec §4.10: "429 rate_limited — bounds connection-churn attacks at the ticket issuer." No literal threshold given — a disclosed, reasonable default, keyed per-user by the caller (httpApp.ts). */
  readonly ticketRateLimit: RateLimitRule;
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
  /** Phase 30 (RFC §8.2 (T2)) — see `RateLimitConfig`'s own doc comment for why the direct-run path (below) always supplies this even though the type itself is optional wherever it's threaded through. */
  readonly rateLimit: RateLimitConfig;
  /** Phase 30 (RFC §8.2 (T2)) — see `CircuitBreakerConfig`'s own doc comment. */
  readonly circuitBreaker: CircuitBreakerConfig;
  /** Phase 30 (RFC §8.8). */
  readonly connectionRateLimit: ConnectionRateLimitConfig;
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
// Phase 30 (RFC §8.7) — a disclosed, reasonable default; see OfflineWindowConfig's own doc comment.
export const DEFAULT_MAX_PENDING_PER_DOCUMENT = 5000;

// Phase 30 (RFC §8.2 (T2), Test Plan SEC-08) — Scope-IN's own literal "200 ops/s" number, counted
// per incoming message (see RateLimitConfig's own doc comment for why).
const DEFAULT_RATE_LIMIT_PER_SESSION_MAX = 200;
const DEFAULT_RATE_LIMIT_PER_SESSION_WINDOW_MS = 1000;
// SAME numbers as the per-session cap itself -- see RateLimitConfig.perSessionDisconnectRule's
// own doc comment for the full reasoning (disconnect once a session's rejection rate reaches
// parity with its own acceptance-rate cap).
const DEFAULT_RATE_LIMIT_PER_SESSION_DISCONNECT_MAX = 200;
const DEFAULT_RATE_LIMIT_PER_SESSION_DISCONNECT_WINDOW_MS = 1000;
// Deliberately more generous than the per-session cap alone — an aggregate across however many
// sessions are open on one document, not a second copy of the same per-session number.
const DEFAULT_RATE_LIMIT_PER_DOCUMENT_MAX = 1000;
const DEFAULT_RATE_LIMIT_PER_DOCUMENT_WINDOW_MS = 1000;

// Phase 30 (RFC §8.2 (T2)) — disclosed, reasonable defaults, comfortably above the largest
// document any pre-Phase-30 fast test builds (e.g. Phase 21's own 90,000-character M8-c fixture)
// while still being a real, meaningful ceiling; see CircuitBreakerConfig's own doc comment.
const DEFAULT_CIRCUIT_BREAKER_STRUCTURE_SIZE_ALERT_THRESHOLD = 100_000;
const DEFAULT_CIRCUIT_BREAKER_STRUCTURE_SIZE_CEILING = 200_000;
const DEFAULT_CIRCUIT_BREAKER_TOMBSTONE_COUNT_ALERT_THRESHOLD = 100_000;

// Phase 30 (RFC §8.8) — disclosed, reasonable defaults (no literal number given by the spec text).
const DEFAULT_CONNECTION_RATE_LIMIT_PER_IP_MAX = 30;
const DEFAULT_CONNECTION_RATE_LIMIT_PER_IP_WINDOW_MS = 60 * 1000;
const DEFAULT_CONNECTION_RATE_LIMIT_PER_ACCOUNT_MAX = 20;
const DEFAULT_CONNECTION_RATE_LIMIT_PER_ACCOUNT_WINDOW_MS = 60 * 1000;

/**
 * Phase 30 — the SAME generous defaults `loadConfig()` uses for a real server, exported directly
 * so `DocumentCoordinator` (which makes its own circuit breaker ALWAYS active, unlike
 * `RateLimitConfig`) has exactly one source of truth for these numbers rather than a second,
 * independently-maintained copy that could silently drift from `loadConfig()`'s own values.
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  structureSizeAlertThreshold: DEFAULT_CIRCUIT_BREAKER_STRUCTURE_SIZE_ALERT_THRESHOLD,
  structureSizeCeiling: DEFAULT_CIRCUIT_BREAKER_STRUCTURE_SIZE_CEILING,
  tombstoneCountAlertThreshold: DEFAULT_CIRCUIT_BREAKER_TOMBSTONE_COUNT_ALERT_THRESHOLD,
};

/**
 * Phase 30 — the SAME generous defaults `loadConfig()` uses for a real server, exported directly
 * so `createCollabServer()` (server.ts) has a real default to start the offline-window sweep
 * with when a caller doesn't supply one, mirroring `DEFAULT_CIRCUIT_BREAKER_CONFIG`'s own
 * "one source of truth, not a second independently-maintained copy" reasoning. Unlike the GC and
 * audit schedulers (which stay OUT of the shared factory — every test constructing its own
 * server would otherwise need to remember to stop them), this scheduler is ALWAYS started by
 * `createCollabServer()` itself: its absence is not a "nice to have liveness metric" gap the way
 * GC/audit's absence is — it is the ONLY thing standing between an ordinary rate-limited session
 * and UNBOUNDED `engine.pending` growth (SEC-11i's own "bounded in size AND age" requirement
 * structurally depends on this sweep actually running), and it is cheap and safe to always run
 * (synchronous, in-memory, no database I/O, `timer.unref()`'d, and `close()` calls `.stop()` on
 * it) — unlike GC/audit, which do real, comparatively expensive work.
 */
export const DEFAULT_OFFLINE_WINDOW_CONFIG: OfflineWindowConfig = {
  pendingRejectTimeoutMs: DEFAULT_OFFLINE_WINDOW_PENDING_REJECT_TIMEOUT_MS,
  sweepIntervalMs: DEFAULT_OFFLINE_WINDOW_SWEEP_INTERVAL_MS,
  maxPendingPerDocument: DEFAULT_MAX_PENDING_PER_DOCUMENT,
};

// Phase 26 — API Spec §4.1's own literal number.
const DEFAULT_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
// Not spec-mandated — a disclosed, reasonable default (see AuthConfig's own doc comment).
const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LOGIN_RATE_LIMIT_PER_IP_MAX = 20;
const DEFAULT_LOGIN_RATE_LIMIT_PER_IP_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_LOGIN_RATE_LIMIT_PER_ACCOUNT_MAX = 5;
const DEFAULT_LOGIN_RATE_LIMIT_PER_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
// Phase 29 — API Spec §4.10's own literal number.
const DEFAULT_TICKET_TTL_MS = 30 * 1000;
const DEFAULT_TICKET_RATE_LIMIT_MAX = 30;
const DEFAULT_TICKET_RATE_LIMIT_WINDOW_MS = 60 * 1000;

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
    maxPendingPerDocument: positiveIntFromEnv(
      env,
      "OFFLINE_WINDOW_MAX_PENDING_PER_DOCUMENT",
      DEFAULT_MAX_PENDING_PER_DOCUMENT,
    ),
  };
  const rateLimit: RateLimitConfig = {
    perSessionRule: {
      max: positiveIntFromEnv(env, "RATE_LIMIT_PER_SESSION_MAX", DEFAULT_RATE_LIMIT_PER_SESSION_MAX),
      windowMs: positiveIntFromEnv(
        env,
        "RATE_LIMIT_PER_SESSION_WINDOW_MS",
        DEFAULT_RATE_LIMIT_PER_SESSION_WINDOW_MS,
      ),
    },
    perSessionDisconnectRule: {
      max: positiveIntFromEnv(
        env,
        "RATE_LIMIT_PER_SESSION_DISCONNECT_MAX",
        DEFAULT_RATE_LIMIT_PER_SESSION_DISCONNECT_MAX,
      ),
      windowMs: positiveIntFromEnv(
        env,
        "RATE_LIMIT_PER_SESSION_DISCONNECT_WINDOW_MS",
        DEFAULT_RATE_LIMIT_PER_SESSION_DISCONNECT_WINDOW_MS,
      ),
    },
    perDocumentRule: {
      max: positiveIntFromEnv(
        env,
        "RATE_LIMIT_PER_DOCUMENT_MAX",
        DEFAULT_RATE_LIMIT_PER_DOCUMENT_MAX,
      ),
      windowMs: positiveIntFromEnv(
        env,
        "RATE_LIMIT_PER_DOCUMENT_WINDOW_MS",
        DEFAULT_RATE_LIMIT_PER_DOCUMENT_WINDOW_MS,
      ),
    },
  };
  const circuitBreaker: CircuitBreakerConfig = {
    structureSizeAlertThreshold: positiveIntFromEnv(
      env,
      "CIRCUIT_BREAKER_STRUCTURE_SIZE_ALERT_THRESHOLD",
      DEFAULT_CIRCUIT_BREAKER_STRUCTURE_SIZE_ALERT_THRESHOLD,
    ),
    structureSizeCeiling: positiveIntFromEnv(
      env,
      "CIRCUIT_BREAKER_STRUCTURE_SIZE_CEILING",
      DEFAULT_CIRCUIT_BREAKER_STRUCTURE_SIZE_CEILING,
    ),
    tombstoneCountAlertThreshold: positiveIntFromEnv(
      env,
      "CIRCUIT_BREAKER_TOMBSTONE_COUNT_ALERT_THRESHOLD",
      DEFAULT_CIRCUIT_BREAKER_TOMBSTONE_COUNT_ALERT_THRESHOLD,
    ),
  };
  const connectionRateLimit: ConnectionRateLimitConfig = {
    perIp: {
      max: positiveIntFromEnv(
        env,
        "CONNECTION_RATE_LIMIT_PER_IP_MAX",
        DEFAULT_CONNECTION_RATE_LIMIT_PER_IP_MAX,
      ),
      windowMs: positiveIntFromEnv(
        env,
        "CONNECTION_RATE_LIMIT_PER_IP_WINDOW_MS",
        DEFAULT_CONNECTION_RATE_LIMIT_PER_IP_WINDOW_MS,
      ),
    },
    perAccount: {
      max: positiveIntFromEnv(
        env,
        "CONNECTION_RATE_LIMIT_PER_ACCOUNT_MAX",
        DEFAULT_CONNECTION_RATE_LIMIT_PER_ACCOUNT_MAX,
      ),
      windowMs: positiveIntFromEnv(
        env,
        "CONNECTION_RATE_LIMIT_PER_ACCOUNT_WINDOW_MS",
        DEFAULT_CONNECTION_RATE_LIMIT_PER_ACCOUNT_WINDOW_MS,
      ),
    },
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
    ticketTtlMs: positiveIntFromEnv(env, "AUTH_TICKET_TTL_MS", DEFAULT_TICKET_TTL_MS),
    ticketRateLimit: {
      max: positiveIntFromEnv(env, "AUTH_TICKET_RATE_LIMIT_MAX", DEFAULT_TICKET_RATE_LIMIT_MAX),
      windowMs: positiveIntFromEnv(
        env,
        "AUTH_TICKET_RATE_LIMIT_WINDOW_MS",
        DEFAULT_TICKET_RATE_LIMIT_WINDOW_MS,
      ),
    },
  };
  return { port, databaseUrl, gc, offlineWindow, auth, rateLimit, circuitBreaker, connectionRateLimit };
}
