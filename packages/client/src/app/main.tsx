// Browser entry point (Phase 14). Bundled by scripts/serveApp.mjs; never
// imported by the library surface (packages/client/src/index.ts) — this
// file has a side effect (mounting into a real DOM) that a library import
// must never trigger.

import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("main.tsx: #root element not found — check app/index.html");
}
createRoot(container).render(<App />);
