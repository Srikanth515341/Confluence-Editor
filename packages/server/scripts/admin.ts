// Standalone admin CLI (Phase 18 Scope-IN: "./admin audit --doc=<id>
// --verbose"; Phase 37 Runbook §7.6: the full 12-command table). `./admin`
// names the CONCEPT (an admin CLI), not a literal filename — this
// project's other admin-style tooling (scripts/seed.ts, `pnpm db:seed`)
// is invoked via a pnpm script, not a bare shell executable, for the same
// reason `db:migrate`/`db:seed` are: no assumption that a bash script is
// directly runnable on Windows.
//
// DUAL-MODE DESIGN (Phase 37, unchanged from Phase 18's own original
// reasoning, extended): `audit`/`replay`/`bisect`/`extract-case` connect
// directly to Postgres via DATABASE_URL, exactly like scripts/seed.ts —
// a SEPARATE process from any running server, never touching a live
// coordinator's in-memory state. This means these four commands can only
// ever see what is DURABLY committed (audit's own steps 1-4, never step
// 5's live-coordinator comparison — that's auditScheduler.ts's job).
// `materialize`/`gc`/`freeze`/`unfreeze`/`rebuild`/`doc-stats` genuinely
// need LIVE in-memory coordinator state a standalone process cannot
// reach on its own — these instead make real HTTP requests against a
// RUNNING server's admin surface (httpApp.ts's `/v1/admin/*` routes),
// via `--server=http://host:port` (default `http://127.0.0.1:8080`).
// `reconstruct`/`deploy-history` are legitimately-stubbed command SHAPES
// (Phases 40/39, not yet built) — this CLI still accepts and forwards
// them, honestly reporting the server's own 501 response, per this
// phase's own explicit instruction not to silently omit them.
//
// Usage:
//   pnpm --filter @collab-editor/server run admin -- <command> [--doc=<id>] [flags...]
//
// Commands: materialize replay bisect extract-case audit doc-stats gc
//           freeze unfreeze rebuild reconstruct deploy-history

import { loadConfig } from "../src/config.js";
import { auditDocument } from "../src/audit.js";
import { PostgresOperationStore } from "../src/db/operationStore.js";
import { createPool } from "../src/db/pool.js";
import { Engine } from "@collab-editor/engine";

const DEFAULT_SERVER_URL = "http://127.0.0.1:8080";

interface ParsedArgs {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string>;
  readonly bareFlags: ReadonlySet<string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  const bareFlags = new Set<string>();
  for (const arg of rest) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      bareFlags.add(arg.slice(2));
    } else {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    }
  }
  return { command: command ?? "", flags, bareFlags };
}

function requireDoc(flags: ReadonlyMap<string, string>): string {
  const doc = flags.get("doc");
  if (!doc) {
    throw new UsageError("--doc=<documentId> is required");
  }
  return doc;
}

class UsageError extends Error {}

function serverUrl(flags: ReadonlyMap<string, string>): string {
  return flags.get("server") ?? DEFAULT_SERVER_URL;
}

// --- DB-direct commands (audit/replay/bisect/extract-case) ---

async function withStore<T>(fn: (store: PostgresOperationStore) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const store = new PostgresOperationStore(pool);
  try {
    return await fn(store);
  } finally {
    await pool.end();
  }
}

async function runAudit(documentId: string, verbose: boolean): Promise<void> {
  await withStore(async (store) => {
    // No `liveText` — see this file's own header comment for why a standalone process can't
    // supply one; this is AUDIT() steps 1-4 only, never step 5.
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
  });
}

/**
 * `./admin replay --doc [--build]` (Runbook §7.6: "Replay the log through a fresh engine") —
 * the DB-direct analogue of `GET /v1/documents/:id/replay` (httpApp.ts), for use when no server
 * is running at all. `--build` additionally prints the full materialized text; without it, only
 * the summary (opCount/pendingCount/textLength) prints — the same "don't dump a possibly huge
 * document by default" restraint a real CLI tool would have.
 */
async function runReplay(documentId: string, build: boolean): Promise<void> {
  await withStore(async (store) => {
    const ops = await store.loadFullOperationLog(documentId);
    const replay = new Engine(0); // arbitrary — only ever applyRemote()s, never mints locally
    for (const op of ops) {
      replay.applyRemote(op);
    }
    const text = replay.text();
    console.log(
      JSON.stringify({
        documentId,
        opCount: ops.length,
        pendingCount: replay.pending.length,
        textLength: text.length,
        ...(build ? { text } : {}),
      }),
    );
    if (replay.pending.length !== 0) {
      process.exitCode = 1; // a causally-incomplete log is a real problem worth a nonzero exit
    }
  });
}

