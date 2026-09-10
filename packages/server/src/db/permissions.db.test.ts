// Phase 28 — Permissions and per-operation authorization (API Spec §4.7-§4.9; Test Plan
// SEC-07). Requires a real, migrated Postgres instance (docker compose up -d; pnpm db:migrate).
// Run via `pnpm test:db`. SEC-01/02/03/06 (the WS-layer, per-operation authorization checks) live
// in packages/server/src/permissions.test.ts — no real Postgres needed there, since those checks
// operate entirely on in-memory `DocumentCoordinator`/`CoordinatorSession` state. This file is
// scoped to what genuinely needs a real database: the three new REST endpoints
// (PUT/DELETE .../permissions/{userId}, POST .../owner) and, above all, SEC-07's own atomicity
// claim, which is meaningless without a real transactional database enforcing
// `docperm_single_owner_idx` under genuine concurrent load.

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import type { AuthConfig } from "../config.js";
import { createCollabServer, type CollabServer } from "../server.js";
import { PostgresOperationStore } from "./operationStore.js";
import { hashPassword } from "../passwordHash.js";
import { createPool, type DbPool } from "./pool.js";

let pool: DbPool;

beforeAll(() => {
  pool = createPool(loadConfig().databaseUrl);
});

afterAll(async () => {
  await pool.end();
});

let servers: CollabServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

function testAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    jwtAccessSecret: "test-access-secret-do-not-use-in-prod",
    jwtRefreshSecret: "test-refresh-secret-do-not-use-in-prod",
    accessTokenTtlMs: 15 * 60 * 1000,
    refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    loginRateLimitPerIp: { max: 1000, windowMs: 15 * 60 * 1000 },
    loginRateLimitPerAccount: { max: 1000, windowMs: 15 * 60 * 1000 },
    ticketTtlMs: 30_000,
    ticketRateLimit: { max: 1000, windowMs: 60 * 1000 },
    ...overrides,
  };
}

