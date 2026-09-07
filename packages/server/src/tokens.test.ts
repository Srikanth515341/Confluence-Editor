import { describe, expect, it } from "vitest";
import type { AuthConfig } from "./config.js";
import {
  accessTokenTtlSeconds,
  generateRawRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from "./tokens.js";

function fakeAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    jwtAccessSecret: "test-access-secret",
    jwtRefreshSecret: "test-refresh-secret",
    accessTokenTtlMs: 15 * 60 * 1000,
    refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    loginRateLimitPerIp: { max: 20, windowMs: 15 * 60 * 1000 },
    loginRateLimitPerAccount: { max: 5, windowMs: 15 * 60 * 1000 },
    ...overrides,
  };
}

describe("tokens (Phase 26, API Spec §4.1/§4.2)", () => {
  it("accessTokenTtlSeconds converts ms to seconds — API Spec §4.1's literal expiresIn: 900 for a 15-minute default", () => {
    expect(accessTokenTtlSeconds(fakeAuthConfig())).toBe(900);
  });

  it("signAccessToken/verifyAccessToken round-trip the exact claims", () => {
    const config = fakeAuthConfig();
    const token = signAccessToken(
      { sub: "user-1", email: "a@b.com", displayName: "A B" },
      config,
    );
    const claims = verifyAccessToken(token, config);
    expect(claims).toEqual({ sub: "user-1", email: "a@b.com", displayName: "A B" });
  });

  it("verifyAccessToken returns null (never throws) for a token signed with a DIFFERENT secret", () => {
    const config = fakeAuthConfig();
    const token = signAccessToken({ sub: "u", email: "e", displayName: "d" }, config);
    const wrongConfig = fakeAuthConfig({ jwtAccessSecret: "a-different-secret" });
    expect(verifyAccessToken(token, wrongConfig)).toBeNull();
  });

  it("verifyAccessToken returns null for a garbage string, not a thrown exception", () => {
    expect(verifyAccessToken("not.a.jwt", fakeAuthConfig())).toBeNull();
  });

  it("verifyAccessToken returns null for an already-expired token", () => {
    // 1 second — the smallest TTL `accessTokenTtlSeconds` rounds to a genuinely non-zero value
    // (jsonwebtoken's own `exp` claim has 1-second resolution; a sub-second TTL would round to
    // 0, which `expiresIn` treats as "no expiration" rather than "expires immediately").
    const config = fakeAuthConfig({ accessTokenTtlMs: 1000 });
    const token = signAccessToken({ sub: "u", email: "e", displayName: "d" }, config);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(verifyAccessToken(token, config)).toBeNull();
        resolve();
      }, 1500);
    });
  });

  it("generateRawRefreshToken produces distinct, high-entropy values every call", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateRawRefreshToken()));
    expect(tokens.size).toBe(100);
    for (const t of tokens) {
      expect(t.length).toBeGreaterThan(32); // base64url of 32 raw bytes is well over 32 chars
    }
  });

  it("hashRefreshToken is deterministic for the same (token, secret) pair", () => {
    const config = fakeAuthConfig();
    const raw = generateRawRefreshToken();
    expect(hashRefreshToken(raw, config)).toBe(hashRefreshToken(raw, config));
  });

  it("hashRefreshToken produces a DIFFERENT hash under a different secret — the 'pepper' property", () => {
    const raw = generateRawRefreshToken();
    const a = hashRefreshToken(raw, fakeAuthConfig({ jwtRefreshSecret: "secret-a" }));
    const b = hashRefreshToken(raw, fakeAuthConfig({ jwtRefreshSecret: "secret-b" }));
    expect(a).not.toBe(b);
  });

  it("hashRefreshToken never reproduces the raw token itself in its output (a real, if crude, check that this isn't accidentally an identity/no-op function)", () => {
    const config = fakeAuthConfig();
    const raw = generateRawRefreshToken();
    expect(hashRefreshToken(raw, config)).not.toBe(raw);
  });
});
