import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { InMemoryOperationStore, type OperationStore } from "./db/operationStore.js";
import type { DbPool } from "./db/pool.js";
import type { DocumentCoordinator } from "./documentCoordinator.js";
import {
  DEFAULT_OFFLINE_WINDOW_CONFIG,
  type AuthConfig,
  type CircuitBreakerConfig,
  type ConnectionRateLimitConfig,
  type OfflineWindowConfig,
  type RateLimitConfig,
} from "./config.js";
import { createGateway, type Gateway } from "./gateway.js";
import { createHttpApp } from "./httpApp.js";
import { logger } from "./logger.js";
import { startOfflineWindowScheduler } from "./offlineWindowScheduler.js";
import { InMemoryTicketStore } from "./ticketStore.js";

export interface CollabServer {
  readonly httpServer: HttpServer;
  readonly gateway: Gateway;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

export interface CreateCollabServerDeps {
  /**
   * Persistence for the write path (Phase 16, API Spec §6.3). Defaults to
   * `InMemoryOperationStore` — no real durability, nothing written across
   * a restart — so every server test predating Phase 16 (gateway.test.ts,
   * httpApp.test.ts, and client's headlessHarness.test.ts, part of the
   * default `pnpm test`) keeps working without requiring a real Postgres
   * instance. PRODUCTION always passes a real `PostgresOperationStore`
   * explicitly — see index.ts's direct-run block. Passing one explicitly
   * in a test is how Phase 16's own new persistence tests
   * (packages/server/src/db/*.db.test.ts, `pnpm test:db`) opt into real
   * durability instead.
   */
  readonly operationStore?: OperationStore;
  /**
   * Phase 26 (API Spec §4.1/§4.2) — REAL Postgres access + config for POST /v1/auth/login,
   * /refresh, /logout. Optional for the SAME reason `operationStore` is: every pre-Phase-26 test
   * constructing a server this way (gateway.test.ts, httpApp.test.ts, client's
   * headlessHarness.test.ts) has no real database and must keep working unchanged — omitting
   * this simply means the three auth routes are never mounted (see httpApp.ts's own `authDeps`
   * doc comment). `index.ts`'s direct-run path and this phase's own new `db/auth.db.test.ts`/
   * `db/authTiming.db.test.ts` are the only real callers that ever supply it.
   */
  readonly auth?: { readonly pool: DbPool; readonly authConfig: AuthConfig };
  /** Phase 30 (RFC §8.2 (T2)) — threaded straight through to `createGateway`'s own identically-named field; see that field's own doc comment. */
  readonly rateLimit?: RateLimitConfig;
  /** Phase 30 (RFC §8.2 (T2)) — threaded straight through to `createGateway`'s own identically-named field. */
  readonly circuitBreaker?: Partial<CircuitBreakerConfig>;
  /** Phase 30 (RFC §8.8) — threaded straight through to `createGateway`'s own identically-named field. */
  readonly connectionRateLimit?: ConnectionRateLimitConfig;
  /**
   * Phase 24/30 (Engine Spec §7.6 Rule 7.2, RFC §8.7, Test Plan RC-30/SEC-11i) — the offline-
   * window sweep's own config. UNLIKE the GC and audit schedulers (started only by `index.ts`'s
   * direct-run block, never here — see that file's own comment for why: no test constructing its
   * own server needs to remember to stop them), this scheduler is ALWAYS started by
   * `createCollabServer()` itself, deliberately: its absence is not a "nice to have liveness
   * metric" gap the way GC/audit's absence is — it's the ONLY thing bounding `engine.pending`'s
   * own growth (SEC-11i's "bounded in size AND age" requirement structurally depends on this
   * sweep actually running), and unlike GC/audit it is cheap and safe to always run (synchronous,
   * in-memory, no database I/O). Defaults to `DEFAULT_OFFLINE_WINDOW_CONFIG` when omitted (every
   * pre-this-fix test) — the same generous defaults `loadConfig()` uses for a real server.
   */
  readonly offlineWindow?: OfflineWindowConfig;
}

/** Builds the Express app and WebSocket gateway on one shared HTTP server (so HTTP and WS share a single port). Does not start listening — call `listen()`. */
export function createCollabServer(deps: CreateCollabServerDeps = {}): CollabServer {
  const operationStore = deps.operationStore ?? new InMemoryOperationStore();
  // `httpApp.ts`'s replay endpoint needs `gateway.coordinators`, but the app must be built BEFORE
  // the gateway exists (the HTTP server needs the app first, and the gateway needs the HTTP
  // server) — this closure defers the read until an actual request arrives, by which point
  // `gatewayBox.current` below is always already set. A boxed object (rather than a `let`) so the
  // binding itself stays `const` — only its one property is ever mutated, once.
  const gatewayBox: { current: Gateway | undefined } = { current: undefined };
  // Phase 29 (API Spec §4.10) — ONE shared instance, constructed here so httpApp.ts (issuing
  // tickets) and gateway.ts (consuming them) are provably talking to the same in-memory store —
  // constructing it separately in each place would silently make every ticket "wrong-document"
  // forever, since the two stores would never share state. Only constructed when `deps.auth` is
  // present — real ticket validation, like every other real-auth capability this project has
  // added since Phase 26, is off by default so pre-Phase-29 tests keep working unchanged.
  const ticketStore = deps.auth ? new InMemoryTicketStore() : undefined;
  const app = createHttpApp({
    getCoordinators: (): ReadonlyMap<string, DocumentCoordinator> =>
      gatewayBox.current?.coordinators ?? new Map(),
    // `exactOptionalPropertyTypes` means `authDeps: undefined` is NOT the same as omitting the
    // property — spread only when actually present, so `deps.auth === undefined` (the default,
    // every pre-Phase-26 caller) genuinely omits the key rather than assigning `undefined` to it.
    ...(deps.auth && ticketStore ? { authDeps: { ...deps.auth, ticketStore } } : {}),
  });
  const httpServer = createHttpServer(app);
  const gateway = createGateway(httpServer, {
    operationStore,
    ...(deps.auth && ticketStore ? { auth: { pool: deps.auth.pool, ticketStore } } : {}),
    ...(deps.rateLimit ? { rateLimit: deps.rateLimit } : {}),
    ...(deps.circuitBreaker ? { circuitBreaker: deps.circuitBreaker } : {}),
    ...(deps.connectionRateLimit ? { connectionRateLimit: deps.connectionRateLimit } : {}),
  });
  gatewayBox.current = gateway;

  // Phase 24/30 (Rule 7.2, RFC §8.7, SEC-11i) — see `CreateCollabServerDeps.offlineWindow`'s own
  // doc comment for why this scheduler (unlike GC/audit) is started HERE, unconditionally, for
  // every server this factory ever constructs, not only `index.ts`'s direct-run path.
  const offlineWindowScheduler = startOfflineWindowScheduler(
    gateway,
    deps.offlineWindow ?? DEFAULT_OFFLINE_WINDOW_CONFIG,
  );

  return {
    httpServer,
    gateway,
    listen: (port: number) =>
      new Promise<number>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, () => {
          httpServer.removeListener("error", reject);
          const address = httpServer.address();
          const boundPort = typeof address === "object" && address !== null ? address.port : port;
          logger.info("server.listening", { port: boundPort });
          resolve(boundPort);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        offlineWindowScheduler.stop();
        gateway.close();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
