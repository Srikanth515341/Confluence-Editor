import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import type { AuthConfig } from "./config.js";
import { requireAuth, type AuthLocals } from "./authMiddleware.js";
import { signAccessToken } from "./tokens.js";

function fakeAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    jwtAccessSecret: "test-secret",
    jwtRefreshSecret: "test-refresh-secret",
    accessTokenTtlMs: 15 * 60 * 1000,
    refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    loginRateLimitPerIp: { max: 20, windowMs: 900_000 },
    loginRateLimitPerAccount: { max: 5, windowMs: 900_000 },
    ...overrides,
  };
}

function fakeRequest(authorization?: string): Request {
  return { headers: { authorization } } as unknown as Request;
}

function fakeResponse(): Response & { locals: Record<string, unknown> } {
  const res = {
    locals: { requestId: "req-test" },
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { locals: Record<string, unknown> };
}

describe("requireAuth (Phase 27, Test Plan §11.1's missing-auth/expired-token row)", () => {
  it("calls next() and attaches the verified claims to res.locals.user for a valid Bearer token", () => {
    const config = fakeAuthConfig();
    const token = signAccessToken({ sub: "u1", email: "a@b.com", displayName: "A" }, config);
    const req = fakeRequest(`Bearer ${token}`);
    const res = fakeResponse();
    const next = vi.fn() as NextFunction;

    requireAuth(config)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect((res.locals as unknown as AuthLocals).user).toEqual({
      sub: "u1",
      email: "a@b.com",
      displayName: "A",
    });
  });

  it("401 unauthenticated (never next()) when the Authorization header is missing entirely", () => {
    const config = fakeAuthConfig();
    const req = fakeRequest(undefined);
    const res = fakeResponse();
    const next = vi.fn() as NextFunction;

    requireAuth(config)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      error: { code: string; requestId: string };
    };
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.requestId).toBe("req-test");
  });

  it("401 unauthenticated when the header isn't the 'Bearer <token>' shape", () => {
    const config = fakeAuthConfig();
    const req = fakeRequest("Basic dXNlcjpwYXNz");
    const res = fakeResponse();
    const next = vi.fn() as NextFunction;

    requireAuth(config)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { error: { code: string } };
    expect(body.error.code).toBe("unauthenticated");
  });

  it("401 unauthenticated for a token signed with the wrong secret", () => {
    const config = fakeAuthConfig();
    const token = signAccessToken({ sub: "u", email: "e", displayName: "d" }, fakeAuthConfig({ jwtAccessSecret: "other" }));
    const req = fakeRequest(`Bearer ${token}`);
    const res = fakeResponse();
    const next = vi.fn() as NextFunction;

    requireAuth(config)(req, res, next);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { error: { code: string } };
    expect(body.error.code).toBe("unauthenticated");
  });

  it("401 session_expired — the SPECIFIC code, not a generic unauthenticated — for a genuinely expired token", async () => {
    const config = fakeAuthConfig({ accessTokenTtlMs: 1000 });
    const token = signAccessToken({ sub: "u", email: "e", displayName: "d" }, config);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const req = fakeRequest(`Bearer ${token}`);
    const res = fakeResponse();
    const next = vi.fn() as NextFunction;

    requireAuth(config)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { error: { code: string } };
    expect(body.error.code).toBe("session_expired");
  });
});
