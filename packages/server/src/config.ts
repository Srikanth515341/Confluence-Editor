// Environment config (.env.example's `PORT`). DATABASE_URL/JWT_* are also
// listed in .env.example but belong to persistence (Phases 15-17) and auth
// (Phases 26-29) — not read anywhere yet.

export interface ServerConfig {
  readonly port: number;
}

const DEFAULT_PORT = 8080;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const raw = env.PORT ?? String(DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`loadConfig: PORT must be an integer in 1..65535, got "${raw}"`);
  }
  return { port };
}
