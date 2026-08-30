// Bundles packages/client/src/binding into one browser-loadable, dependency-free
// script (no @collab-editor/engine — Playwright's own tests don't need it; the
// Engine-dependent DOM-01 assertion runs in plain Node/Vitest instead, see
// domEngineConsistency.test.ts) exposing everything under a single global,
// `Binding`. Playwright has no dev server in this project yet, so tests load
// this file directly via `page.addScriptTag({ path })` (e2e/binding.spec.ts) —
// this script is the one-time build step that makes that possible.
//
// Run via `pnpm test:e2e:build` (or automatically as part of `pnpm test:e2e`).

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, "..", "src", "binding", "index.ts")],
  bundle: true,
  format: "iife",
  globalName: "Binding",
  outfile: path.join(here, ".bundle", "binding.js"),
  target: "es2022",
  platform: "browser",
  logLevel: "info",
});
