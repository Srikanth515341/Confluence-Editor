// Phase 26 — Argon2id password hashing (API Spec §4.1's own explicit "Argon2id password
// hashing" requirement; Test Plan SEC-11g). Isolated in its own module, not inlined into
// authService.ts, so it can be unit-tested directly and so `DUMMY_PASSWORD_HASH` (below) is
// computed exactly once, at module load, regardless of how many times `attemptLogin` needs it.

import argon2 from "argon2";

/**
 * `type: argon2.argon2id` is passed explicitly even though the installed `argon2` package's own
 * current default already happens to be argon2id (confirmed by inspecting a real hash output:
 * `$argon2id$v=19$m=65536,p=4,t=3$...`) — API Spec §4.1 names Argon2id specifically, and this
 * project does not rely on a third-party library's current default matching a security
 * requirement by coincidence; a future library version changing its default would silently
 * violate the spec otherwise.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/**
 * Returns `false` (never throws) for ANY input `verify()` itself rejects — not just a wrong
 * password, but also a `storedHash` that isn't valid Argon2 output at all. This matters beyond
 * defensive coding: this project already has non-loggable-in placeholder `password_hash` values
 * for rows auto-provisioned outside real registration (`operationStore.ts`'s
 * `SYSTEM_USER_PASSWORD_HASH_PLACEHOLDER`, and — before this phase's own seed.ts update — the
 * dev seed user). `argon2.verify()` THROWS on a malformed hash string rather than returning
 * `false`; letting that propagate would crash the request handler instead of correctly reporting
 * "these credentials don't match," and — worse — an uncaught throw for a placeholder-hash row
 * but a clean `false` return for a real-but-wrong-password row would itself be exactly the kind
 * of code-path-dependent behavior SEC-11g's whole timing requirement exists to eliminate one
 * layer up (a thrown-vs-returned difference is a functional oracle, even before timing enters
 * into it) — so this is folded into ONE normalized boolean-returning function, deliberately.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, password);
  } catch {
    return false;
  }
}

/**
 * A fixed Argon2id hash of an arbitrary, never-used-elsewhere dummy password, computed ONCE at
 * module load (not per-request) — `attemptLogin` (authService.ts) verifies the submitted
 * password against this EXACT hash whenever the submitted email doesn't match any real user, so
 * the expensive Argon2id comparison always runs, on every login attempt, regardless of whether
 * the email exists (SEC-11g's own required fix: "hash the submitted password against either the
 * real stored hash... or a fixed, pre-computed dummy hash"). `hashPassword()`'s own
 * `argon2.hash()` call already produces argon2id output with this library's real default cost
 * parameters — the SAME parameters every real user's own stored hash was produced with — so a
 * comparison against this dummy costs the library exactly as much CPU work as a comparison
 * against any real stored hash. Computed lazily (once, cached) rather than at import time: doing
 * real Argon2id work as an import-time side effect would slow down importing this module even in
 * contexts that never call `attemptLogin` at all (e.g. a future test that only exercises
 * `hashPassword`/`verifyPassword` directly).
 */
let dummyHashPromise: Promise<string> | undefined;
export function getDummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("correct horse battery staple — never a real user's password");
  return dummyHashPromise;
}
