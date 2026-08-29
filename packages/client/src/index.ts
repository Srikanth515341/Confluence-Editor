// React app and editor binding — placeholder entry point.
// No feature code exists yet. This is the only package with DOM types in
// its tsconfig (see tsconfig.json "lib") — deliberately, since it is the
// DomWriter chokepoint's home (API Spec §7.1) and every other package must
// stay DOM-free.

export const CLIENT_PACKAGE_NAME = "@collab-editor/client";
