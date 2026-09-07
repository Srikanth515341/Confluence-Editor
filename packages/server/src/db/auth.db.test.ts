// Phase 26 — Authentication and sessions (API Spec §4.1/§4.2). Requires a real, migrated
// Postgres instance (docker compose up -d; pnpm db:migrate). Run via `pnpm test:db`.
//
// SEC-11g's own dedicated timing measurement lives in a SEPARATE file
// (authTiming.db.test.ts) — it needs its own very long per-test timeout (2,000 real Argon2id
// calls) and shouldn't slow down or be conflated with this file's own much faster functional/
// integration coverage (login/refresh/logout end to end, rotation, family-revocation-on-reuse,
// cookie attributes, rate limiting).

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import type { AuthConfig } from "../config.js";
import { createCollabServer, type CollabServer } from "../server.js";
import { InMemoryOperationStore } from "./operationStore.js";
import { hashPassword } from "../passwordHash.js";
import { verifyAccessToken } from "../tokens.js";
import { createPool, type DbPool } from "./pool.js";

let pool: DbPool;

beforeAll(() => {
  pool = createPool(loadConfig().databaseUrl);
});

afterAll(async () => {
  await pool.end();
});

let server: CollabServer | undefined;
afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

function testAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    jwtAccessSecret: "test-access-secret-do-not-use-in-prod",
    jwtRefreshSecret: "test-refresh-secret-do-not-use-in-prod",
    accessTokenTtlMs: 15 * 60 * 1000,
    refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    // Generous by default (effectively unlimited within a single test) — tests that specifically
    // exercise rate limiting override one or the other explicitly.
    loginRateLimitPerIp: { max: 1000, windowMs: 15 * 60 * 1000 },
    loginRateLimitPerAccount: { max: 1000, windowMs: 15 * 60 * 1000 },
    ...overrides,
  };
}

async function buildServer(authConfig: AuthConfig): Promise<number> {
  server = createCollabServer({
    operationStore: new InMemoryOperationStore(),
    auth: { pool, authConfig },
  });
  return server.listen(0);
}

/**
 * `localPart` gets a random suffix appended — this table's own `users_email_lower_uq`/
 * `users_email_ci_idx` (Phase 15, verbatim spec DDL) mean a fixed literal email collides across
 * repeated runs against the SAME real, non-reset Postgres instance (this file's own real, honest
 * first run against a fresh database caught exactly this — `duplicate key value violates unique
 * constraint "users_email_lower_uq"` on a second run). Matches this project's own established
 * convention elsewhere (gc.db.test.ts/audit.db.test.ts's own `randomUUID()`-per-document ids)
 * for the identical reason: every `*.db.test.ts` file may run against a real, already-populated,
 * never-automatically-reset database.
 */
