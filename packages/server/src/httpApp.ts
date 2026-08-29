import express, { type Express } from "express";

/** Express app: just a health endpoint this phase. The WebSocket gateway (gateway.ts) is mounted on the same underlying HTTP server, not here. */
export function createHttpApp(): Express {
  const app = express();
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  return app;
}
