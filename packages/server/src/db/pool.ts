// Thin `pg` Pool wrapper (Phase 15). Used today by the seed script
// (scripts/seed.ts) and by schema.db.test.ts's DoD verification queries.
// NOT wired into documentCoordinator.ts/gateway.ts yet — the write path
// (operations/snapshots persistence) is Phases 16-17, and until that
// lands the coordinator remains in-memory only, per CLAUDE.md.

import pg from "pg";

const { Pool } = pg;

export type DbPool = InstanceType<typeof Pool>;

export function createPool(databaseUrl: string): DbPool {
  return new Pool({ connectionString: databaseUrl });
}
