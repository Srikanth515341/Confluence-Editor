// Environment config (.env.example's `PORT`/`DATABASE_URL`). JWT_* is also
// listed in .env.example but belongs to auth (Phases 26-29) — not read
// anywhere yet. DATABASE_URL is read as of Phase 15, but only by
// src/db/pool.ts (used by the seed script and by schema.db.test.ts) — no
// coordinator/gateway code opens a database connection yet; that's the
// write path, Phases 16-17.

export interface ServerConfig {
  readonly port: number;
  readonly databaseUrl: string;
}

const DEFAULT_PORT = 8080;

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
  return { port, databaseUrl };
}