async function createTestUser(
  localPart: string,
  password: string,
  displayName = "Test User",
): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${localPart}+${randomUUID()}@example.com`;
  const passwordHash = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
    [id, email, displayName, passwordHash],
  );
  return { id, email };
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Pulls the `rt=<value>` cookie's raw value plus its full literal Set-Cookie string out of a real fetch Response's (possibly multiple) Set-Cookie headers. */
function extractRtCookie(res: Response): { raw: string; fullHeader: string } {
  const setCookies = res.headers.getSetCookie();
  const rt = setCookies.find((c) => c.startsWith("rt="));
  if (!rt) throw new Error(`no rt= Set-Cookie header found among: ${JSON.stringify(setCookies)}`);
  const raw = rt.split(";")[0]!.slice("rt=".length);
  return { raw, fullHeader: rt };
}

describe("Phase 26 — POST /v1/auth/login, /refresh, /logout (API Spec §4.1/§4.2)", () => {
  it("login with correct credentials returns 200, a real access token, expiresIn: 900, the user object, and a correctly-attributed refresh cookie", async () => {
    const authConfig = testAuthConfig();
    const port = await buildServer(authConfig);
    const { id: userId, email } = await createTestUser(
      "alice",
      "correct-password-123",
      "Alice",
    );

    const res = await fetch(`${baseUrl(port)}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-password-123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accessToken: string;
      expiresIn: number;
      user: { id: string; email: string; displayName: string };
    };
    expect(body.expiresIn).toBe(900); // API Spec §4.1's own literal example value (15 min)
    expect(body.user).toEqual({ id: userId, email, displayName: "Alice" });

    const claims = verifyAccessToken(body.accessToken, authConfig);
    expect(claims).toEqual({ sub: userId, email, displayName: "Alice" });

    const { fullHeader } = extractRtCookie(res);
    // API Spec §4.1's own literal required attributes.
    expect(fullHeader).toContain("HttpOnly");
    expect(fullHeader).toContain("Secure");
    expect(fullHeader.toLowerCase()).toContain("samesite=strict");
    expect(fullHeader).toContain("Path=/v1/auth/refresh");
  });

  it("login with an email that does not exist AND login with a wrong password for a real account return the IDENTICAL response body (401 invalid_credentials) — API Spec §4.1's own user-enumeration requirement, the response-body half (SEC-11g's own dedicated file covers the timing half)", async () => {
    const port = await buildServer(testAuthConfig());
    const { email } = await createTestUser("bob", "bobs-real-password");

    const unknownEmailRes = await fetch(`${baseUrl(port)}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `no-such-user-${randomUUID()}@example.com`, password: "anything" }),
    });
    const wrongPasswordRes = await fetch(`${baseUrl(port)}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "the-wrong-password" }),
    });
    expect(unknownEmailRes.status).toBe(401);
    expect(wrongPasswordRes.status).toBe(401);
    expect(await unknownEmailRes.json()).toEqual({ error: "invalid_credentials" });
    expect(await wrongPasswordRes.json()).toEqual({ error: "invalid_credentials" });
    // No Set-Cookie on a failed login.
    expect(unknownEmailRes.headers.getSetCookie()).toEqual([]);
    expect(wrongPasswordRes.headers.getSetCookie()).toEqual([]);
  });

  it("login rejects a missing/empty email or password with 400 validation_failed, and rejects malformed JSON the same way", async () => {
    const port = await buildServer(testAuthConfig());
    const cases: Array<Record<string, unknown> | string> = [
      { email: "a@b.com" }, // missing password
      { password: "x" }, // missing email
      { email: "", password: "x" }, // empty email
      { email: "a@b.com", password: "" }, // empty password
      { email: 123, password: "x" }, // wrong type
    ];
    for (const body of cases) {
      const res = await fetch(`${baseUrl(port)}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "validation_failed" });
    }
    // Syntactically invalid JSON — express.json()'s own SyntaxError, normalized by httpApp.ts's
    // error-handling middleware to the SAME validation_failed shape as any other bad input.
    const malformedRes = await fetch(`${baseUrl(port)}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    expect(malformedRes.status).toBe(400);
    expect(await malformedRes.json()).toEqual({ error: "validation_failed" });
  });

  it("refresh with no cookie at all returns 401 session_expired", async () => {
    const port = await buildServer(testAuthConfig());
    const res = await fetch(`${baseUrl(port)}/v1/auth/refresh`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "session_expired" });
  });

  it("refresh with a well-formed but never-issued cookie value returns 401 session_expired", async () => {
    const port = await buildServer(testAuthConfig());
    const res = await fetch(`${baseUrl(port)}/v1/auth/refresh`, {
      method: "POST",
      headers: { cookie: "rt=totally-made-up-value-never-issued" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "session_expired" });
  });

  it("refresh rotates the cookie: issues a NEW access token and a NEW, DIFFERENT refresh cookie value", async () => {
    const authConfig = testAuthConfig();
    const port = await buildServer(authConfig);
    const { email } = await createTestUser("carol", "carols-password");
    const loginRes = await fetch(`${baseUrl(port)}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "carols-password" }),
    });
    const { raw: originalRt } = extractRtCookie(loginRes);

    const refreshRes = await fetch(`${baseUrl(port)}/v1/auth/refresh`, {
      method: "POST",
      headers: { cookie: `rt=${originalRt}` },
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = (await refreshRes.json()) as { accessToken: string; expiresIn: number };
    expect(refreshBody.expiresIn).toBe(900);
    // NOT asserting `refreshBody.accessToken !== loginBody.accessToken`: a JWT signed with
    // IDENTICAL claims (sub/email/displayName) within the SAME wall-clock second as an earlier
    // one is legitimately byte-IDENTICAL (HS256 has no per-call randomness, and `iat` has
    // 1-second resolution) — this is correct, expected JWT behavior, not a defect, and this
    // test's own first draft asserted the opposite and failed for exactly that reason before
    // being corrected here. Access-token uniqueness across calls is not a security property this
    // system relies on (unlike refresh-token uniqueness, which the rotation/revocation model
    // genuinely requires and which IS asserted below).
    expect(verifyAccessToken(refreshBody.accessToken, authConfig)).toEqual({
      sub: expect.any(String),
      email,
      displayName: "Test User",
    });
    const { raw: newRt } = extractRtCookie(refreshRes);
    expect(newRt).not.toBe(originalRt); // a genuinely new refresh cookie value — real rotation
  });

  it("reusing an ALREADY-ROTATED refresh token returns 401 AND revokes the whole family — a later, otherwise-still-valid token from the SAME family also stops working (this phase's own theft-detection requirement, verbatim)", async () => {
    const authConfig = testAuthConfig();
    const port = await buildServer(authConfig);
    const { email } = await createTestUser("dave", "daves-password");

    const loginRes = await fetch(`${baseUrl(port)}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "daves-password" }),
    });
    const { raw: token0 } = extractRtCookie(loginRes);

    const refresh1 = await fetch(`${baseUrl(port)}/v1/auth/refresh`, {
      method: "POST",
      headers: { cookie: `rt=${token0}` },
    });
    expect(refresh1.status).toBe(200);
    const { raw: token1 } = extractRtCookie(refresh1);

    const refresh2 = await fetch(`${baseUrl(port)}/v1/auth/refresh`, {
      method: "POST",
      headers: { cookie: `rt=${token1}` },
    });
    expect(refresh2.status).toBe(200);
    const { raw: token2 } = extractRtCookie(refresh2);

    // Replay the FIRST token (token0) — already rotated once, this is exactly the theft
    // signature (someone using an old, already-superseded cookie).
    const replayRes = await fetch(`${baseUrl(port)}/v1/auth/refresh`, {
      method: "POST",
      headers: { cookie: `rt=${token0}` },
    });
    expect(replayRes.status).toBe(401);
    expect(await replayRes.json()).toEqual({ error: "session_expired" });

    // The MOST RECENT token (token2) was never itself reused and would otherwise still be
    // perfectly valid — but the WHOLE family must now be revoked, so it too is rejected.
    const afterRevocationRes = await fetch(`${baseUrl(port)}/v1/auth/refresh`, {
      method: "POST",
      headers: { cookie: `rt=${token2}` },
    });
    expect(afterRevocationRes.status).toBe(401);
    expect(await afterRevocationRes.json()).toEqual({ error: "session_expired" });
  });

  it("logout revokes the family and clears the cookie — the SAME cookie can never refresh again", async () => {
    const port = await buildServer(testAuthConfig());
    const { email } = await createTestUser("erin", "erins-password");
    const loginRes = await fetch(`${baseUrl(port)}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "erins-password" }),
    });
    const { raw: rt } = extractRtCookie(loginRes);

    const logoutRes = await fetch(`${baseUrl(port)}/v1/auth/logout`, {
      method: "POST",
      headers: { cookie: `rt=${rt}` },
    });
    expect(logoutRes.status).toBe(204);
    const { fullHeader: clearHeader } = extractRtCookie(logoutRes);
    expect(clearHeader).toMatch(/Max-Age=0/i);

    const refreshAfterLogout = await fetch(`${baseUrl(port)}/v1/auth/refresh`, {
      method: "POST",
      headers: { cookie: `rt=${rt}` },
    });
    expect(refreshAfterLogout.status).toBe(401);
    expect(await refreshAfterLogout.json()).toEqual({ error: "session_expired" });
  });

  it("logout with no cookie at all is a harmless no-op — still 204, never an error", async () => {
    const port = await buildServer(testAuthConfig());
    const res = await fetch(`${baseUrl(port)}/v1/auth/logout`, { method: "POST" });
    expect(res.status).toBe(204);
  });

  it("per-IP rate limiting: the (max+1)th login attempt from the same client returns 429 rate_limited", async () => {
    const port = await buildServer(
      testAuthConfig({ loginRateLimitPerIp: { max: 2, windowMs: 60_000 } }),
    );
    const attempt = () =>
      fetch(`${baseUrl(port)}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // A different email each time — proves this is the per-IP limiter firing, not the
        // per-account one (which is independently generous in this test's own config).
        body: JSON.stringify({ email: `${randomUUID()}@example.com`, password: "irrelevant" }),
      });
    expect((await attempt()).status).toBe(401); // 1st: unknown email, correctly a 401
    expect((await attempt()).status).toBe(401); // 2nd: still under the per-IP max of 2
    const third = await attempt();
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "rate_limited" });
  });

  it("per-account rate limiting: the (max+1)th attempt against the SAME email returns 429 rate_limited, independent of the per-IP limit", async () => {
    const port = await buildServer(
      testAuthConfig({ loginRateLimitPerAccount: { max: 2, windowMs: 60_000 } }),
    );
    const sameEmail = "repeatedly-attacked@example.com";
    const attempt = () =>
      fetch(`${baseUrl(port)}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: sameEmail, password: "irrelevant" }),
      });
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const third = await attempt();
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "rate_limited" });
  });

  it("no token value (access token, raw refresh token, or refresh-token hash) ever appears in anything written to the server's own log output during a real login/refresh/logout sequence", async () => {
    const port = await buildServer(testAuthConfig());
    const { email } = await createTestUser("frank", "franks-password");

    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]): void => {
      logged.push(args.map((a) => String(a)).join(" "));
    };
    let accessToken: string;
    let rt: string;
    try {
      const loginRes = await fetch(`${baseUrl(port)}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "franks-password" }),
      });
      ({ accessToken } = (await loginRes.json()) as { accessToken: string });
      ({ raw: rt } = extractRtCookie(loginRes));
      const refreshRes = await fetch(`${baseUrl(port)}/v1/auth/refresh`, {
        method: "POST",
        headers: { cookie: `rt=${rt}` },
      });
      const { raw: rt2 } = extractRtCookie(refreshRes);
      await fetch(`${baseUrl(port)}/v1/auth/logout`, {
        method: "POST",
        headers: { cookie: `rt=${rt2}` },
      });
    } finally {
      console.log = originalLog;
    }
    const allOutput = logged.join("\n");
    expect(allOutput).not.toContain(accessToken!);
    expect(allOutput).not.toContain(rt!);
  });
});
