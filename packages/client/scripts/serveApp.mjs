// Dev/demo server for the Phase 14 app (Scope-IN: "A minimal React app").
// Uses esbuild's own `serve()` — already a devDependency for this
// project's e2e bundles (e2e/build-bundle.mjs) — instead of adding Vite or
// another bundler: it serves `app/index.html` as a static file AND
// compiles `src/app/main.tsx` on demand for every request to `/main.js`,
// with no separate build step and no dist/ output committed anywhere.
//
// Used two ways:
//   1. Manually, for Milestone M1's own two-window demo:
//      `pnpm --filter @collab-editor/client run dev` (fixed port 5173).
//   2. By Playwright's E2E-CONV suite (e2e/support/testAppServer.ts), which
//      calls `startAppServer(0)` for an ephemeral port per test run.

import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "app");
const entry = path.join(here, "..", "src", "app", "main.tsx");

/**
 * Starts the dev server. `port: 0` picks an ephemeral port (test use);
 * omit for the fixed manual-demo default. Returns the bound `url` and a
 * `stop()` that tears down the esbuild watch context.
 */
export async function startAppServer(port = 5173, host = "127.0.0.1") {
  const ctx = await esbuild.context({
    entryPoints: [entry],
    bundle: true,
    outfile: path.join(appDir, "main.js"),
    format: "iife",
    target: "es2022",
    platform: "browser",
    jsx: "automatic",
    sourcemap: true,
    logLevel: "warning",
  });
  const bound = await ctx.serve({ servedir: appDir, port, host });
  const displayHost = bound.host === "0.0.0.0" ? "127.0.0.1" : bound.host;
  return {
    host: bound.host,
    port: bound.port,
    url: `http://${displayHost}:${bound.port}/`,
    stop: () => ctx.dispose(),
  };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const { url } = await startAppServer();
  console.log(`Confluence Editor client dev server running at ${url}`);
  console.log(`Open ${url}?doc=demo in two browser windows for the M1 convergence demo.`);
}
