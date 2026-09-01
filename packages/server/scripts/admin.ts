// Standalone admin CLI (Phase 18 Scope-IN: "./admin audit --doc=<id>
// --verbose"). A SEPARATE process from any running server — connects
// directly to Postgres via DATABASE_URL (same pattern as
// scripts/seed.ts), never to a live server's in-memory state. This means
// an admin-CLI-invoked audit can only ever run AUDIT()'s steps 1-4
// (DB-only, audit.ts) — step 5 (comparing against the live coordinator's
// own materialize()) requires being INSIDE the server process, which is
// what auditScheduler.ts's recurring timer does instead. `./admin` in
// the phase brief names the CONCEPT (an admin CLI), not a literal
// filename to create — this project's other admin-style tooling
// (scripts/seed.ts, `pnpm db:seed`) is invoked via a pnpm script, not a
// bare shell executable, for the same reason `db:migrate`/`db:seed`
// are: no assumption that a bash script is directly runnable on Windows.
//
// Usage:
//   pnpm --filter @collab-editor/server run admin -- audit --doc=<documentId> [--verbose]

import { loadConfig } from "../src/config.js";
import { auditDocument } from "../src/audit.js";
import { PostgresOperationStore } from "../src/db/operationStore.js";
import { createPool } from "../src/db/pool.js";

interface ParsedArgs {
  readonly command: string;
  readonly documentId: string | undefined;
  readonly verbose: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  let documentId: string | undefined;
  let verbose = false;
  for (const arg of rest) {
    if (arg === "--verbose") {
      verbose = true;
    } else if (arg.startsWith("--doc=")) {
      documentId = arg.slice("--doc=".length);
    }
  }
  return { command: command ?? "", documentId, verbose };
}

async function runAudit(documentId: string, verbose: boolean): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const store = new PostgresOperationStore(pool);
  try {
    // No `liveText` — see this file's own header comment for why a standalone process can't
    // supply one.
    const result = await auditDocument(documentId, store);
    console.log(
      JSON.stringify({
        documentId,
        result: result.result,
        replayedToSeq: result.replayedToSeq.toString(),
        divergenceSeq: result.divergenceSeq?.toString() ?? null,
      }),
    );
    if (verbose) {
      console.log(result.detail);
    }
    if (result.result !== "ok") {
      process.exitCode = 1; // a script/cron invocation can alert on a nonzero exit code
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const { command, documentId, verbose } = parseArgs(process.argv.slice(2));
  if (command !== "audit" || !documentId) {
    console.error("Usage: admin audit --doc=<documentId> [--verbose]");
    process.exitCode = 2;
    return;
  }
  await runAudit(documentId, verbose);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
