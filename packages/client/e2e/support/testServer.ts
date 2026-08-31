// A REAL `@collab-editor/server` instance for E2E-CONV (Test Plan §2.7) —
// per this phase's own infrastructure note: "these E2E tests need a REAL
// server process running... not the headless in-process harness from
// Phase 10." `createCollabServer()` (Phase 8) IS that real server: a real
// `http.Server` + real `WebSocketServer` bound to a real TCP port, which
// real browsers (Chromium/Firefox/WebKit, launched by the E2E-CONV spec)
// connect to over a real loopback socket — indistinguishable, at the
// network/protocol level a browser observes, from a separate OS process.
//
// Deliberately NOT a shared `globalSetup`/`globalTeardown`: Playwright's
// global setup/teardown hooks run in a process that doesn't share memory
// with the actual test files, so a server object created there wouldn't be
// directly killable/restartable from within a specific test (E2E-CONV-03's
// own requirement: "make sure the process handle is accessible to that
// specific test"). Each spec file instead starts and stops its OWN server
// via `test.beforeAll`/`test.afterAll` — the phase brief's own "(or
// equivalent)" for the globalSetup/globalTeardown request — which runs in
// the SAME Node process as that file's tests, giving direct handle access.

import { createCollabServer, type CollabServer } from "@collab-editor/server";

export interface TestServerHandle {
  readonly server: CollabServer;
  readonly port: number;
  readonly wsUrl: string;
}

export async function startTestServer(): Promise<TestServerHandle> {
  const server = createCollabServer();
  const port = await server.listen(0); // ephemeral — never collides across parallel spec files
  return { server, port, wsUrl: `ws://127.0.0.1:${port}/v1/rt` };
}