async function buildServer(authConfig: AuthConfig = testAuthConfig()): Promise<number> {
  const server = createCollabServer({
    operationStore: new PostgresOperationStore(pool),
    auth: { pool, authConfig },
  });
  servers.push(server);
  return server.listen(0);
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

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

async function login(port: number, email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl(port)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

function authed(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function createDocumentAs(port: number, token: string, title: string): Promise<string> {
  const res = await fetch(`${baseUrl(port)}/v1/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authed(token) },
    body: JSON.stringify({ title }),
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function grantPermissionDirect(
  documentId: string,
  userId: string,
  role: "editor" | "viewer",
  grantedBy: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO document_permissions (document_id, user_id, role, granted_by) VALUES ($1, $2, $3, $4)`,
    [documentId, userId, role, grantedBy],
  );
}

async function permissionRow(
  documentId: string,
  userId: string,
): Promise<{ role: string } | undefined> {
  const { rows } = await pool.query<{ role: string }>(
    `SELECT role FROM document_permissions WHERE document_id = $1 AND user_id = $2`,
    [documentId, userId],
  );
  return rows[0];
}

describe("Phase 28 — Permissions REST endpoints (API Spec §4.7-§4.9)", () => {
  it("PUT .../permissions/{userId}: owner-only, grants/changes a role, rejects invalid role/self/unknown user, and returns effectiveAtSeq", async () => {
    const port = await buildServer();
    const owner = await createTestUser("put-owner", "pw");
    const editor = await createTestUser("put-editor", "pw");
    const target = await createTestUser("put-target", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const editorToken = await login(port, editor.email, "pw");
    const documentId = await createDocumentAs(port, ownerToken, "Shared");
    await grantPermissionDirect(documentId, editor.id, "editor", owner.id);

    // Non-owner (editor) may not grant.
    const editorAttempt = await fetch(
      `${baseUrl(port)}/v1/documents/${documentId}/permissions/${target.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...authed(editorToken) },
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    expect(editorAttempt.status).toBe(403);
    expect(((await editorAttempt.json()) as { error: { code: string } }).error.code).toBe(
      "permission_denied",
    );

    // Invalid role.
    const badRole = await fetch(
      `${baseUrl(port)}/v1/documents/${documentId}/permissions/${target.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...authed(ownerToken) },
        body: JSON.stringify({ role: "owner" }),
      },
    );
    expect(badRole.status).toBe(400);
    expect(((await badRole.json()) as { error: { code: string } }).error.code).toBe(
      "validation_failed",
    );

    // Owner tries to change their OWN role via this endpoint — 409, use POST /owner instead.
    const selfAttempt = await fetch(
      `${baseUrl(port)}/v1/documents/${documentId}/permissions/${owner.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...authed(ownerToken) },
        body: JSON.stringify({ role: "editor" }),
      },
    );
    expect(selfAttempt.status).toBe(409);
    expect(((await selfAttempt.json()) as { error: { code: string } }).error.code).toBe(
      "cannot_change_own_owner_role",
    );

    // Unknown target user.
    const unknownUser = await fetch(
      `${baseUrl(port)}/v1/documents/${documentId}/permissions/${randomUUID()}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...authed(ownerToken) },
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    expect(unknownUser.status).toBe(404);
    expect(((await unknownUser.json()) as { error: { code: string } }).error.code).toBe(
      "user_not_found",
    );

    // A genuinely nonexistent document — 404 document_not_found (same enumeration-oracle rule as
    // every other route in this project).
    const noDoc = await fetch(
      `${baseUrl(port)}/v1/documents/${randomUUID()}/permissions/${target.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...authed(ownerToken) },
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    expect(noDoc.status).toBe(404);

    // The real, successful grant.
    const grant = await fetch(
      `${baseUrl(port)}/v1/documents/${documentId}/permissions/${target.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...authed(ownerToken) },
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    expect(grant.status).toBe(200);
    const grantBody = (await grant.json()) as {
      documentId: string;
      userId: string;
      role: string;
      grantedBy: string;
      grantedAt: string;
      effectiveAtSeq: number;
    };
    expect(grantBody).toMatchObject({
      documentId,
      userId: target.id,
      role: "viewer",
      grantedBy: owner.id,
    });
    expect(new Date(grantBody.grantedAt).toString()).not.toBe("Invalid Date");
    expect(typeof grantBody.effectiveAtSeq).toBe("number");
    expect(await permissionRow(documentId, target.id)).toEqual({ role: "viewer" });

    // Changing an already-granted user's role UPDATEs the same row.
    const change = await fetch(
      `${baseUrl(port)}/v1/documents/${documentId}/permissions/${target.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...authed(ownerToken) },
        body: JSON.stringify({ role: "editor" }),
      },
    );
    expect(change.status).toBe(200);
    expect(await permissionRow(documentId, target.id)).toEqual({ role: "editor" });
  });

  it("DELETE .../permissions/{userId}: owner-only, revokes a role, 409s on the owner's own row, 404s a target with no access", async () => {
    const port = await buildServer();
    const owner = await createTestUser("del-owner", "pw");
    const editor = await createTestUser("del-editor", "pw");
    const viewer = await createTestUser("del-viewer", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const editorToken = await login(port, editor.email, "pw");
    const documentId = await createDocumentAs(port, ownerToken, "Shared");
    await grantPermissionDirect(documentId, editor.id, "editor", owner.id);
    await grantPermissionDirect(documentId, viewer.id, "viewer", owner.id);

    const editorAttempt = await fetch(
      `${baseUrl(port)}/v1/documents/${documentId}/permissions/${viewer.id}`,
      { method: "DELETE", headers: authed(editorToken) },
    );
    expect(editorAttempt.status).toBe(403);

    const revokeOwner = await fetch(
      `${baseUrl(port)}/v1/documents/${documentId}/permissions/${owner.id}`,
      { method: "DELETE", headers: authed(ownerToken) },
    );
    expect(revokeOwner.status).toBe(409);
    expect(((await revokeOwner.json()) as { error: { code: string } }).error.code).toBe(
      "cannot_revoke_owner",
    );

    const revokeUnknown = await fetch(
      `${baseUrl(port)}/v1/documents/${documentId}/permissions/${randomUUID()}`,
      { method: "DELETE", headers: authed(ownerToken) },
    );
    expect(revokeUnknown.status).toBe(404);

    const revoke = await fetch(
      `${baseUrl(port)}/v1/documents/${documentId}/permissions/${viewer.id}`,
      { method: "DELETE", headers: authed(ownerToken) },
    );
    expect(revoke.status).toBe(204);
    expect(await permissionRow(documentId, viewer.id)).toBeUndefined();

    // The editor's own row is untouched by revoking someone else's.
    expect(await permissionRow(documentId, editor.id)).toEqual({ role: "editor" });
  });

  it("POST .../owner: owner-only, transfers ownership atomically (old owner becomes editor, target becomes owner), 409s a target with no existing access", async () => {
    const port = await buildServer();
    const owner = await createTestUser("xfer-owner", "pw");
    const editor = await createTestUser("xfer-editor", "pw");
    const outsider = await createTestUser("xfer-outsider", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const editorToken = await login(port, editor.email, "pw");
    const documentId = await createDocumentAs(port, ownerToken, "Shared");
    await grantPermissionDirect(documentId, editor.id, "editor", owner.id);

    const editorAttempt = await fetch(`${baseUrl(port)}/v1/documents/${documentId}/owner`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authed(editorToken) },
      body: JSON.stringify({ newOwnerId: editor.id }),
    });
    expect(editorAttempt.status).toBe(403);

    const noAccess = await fetch(`${baseUrl(port)}/v1/documents/${documentId}/owner`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authed(ownerToken) },
      body: JSON.stringify({ newOwnerId: outsider.id }),
    });
    expect(noAccess.status).toBe(409);
    expect(((await noAccess.json()) as { error: { code: string } }).error.code).toBe(
      "target_has_no_access",
    );

    const missingBody = await fetch(`${baseUrl(port)}/v1/documents/${documentId}/owner`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authed(ownerToken) },
      body: JSON.stringify({}),
    });
    expect(missingBody.status).toBe(400);

    const transfer = await fetch(`${baseUrl(port)}/v1/documents/${documentId}/owner`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authed(ownerToken) },
      body: JSON.stringify({ newOwnerId: editor.id }),
    });
    expect(transfer.status).toBe(200);
    const body = (await transfer.json()) as { ownerId: string; role: string };
    expect(body.ownerId).toBe(editor.id);
    expect(body.role).toBe("editor"); // the CALLER's own post-transfer role

    expect(await permissionRow(documentId, editor.id)).toEqual({ role: "owner" });
    expect(await permissionRow(documentId, owner.id)).toEqual({ role: "editor" });
    const { rows } = await pool.query<{ owner_id: string }>(
      `SELECT owner_id FROM documents WHERE id = $1`,
      [documentId],
    );
    expect(rows[0]?.owner_id).toBe(editor.id);

    // The former owner can no longer transfer ownership again — they're an editor now.
    const secondAttempt = await fetch(`${baseUrl(port)}/v1/documents/${documentId}/owner`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authed(ownerToken) },
      body: JSON.stringify({ newOwnerId: owner.id }),
    });
    expect(secondAttempt.status).toBe(403);
  });

  it("SEC-07: 50 concurrent POST .../owner requests to 50 different targets — exactly one succeeds, the database never observes zero or two owners, and the previous owner ends up exactly 'editor'", async () => {
    const port = await buildServer();
    const owner = await createTestUser("sec07-owner", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const documentId = await createDocumentAs(port, ownerToken, "Contested");

    const N = 50;
    const targets = await Promise.all(
      Array.from({ length: N }, (_, i) => createTestUser(`sec07-target-${i}`, "pw")),
    );
    // Every target must have SOME existing access first (409 target_has_no_access otherwise) —
    // granted directly, since this test is about transfer atomicity, not the grant endpoint.
    await Promise.all(
      targets.map((t) => grantPermissionDirect(documentId, t.id, "viewer", owner.id)),
    );

    // A 10ms-interval poller of document_permissions, running for the whole duration of the
    // concurrent burst below — the real, live proof that the database NEVER observes zero or two
    // simultaneous owners, not merely that the final state happens to look correct afterward.
    let polling = true;
    let observedZeroOwners = false;
    let observedTwoOwners = false;
    const pollerDone = (async () => {
      while (polling) {
        const { rows } = await pool.query<{ count: string }>(
          `SELECT count(*) FROM document_permissions WHERE document_id = $1 AND role = 'owner'`,
          [documentId],
        );
        const count = Number(rows[0]!.count);
        if (count === 0) observedZeroOwners = true;
        if (count >= 2) observedTwoOwners = true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();

    const responses = await Promise.all(
      targets.map((t) =>
        fetch(`${baseUrl(port)}/v1/documents/${documentId}/owner`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authed(ownerToken) },
          body: JSON.stringify({ newOwnerId: t.id }),
        }),
      ),
    );
    polling = false;
    await pollerDone;

    expect(observedZeroOwners).toBe(false);
    expect(observedTwoOwners).toBe(false);

    const successes = responses.filter((r) => r.status === 200);
    const rejections = responses.filter((r) => r.status === 403);
    expect(successes).toHaveLength(1);
    expect(rejections).toHaveLength(N - 1);

    const { rows: ownerRows } = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM document_permissions WHERE document_id = $1 AND role = 'owner'`,
      [documentId],
    );
    expect(ownerRows).toHaveLength(1);
    expect(targets.some((t) => t.id === ownerRows[0]?.user_id)).toBe(true);

    // The ORIGINAL owner ends up exactly 'editor' — never 'owner' (transferred away) and never
    // left with no row at all (transferOwnership's own transaction only ever demotes, never
    // deletes, the previous owner's row).
    expect(await permissionRow(documentId, owner.id)).toEqual({ role: "editor" });
  }, 30_000);
});
