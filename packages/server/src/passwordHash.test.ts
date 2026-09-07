import { describe, expect, it } from "vitest";
import { getDummyPasswordHash, hashPassword, verifyPassword } from "./passwordHash.js";

describe("passwordHash (Phase 26, API Spec §4.1 — Argon2id)", () => {
  it("hashPassword produces a real Argon2id hash string", async () => {
    const hash = await hashPassword("a real password");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("verifyPassword returns true for the correct password and false for a wrong one", async () => {
    const hash = await hashPassword("correct-password");
    await expect(verifyPassword(hash, "correct-password")).resolves.toBe(true);
    await expect(verifyPassword(hash, "wrong-password")).resolves.toBe(false);
  });

  it("verifyPassword returns false (never throws) for a malformed/placeholder hash", async () => {
    // Exactly the shape of this project's own non-loggable-in placeholders
    // (operationStore.ts's SYSTEM_USER_PASSWORD_HASH_PLACEHOLDER, and pre-Phase-26 seed data) —
    // argon2.verify() throws on these; this function must not propagate that.
    await expect(verifyPassword("unset:not-a-real-hash:phase-26-29", "anything")).resolves.toBe(
      false,
    );
    await expect(verifyPassword("", "anything")).resolves.toBe(false);
  });

  it("getDummyPasswordHash returns a stable, real Argon2id hash, computed once and cached", async () => {
    const [a, b] = await Promise.all([getDummyPasswordHash(), getDummyPasswordHash()]);
    expect(a).toBe(b);
    expect(a.startsWith("$argon2id$")).toBe(true);
  });

  it("the dummy hash is genuinely a DIFFERENT hash than a real user's own hash for the same submitted password (never a shortcut/shared value)", async () => {
    const dummy = await getDummyPasswordHash();
    const real = await hashPassword("some password a real user chose");
    expect(dummy).not.toBe(real);
  });
});
