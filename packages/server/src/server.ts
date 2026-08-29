import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
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
  const app = createHttpApp();
  const httpServer = createHttpServer(app);
  const gateway = createGateway(httpServer);

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
