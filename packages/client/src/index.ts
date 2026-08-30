// React app and editor binding. This is the only package with DOM types in
// its tsconfig (see tsconfig.json "lib") — deliberately, since it is the
// DomWriter chokepoint's home (API Spec §7.1) and every other package must
// stay DOM-free. Phase 10 built src/sync/ (the connection manager) — no
// editor binding or DOM writer exists yet (later phases).

export const CLIENT_PACKAGE_NAME = "@collab-editor/client";

export * from "./sync/index.js";
