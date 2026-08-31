import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { DocumentCoordinator } from "./documentCoordinator.js";
import { createGateway, type Gateway } from "./gateway.js";
import { createHttpApp } from "./httpApp.js";
import { logger } from "./logger.js";

export interface CollabServer {
  readonly httpServer: HttpServer;
  readonly gateway: Gateway;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

/** Builds the Express app and WebSocket gateway on one shared HTTP server (so HTTP and WS share a single port). Does not start listening — call `listen()`. */
export function createCollabServer(): CollabServer {
  // `httpApp.ts`'s replay endpoint needs `gateway.coordinators`, but the app must be built BEFORE
  // the gateway exists (the HTTP server needs the app first, and the gateway needs the HTTP
  // server) — this closure defers the read until an actual request arrives, by which point
  // `gatewayBox.current` below is always already set. A boxed object (rather than a `let`) so the
  // binding itself stays `const` — only its one property is ever mutated, once.
  const gatewayBox: { current: Gateway | undefined } = { current: undefined };
  const app = createHttpApp({
    getCoordinators: (): ReadonlyMap<string, DocumentCoordinator> =>
      gatewayBox.current?.coordinators ?? new Map(),
  });
  const httpServer = createHttpServer(app);
  const gateway = createGateway(httpServer);
  gatewayBox.current = gateway;

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
        gateway.close();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