/**
 * `./admin bisect --doc --from --to` (Runbook §7.6: "First diverging sequence") — bisect is
 * already a real, built-in step of `auditDocument` itself (audit.ts's own `bisectSnapshotDivergence`,
 * invoked automatically the moment a mismatch is found against the latest snapshot) rather than a
 * separately-exported, independently-invokable function — there is no separate "just bisect,
 * without auditing first" code path to call. This command therefore runs the SAME audit and
 * surfaces its bisect result directly; `--from`/`--to` are accepted (so the command's own SHAPE
 * matches the Runbook table exactly) but are not yet threaded into a custom search range —
 * audit.ts's own bisect always searches this document's FULL snapshot history, which is a
 * reasonable, disclosed scope for what this command needs to answer ("which snapshot first
 * disagrees"), not a narrower windowed search.
 */
async function runBisect(documentId: string, verbose: boolean): Promise<void> {
  await withStore(async (store) => {
    const result = await auditDocument(documentId, store);
    if (result.result === "ok") {
      console.log(JSON.stringify({ documentId, result: "ok", detail: "no divergence found" }));
      return;
    }
    console.log(
      JSON.stringify({
        documentId,
        result: result.result,
        divergenceSeq: result.divergenceSeq?.toString() ?? null,
      }),
    );
    if (verbose) {
      console.log(result.detail);
    }
    process.exitCode = 1;
  });
}

/**
 * `./admin extract-case --doc --around` (Runbook §7.6: "Emit a regression-corpus fixture") — the
 * one genuinely NEW command this phase adds (every other DB-direct command wraps existing
 * functionality). Extracts the real, durably-committed operation window around `--around=<seq>`
 * (default window: 10 operations before and after) and writes it as a fixture matching this
 * project's own regression-corpus STRUCTURE (Test Plan §2.3: full operation stream, provenance,
 * date) — but deliberately does NOT auto-assign it the next `R####` number and drop it directly
 * into `tests/regression/`: Rule 1 ties a corpus entry to an actual fix landing in the SAME
 * change, which is a human decision this tool cannot make on its own. Instead this writes to
 * `tests/regression/extracted/` — the raw materials for a future corpus entry, ready for a human
 * investigator to root-cause and promote.
 */
