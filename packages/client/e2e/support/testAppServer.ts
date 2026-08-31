// Wraps scripts/serveApp.mjs (the same esbuild dev server Milestone M1's
// manual two-window demo uses) for E2E-CONV: each spec file serves the
// REAL app — the actual `index.html` + `src/app/main.tsx` bundle a real
// user opens — on its own ephemeral port, rather than reusing a fixed dev
// port that could collide across parallel spec files or a developer's own
// running `pnpm run dev`.

import { startAppServer as startAppServerImpl } from "../../scripts/serveApp.mjs";

export interface TestAppServerHandle {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startTestAppServer(): Promise<TestAppServerHandle> {
  const bound = (await startAppServerImpl(0)) as { url: string; stop: () => Promise<void> };
  return { url: bound.url, stop: bound.stop };
}