async function runExtractCase(documentId: string, aroundSeq: bigint): Promise<void> {
  await withStore(async (store) => {
    const ops = await store.loadFullOperationLogWithSeq(documentId);
    const windowSize = 10n;
    const from = aroundSeq - windowSize < 0n ? 0n : aroundSeq - windowSize;
    const to = aroundSeq + windowSize;
    const windowOps = ops.filter((o) => o.seq >= from && o.seq <= to);
    if (windowOps.length === 0) {
      console.error(`extract-case: no operations found for document ${documentId} in seq range [${from}, ${to}]`);
      process.exitCode = 1;
      return;
    }
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const outDir = path.resolve(process.cwd(), "..", "..", "tests", "regression", "extracted");
    await fs.mkdir(outDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const fileName = `extracted-${documentId}-seq${aroundSeq}-${timestamp.slice(0, 10)}.json`;
    const outPath = path.join(outDir, fileName);
    const fixture = {
      extractedAt: timestamp,
      documentId,
      aroundSeq: aroundSeq.toString(),
      windowFromSeq: from.toString(),
      windowToSeq: to.toString(),
      operationStream: windowOps.map(({ seq, op }) => ({ seq: seq.toString(), op })),
      note:
        "Raw extraction, not yet a numbered R#### corpus entry (Test Plan §2.3 Rule 1 ties a corpus entry to a landed fix — a human decision). Promote by root-causing the divergence, then copying/renaming this file into tests/regression/ as R####-YYYY-MM-DD-short-description.json alongside the fix.",
    };
    await fs.writeFile(outPath, JSON.stringify(fixture, null, 2), "utf8");
    console.log(JSON.stringify({ documentId, aroundSeq: aroundSeq.toString(), opCount: windowOps.length, outPath }));
  });
}

// --- HTTP-based commands (materialize/gc/freeze/unfreeze/rebuild/doc-stats) ---

async function httpJson(url: string, method: "GET" | "POST", body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

async function runMaterialize(base: string, documentId: string): Promise<void> {
  const { status, body } = await httpJson(`${base}/v1/admin/documents/${documentId}/materialize`, "GET");
  console.log(JSON.stringify(body));
  if (status !== 200) process.exitCode = 1;
}

async function runDocStats(base: string, documentId: string): Promise<void> {
  const { status, body } = await httpJson(`${base}/v1/admin/documents/${documentId}/doc-stats`, "GET");
  console.log(JSON.stringify(body));
  if (status !== 200) process.exitCode = 1;
}

async function runFreeze(base: string, documentId: string, unfreeze: boolean): Promise<void> {
  const path = unfreeze ? "unfreeze" : "freeze";
  const { status, body } = await httpJson(`${base}/v1/admin/documents/${documentId}/${path}`, "POST");
  console.log(JSON.stringify(body));
  if (status !== 200) process.exitCode = 1;
}

async function runRebuild(base: string, documentId: string): Promise<void> {
  const { status, body } = await httpJson(`${base}/v1/admin/documents/${documentId}/rebuild`, "POST");
  console.log(JSON.stringify(body));
  if (status !== 200) process.exitCode = 1;
}

async function runGc(
  base: string,
  documentId: string | undefined,
  mode: "status" | "run-once" | "disable-all",
): Promise<void> {
  if (mode === "status") {
    const url = documentId ? `${base}/v1/admin/gc/status?doc=${documentId}` : `${base}/v1/admin/gc/status`;
    const { status, body } = await httpJson(url, "GET");
    console.log(JSON.stringify(body));
    if (status !== 200) process.exitCode = 1;
    return;
  }
  if (mode === "run-once") {
    if (!documentId) throw new UsageError("gc --run-once requires --doc=<documentId>");
    const { status, body } = await httpJson(`${base}/v1/admin/gc/run-once`, "POST", { doc: documentId });
    console.log(JSON.stringify(body));
    if (status !== 200) process.exitCode = 1;
    return;
  }
  const { status, body } = await httpJson(`${base}/v1/admin/gc/disable-all`, "POST");
  console.log(JSON.stringify(body));
  if (status !== 200) process.exitCode = 1;
}

// --- Legitimately-stubbed command shapes (Phases 40/39) ---

async function runReconstruct(base: string, documentId: string, seq: string): Promise<void> {
  const { status, body } = await httpJson(
    `${base}/v1/admin/documents/${documentId}/reconstruct?seq=${seq}`,
    "GET",
  );
  console.log(JSON.stringify(body));
  console.error("reconstruct is Phase 40's own job — this command's SHAPE works today; the capability does not exist yet.");
  if (status !== 501) process.exitCode = 1; // a 501 here IS the expected, honest outcome
}

async function runDeployHistory(base: string): Promise<void> {
  const { status, body } = await httpJson(`${base}/v1/admin/deploy-history`, "GET");
  console.log(JSON.stringify(body));
  console.error("deploy-history is Phase 39's own job — this command's SHAPE works today; the capability does not exist yet.");
  if (status !== 501) process.exitCode = 1;
}

function usage(): void {
  console.error(
    [
      "Usage: admin <command> [--doc=<documentId>] [flags...]",
      "",
      "DB-direct (connects to DATABASE_URL, no running server needed):",
      "  audit --doc=<id> [--verbose]",
      "  replay --doc=<id> [--build]",
      "  bisect --doc=<id> [--from=<seq>] [--to=<seq>] [--verbose]",
      "  extract-case --doc=<id> --around=<seq>",
      "",
      "HTTP-based (requires a running server; --server=http://host:port, default " +
        DEFAULT_SERVER_URL +
        "):",
      "  materialize --doc=<id>",
      "  doc-stats --doc=<id>",
      "  gc --status [--doc=<id>] | --run-once --doc=<id> | --disable-all",
      "  freeze --doc=<id> / unfreeze --doc=<id>",
      "  rebuild --doc=<id> --from-log",
      "",
      "Legitimately stubbed (Phases 40/39 — the shape works, the capability doesn't exist yet):",
      "  reconstruct --doc=<id> --seq=<seq>",
      "  deploy-history",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const { command, flags, bareFlags } = parseArgs(process.argv.slice(2));
  try {
    switch (command) {
      case "audit":
        await runAudit(requireDoc(flags), bareFlags.has("verbose"));
        return;
      case "replay":
        await runReplay(requireDoc(flags), bareFlags.has("build"));
        return;
      case "bisect":
        await runBisect(requireDoc(flags), bareFlags.has("verbose"));
        return;
      case "extract-case": {
        const around = flags.get("around");
        if (!around) throw new UsageError("extract-case requires --around=<seq>");
        await runExtractCase(requireDoc(flags), BigInt(around));
        return;
      }
      case "materialize":
        await runMaterialize(serverUrl(flags), requireDoc(flags));
        return;
      case "doc-stats":
        await runDocStats(serverUrl(flags), requireDoc(flags));
        return;
      case "freeze":
        await runFreeze(serverUrl(flags), requireDoc(flags), false);
        return;
      case "unfreeze":
        await runFreeze(serverUrl(flags), requireDoc(flags), true);
        return;
      case "rebuild":
        await runRebuild(serverUrl(flags), requireDoc(flags));
        return;
      case "gc": {
        const mode = bareFlags.has("run-once")
          ? "run-once"
          : bareFlags.has("disable-all")
            ? "disable-all"
            : "status";
        await runGc(serverUrl(flags), flags.get("doc"), mode);
        return;
      }
      case "reconstruct": {
        const seq = flags.get("seq");
        if (!seq) throw new UsageError("reconstruct requires --seq=<seq>");
        await runReconstruct(serverUrl(flags), requireDoc(flags), seq);
        return;
      }
      case "deploy-history":
        await runDeployHistory(serverUrl(flags));
        return;
      default:
        usage();
        process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`admin ${command}: ${err.message}`);
      usage();
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
