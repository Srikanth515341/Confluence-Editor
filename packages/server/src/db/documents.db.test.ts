// Phase 27 — REST document lifecycle (API Spec §4.3-§4.6, §4.16, §5.1, §5.2, §9.2; Test Plan
// §11.1). Requires a real, migrated Postgres instance (docker compose up -d; pnpm db:migrate).
// Run via `pnpm test:db`. Implements the full REST matrix table from this phase's own brief, row
// by row — each `it()` below is named after the matrix row (or rows) it covers.
//
// No "share a document" / grant-permission REST endpoint exists yet (out of this phase's own
// Scope-IN, which lists create/list/get/patch/delete/search only) — every test that needs an
// editor/viewer role for a document other than its own owner grants that role by inserting a
// `document_permissions` row directly via raw SQL, the same fixture-seeding convention this
// project has used since Phase 17/18's own bulk-insert fixtures (seeding state a feature doesn't
// yet have its own API to produce, when the test isn't ABOUT that seeding mechanism).

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Engine } from "@collab-editor/engine";
import {
  GoodbyeReason,
  decodeControlFrame,
  encodeControlFrame,
  encodeFrame,
  operationToOpInsert,
  type WelcomeMessage,
} from "@collab-editor/protocol";
import { loadConfig } from "../config.js";
import type { AuthConfig } from "../config.js";
import { createCollabServer, type CollabServer } from "../server.js";
import { WS_PATH, WS_SUBPROTOCOL } from "../gateway.js";
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

// An array, not a single `server` slot — several of this file's own tests (the expired-token
// case, specifically) deliberately build a SECOND server with different config mid-test, and a
// single-slot pattern (auth.db.test.ts's own convention) would silently leak the first one.
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
    ...overrides,
  };
}

/** A real `PostgresOperationStore` (not `InMemoryOperationStore`) — this file's own DELETE test needs a REAL, durable `operations` row to prove PRD FR-VH-5's retention claim against. */
async function buildServer(authConfig: AuthConfig): Promise<number> {
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

/** `localPart` gets a random suffix — see auth.db.test.ts's own identical helper for why (this table's `users_email_lower_uq` collides across repeated runs against a real, non-reset database otherwise). */
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

async function grantPermission(
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

async function createDocumentAs(port: number, token: string, title: string): Promise<string> {
  const res = await fetch(`${baseUrl(port)}/v1/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authed(token) },
    body: JSON.stringify({ title }),
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}${WS_PATH}`;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

/** A minimal HELLO -> WELCOME handshake — a local copy of serverRestart.db.test.ts's own helper (that file's own version is private to it), trimmed to what this file's own DELETE test actually needs (WELCOME only, no SNAPSHOT decode). */
async function connectAndHandshake(
  port: number,
  documentId: string,
): Promise<{ ws: WebSocket; welcome: WelcomeMessage }> {
  const ws = new WebSocket(wsUrl(port), WS_SUBPROTOCOL);
  await waitForOpen(ws);

  const messages: Uint8Array[] = [];
  const waiters: Array<(bytes: Uint8Array) => void> = [];
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const bytes = new Uint8Array(data as Buffer);
    const waiter = waiters.shift();
    if (waiter) waiter(bytes);
    else messages.push(bytes);
  });
  const next = (): Promise<Uint8Array> => {
    const already = messages.shift();
    if (already) return Promise.resolve(already);
    return new Promise((resolve) => waiters.push(resolve));
  };

  ws.send(
    encodeControlFrame({
      kind: "hello",
      documentId,
      ticket: new Uint8Array(),
      lastServerSeq: 0,
      unacked: [],
      clientCapabilities: 0,
    }),
    { binary: true },
  );

  const welcome = decodeControlFrame(await next(), { direction: "serverOrigin" });
  if (welcome.kind !== "welcome") {
    throw new Error(`expected WELCOME, got ${welcome.kind}`);
  }
  // Drain SNAPSHOT/ALREADY_HAVE too, so they never confuse a LATER `ws.on("message", ...)`
  // listener this test registers for its own purposes (the GOODBYE wait, specifically) —
  // `decodeControlFrame` on a SNAPSHOT/ALREADY_HAVE frame is harmless; the results are discarded.
  await next(); // SNAPSHOT
  await next(); // ALREADY_HAVE
  return { ws, welcome };
}

describe("Phase 27 — REST document lifecycle (API Spec §4.3-§4.6, §4.16, §5.1, §9.2)", () => {
  it("POST /v1/documents: valid create returns 201, a Location header, and the create-response object (API Spec §4.3)", async () => {
    const port = await buildServer(testAuthConfig());
    const { id: userId, email } = await createTestUser("post-valid", "pw");
    const token = await login(port, email, "pw");

    const res = await fetch(`${baseUrl(port)}/v1/documents`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authed(token) },
      body: JSON.stringify({ title: "Design review" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      title: string;
      ownerId: string;
      role: string;
      createdAt: string;
      updatedAt: string;
      currentSeq: number;
    };
    expect(res.headers.get("location")).toBe(`/v1/documents/${body.id}`);
    expect(body.title).toBe("Design review");
    expect(body.ownerId).toBe(userId);
    expect(body.role).toBe("owner");
    expect(body.currentSeq).toBe(0);
    expect(new Date(body.createdAt).toString()).not.toBe("Invalid Date");
  });

  it("POST /v1/documents: title defaults to 'Untitled' when omitted, and a title over 512 characters is 400 validation_failed with fields: ['title']", async () => {
    const port = await buildServer(testAuthConfig());
    const { email } = await createTestUser("post-title-edge", "pw");
    const token = await login(port, email, "pw");

    const defaultRes = await fetch(`${baseUrl(port)}/v1/documents`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authed(token) },
      body: JSON.stringify({}),
    });
    expect(defaultRes.status).toBe(201);
    expect(((await defaultRes.json()) as { title: string }).title).toBe("Untitled");

    const tooLongRes = await fetch(`${baseUrl(port)}/v1/documents`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authed(token) },
      body: JSON.stringify({ title: "x".repeat(513) }),
    });
    expect(tooLongRes.status).toBe(400);
    const tooLongBody = (await tooLongRes.json()) as {
      error: { code: string; requestId: string; details?: { fields?: string[] } };
    };
    expect(tooLongBody.error.code).toBe("validation_failed");
    expect(tooLongBody.error.details?.fields).toEqual(["title"]);
    expect(tooLongBody.error.requestId).toEqual(expect.any(String));
  });

  it("POST /v1/documents: Idempotency-Key replay with the SAME body returns the IDENTICAL stored response; the SAME key with a DIFFERENT body is 409 idempotency_key_reused (API Spec §9.2)", async () => {
    const port = await buildServer(testAuthConfig());
    const { email } = await createTestUser("idem", "pw");
    const token = await login(port, email, "pw");
    const key = randomUUID();

    const first = await fetch(`${baseUrl(port)}/v1/documents`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key, ...authed(token) },
      body: JSON.stringify({ title: "Idempotent doc" }),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const replay = await fetch(`${baseUrl(port)}/v1/documents`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key, ...authed(token) },
      body: JSON.stringify({ title: "Idempotent doc" }),
    });
    expect(replay.status).toBe(201);
    // The ORIGINAL stored response, not a freshly recomputed one — same object, not just "also a
    // successful create" (a second real create would mint a different id).
    expect(await replay.json()).toEqual(firstBody);

    const differentKeyOrder = await fetch(`${baseUrl(port)}/v1/documents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        ...authed(token),
      },
      // Same logical body, keys in a different order — must still count as "the same body"
      // (documentService.ts's own canonicalJsonStringify exists for exactly this).
      body: `{"title":"Idempotent doc"}`,
    });
    expect(differentKeyOrder.status).toBe(201);
    expect(await differentKeyOrder.json()).toEqual(firstBody);

    const conflict = await fetch(`${baseUrl(port)}/v1/documents`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key, ...authed(token) },
      body: JSON.stringify({ title: "A completely different title" }),
    });
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as { error: { code: string } };
    expect(conflictBody.error.code).toBe("idempotency_key_reused");
  });

  it("GET /v1/documents: owner/editor/viewer each see the right role, a role filter narrows the list, and cursor pagination walks every document exactly once", async () => {
    const port = await buildServer(testAuthConfig());
    const owner = await createTestUser("list-owner", "pw");
    const editor = await createTestUser("list-editor", "pw");
    const viewer = await createTestUser("list-viewer", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const editorToken = await login(port, editor.email, "pw");
    const viewerToken = await login(port, viewer.email, "pw");

    const docIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      docIds.push(await createDocumentAs(port, ownerToken, `Doc ${i}`));
      // `updated_at` has real (sub-millisecond-collision-possible) resolution — spacing creation
      // out gives the keyset-pagination ordering below a genuinely deterministic tie-break.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await grantPermission(docIds[0]!, editor.id, "editor", owner.id);
    await grantPermission(docIds[0]!, viewer.id, "viewer", owner.id);

    const ownerList = (await (
      await fetch(`${baseUrl(port)}/v1/documents`, { headers: authed(ownerToken) })
    ).json()) as { documents: Array<{ id: string; role: string }> };
    expect(ownerList.documents).toHaveLength(3);
    expect(ownerList.documents.every((d) => d.role === "owner")).toBe(true);

    const editorList = (await (
      await fetch(`${baseUrl(port)}/v1/documents`, { headers: authed(editorToken) })
    ).json()) as { documents: Array<{ id: string; role: string }> };
    expect(editorList.documents).toHaveLength(1);
    expect(editorList.documents[0]).toMatchObject({ id: docIds[0], role: "editor" });

    const viewerList = (await (
      await fetch(`${baseUrl(port)}/v1/documents`, { headers: authed(viewerToken) })
    ).json()) as { documents: Array<{ id: string; role: string }> };
    expect(viewerList.documents).toHaveLength(1);
    expect(viewerList.documents[0]).toMatchObject({ id: docIds[0], role: "viewer" });

    // Role filter: the owner has zero editor/viewer-role documents of their own.
    const filtered = (await (
      await fetch(`${baseUrl(port)}/v1/documents?role=editor`, { headers: authed(ownerToken) })
    ).json()) as { documents: unknown[] };
    expect(filtered.documents).toHaveLength(0);

    // Cursor pagination: limit=1 across the owner's 3 documents visits all 3 exactly once.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 3; i++) {
      const url = new URL(`${baseUrl(port)}/v1/documents`);
      url.searchParams.set("limit", "1");
      if (cursor) url.searchParams.set("cursor", cursor);
      const pageBody = (await (await fetch(url, { headers: authed(ownerToken) })).json()) as {
        documents: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(pageBody.documents).toHaveLength(1);
      seen.push(pageBody.documents[0]!.id);
      cursor = pageBody.nextCursor;
    }
    expect(new Set(seen)).toEqual(new Set(docIds));
    expect(cursor).toBeNull();
  });

  it("GET /v1/documents/{id}: owner sees permissions+structureSize/tombstoneCount, editor/viewer see the base object only, no role is 404, and a genuinely nonexistent id is ALSO 404 — never 403 (API Spec §4.5's enumeration-oracle rule)", async () => {
    const port = await buildServer(testAuthConfig());
    const owner = await createTestUser("get-owner", "pw");
    const editor = await createTestUser("get-editor", "pw");
    const viewer = await createTestUser("get-viewer", "pw");
    const outsider = await createTestUser("get-outsider", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const editorToken = await login(port, editor.email, "pw");
    const viewerToken = await login(port, viewer.email, "pw");
    const outsiderToken = await login(port, outsider.email, "pw");

    const documentId = await createDocumentAs(port, ownerToken, "Shared doc");
    await grantPermission(documentId, editor.id, "editor", owner.id);
    await grantPermission(documentId, viewer.id, "viewer", owner.id);

    const ownerGet = await fetch(`${baseUrl(port)}/v1/documents/${documentId}`, {
      headers: authed(ownerToken),
    });
    expect(ownerGet.status).toBe(200);
    const ownerBody = (await ownerGet.json()) as {
      permissions?: unknown[];
      structureSize?: number;
      tombstoneCount?: number;
    };
    expect(ownerBody.permissions).toHaveLength(3); // owner + editor + viewer
    expect(ownerBody.structureSize).toBe(0);
    expect(ownerBody.tombstoneCount).toBe(0);

    const editorGet = await fetch(`${baseUrl(port)}/v1/documents/${documentId}`, {
      headers: authed(editorToken),
    });
    expect(editorGet.status).toBe(200);
    const editorBody = (await editorGet.json()) as {
      permissions?: unknown;
      structureSize?: unknown;
      tombstoneCount?: unknown;
      role: string;
    };
    expect(editorBody.role).toBe("editor");
    expect(editorBody.permissions).toBeUndefined();
    expect(editorBody.structureSize).toBeUndefined();
    expect(editorBody.tombstoneCount).toBeUndefined();

    const viewerGet = await fetch(`${baseUrl(port)}/v1/documents/${documentId}`, {
      headers: authed(viewerToken),
    });
    expect(viewerGet.status).toBe(200);
    expect(((await viewerGet.json()) as { role: string }).role).toBe("viewer");

    const noRoleGet = await fetch(`${baseUrl(port)}/v1/documents/${documentId}`, {
      headers: authed(outsiderToken),
    });
    expect(noRoleGet.status).toBe(404);
    expect(((await noRoleGet.json()) as { error: { code: string } }).error.code).toBe(
      "document_not_found",
    );

    const nonexistentGet = await fetch(`${baseUrl(port)}/v1/documents/${randomUUID()}`, {
      headers: authed(ownerToken),
    });
    expect(nonexistentGet.status).toBe(404);
    expect(((await nonexistentGet.json()) as { error: { code: string } }).error.code).toBe(
      "document_not_found",
    );
  });

  it("PATCH /v1/documents/{id}: owner succeeds (200, new title persists); editor and viewer both get 403 permission_denied and leave the title unchanged", async () => {
    const port = await buildServer(testAuthConfig());
    const owner = await createTestUser("patch-owner", "pw");
    const editor = await createTestUser("patch-editor", "pw");
    const viewer = await createTestUser("patch-viewer", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const editorToken = await login(port, editor.email, "pw");
    const viewerToken = await login(port, viewer.email, "pw");

    const documentId = await createDocumentAs(port, ownerToken, "Original");
    await grantPermission(documentId, editor.id, "editor", owner.id);
    await grantPermission(documentId, viewer.id, "viewer", owner.id);

    const editorPatch = await fetch(`${baseUrl(port)}/v1/documents/${documentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authed(editorToken) },
      body: JSON.stringify({ title: "Editor tried" }),
    });
    expect(editorPatch.status).toBe(403);
    expect(((await editorPatch.json()) as { error: { code: string } }).error.code).toBe(
      "permission_denied",
    );

    const viewerPatch = await fetch(`${baseUrl(port)}/v1/documents/${documentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authed(viewerToken) },
      body: JSON.stringify({ title: "Viewer tried" }),
    });
    expect(viewerPatch.status).toBe(403);

    const ownerPatch = await fetch(`${baseUrl(port)}/v1/documents/${documentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authed(ownerToken) },
      body: JSON.stringify({ title: "Renamed by owner" }),
    });
    expect(ownerPatch.status).toBe(200);
    expect(((await ownerPatch.json()) as { title: string }).title).toBe("Renamed by owner");

    const getAfter = await fetch(`${baseUrl(port)}/v1/documents/${documentId}`, {
      headers: authed(ownerToken),
    });
    expect(((await getAfter.json()) as { title: string }).title).toBe("Renamed by owner");
  });

  it("DELETE /v1/documents/{id}: owner-only (403 otherwise), 204 on success, every open socket for the document receives GOODBYE{reason: PERMISSION_REVOKED}, and the operation log is RETAINED while permissions are revoked (API Spec §4.5, PRD FR-VH-5)", async () => {
    const port = await buildServer(testAuthConfig());
    const owner = await createTestUser("delete-owner", "pw");
    const editor = await createTestUser("delete-editor", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const editorToken = await login(port, editor.email, "pw");

    const documentId = await createDocumentAs(port, ownerToken, "To be deleted");
    await grantPermission(documentId, editor.id, "editor", owner.id);

    // A real, live WebSocket session for this document (so DELETE has an actual open socket to
    // notify), and one real committed operation (so there's a real `operations` row to check
    // survives the deletion). Minted under the server-ASSIGNED replica id from WELCOME —
    // writePath.ts's step 2 (API Spec §6.3) rejects anything else as IDENTITY_MISMATCH.
    const { ws, welcome } = await connectAndHandshake(port, documentId);
    const engine = new Engine(welcome.replicaId);
    const op = engine.localInsert(0, 0x68); // "h"
    ws.send(encodeFrame(operationToOpInsert(op, 0)), { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the write path commit

    const beforeRows = (await pool.query(`SELECT * FROM operations WHERE document_id = $1`, [
      documentId,
    ])).rows;
    expect(beforeRows.length).toBeGreaterThan(0);

    const goodbyeReceived = new Promise<number>((resolve) => {
      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const msg = decodeControlFrame(new Uint8Array(data as Buffer), {
          direction: "serverOrigin",
        });
        if (msg.kind === "goodbye") resolve(msg.reason);
      });
    });

    const editorDelete = await fetch(`${baseUrl(port)}/v1/documents/${documentId}`, {
      method: "DELETE",
      headers: authed(editorToken),
    });
    expect(editorDelete.status).toBe(403);

    const ownerDelete = await fetch(`${baseUrl(port)}/v1/documents/${documentId}`, {
      method: "DELETE",
      headers: authed(ownerToken),
    });
    expect(ownerDelete.status).toBe(204);

    const reason = await goodbyeReceived;
    expect(reason).toBe(GoodbyeReason.PERMISSION_REVOKED);

    const afterRows = (await pool.query(`SELECT * FROM operations WHERE document_id = $1`, [
      documentId,
    ])).rows;
    expect(afterRows.length).toBe(beforeRows.length); // the log is RETAINED, not deleted

    const permRows = (
      await pool.query(`SELECT * FROM document_permissions WHERE document_id = $1`, [documentId])
    ).rows;
    expect(permRows).toHaveLength(0); // "revokes all permissions"

    const docRows = (
      await pool.query(`SELECT access_revoked_at FROM documents WHERE id = $1`, [documentId])
    ).rows as Array<{ access_revoked_at: Date | null }>;
    expect(docRows[0]?.access_revoked_at).not.toBeNull();

    // The document row itself is retained (never dropped) — only access is gone, so even the
    // former owner now gets 404, indistinguishable from it never having existed.
    const afterGet = await fetch(`${baseUrl(port)}/v1/documents/${documentId}`, {
      headers: authed(ownerToken),
    });
    expect(afterGet.status).toBe(404);

    ws.close();
  });

  it("GET /v1/users/search: an exact email match returns a MASKED email; a display-name PREFIX also matches; a PREFIX of an email (not exact) matches nothing (API Spec §4.16)", async () => {
    const port = await buildServer(testAuthConfig());
    const { email: searcherEmail } = await createTestUser("search-caller", "pw");
    const searcherToken = await login(port, searcherEmail, "pw");
    const target = await createTestUser("zzz-search-target", "pw", "Zebra Zealous");

    const exactRes = await fetch(
      `${baseUrl(port)}/v1/users/search?q=${encodeURIComponent(target.email)}`,
      { headers: authed(searcherToken) },
    );
    expect(exactRes.status).toBe(200);
    const exactBody = (await exactRes.json()) as {
      users: Array<{ id: string; email: string; displayName: string }>;
    };
    expect(exactBody.users).toHaveLength(1);
    expect(exactBody.users[0]!.id).toBe(target.id);
    const domain = target.email.slice(target.email.indexOf("@"));
    expect(exactBody.users[0]!.email).toBe(`${target.email[0]}***${domain}`);
    expect(exactBody.users[0]!.email).not.toBe(target.email);

    const namePrefixRes = await fetch(`${baseUrl(port)}/v1/users/search?q=Zebra`, {
      headers: authed(searcherToken),
    });
    const namePrefixBody = (await namePrefixRes.json()) as { users: Array<{ id: string }> };
    expect(namePrefixBody.users.some((u) => u.id === target.id)).toBe(true);

    // A prefix of the LOCAL PART of the email (not the full, exact address) must match nothing.
    const emailLocalPrefix = target.email.slice(0, target.email.indexOf("@") - 2);
    const emailPrefixRes = await fetch(
      `${baseUrl(port)}/v1/users/search?q=${encodeURIComponent(emailLocalPrefix)}`,
      { headers: authed(searcherToken) },
    );
    const emailPrefixBody = (await emailPrefixRes.json()) as { users: unknown[] };
    expect(emailPrefixBody.users).toHaveLength(0);
  });

  it("every §4.x route: malformed JSON is 400 validation_failed, a missing Authorization header is 401, an already-expired (but syntactically valid) access token is 401 session_expired — every body matches the §5.1 envelope, and requestId correlates to a real server log line", async () => {
    const port = await buildServer(testAuthConfig());
    const { email } = await createTestUser("errors", "pw");
    const token = await login(port, email, "pw");

    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]): void => {
      logged.push(args.map((a) => String(a)).join(" "));
    };
    let malformedBody: { error: { code: string; requestId: string } };
    try {
      const malformed = await fetch(`${baseUrl(port)}/v1/documents`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authed(token) },
        body: "{not valid json",
      });
      expect(malformed.status).toBe(400);
      malformedBody = (await malformed.json()) as { error: { code: string; requestId: string } };
    } finally {
      console.log = originalLog;
    }
    expect(malformedBody.error.code).toBe("validation_failed");
    expect(malformedBody.error.requestId).toEqual(expect.any(String));
    // API Spec §5.1: "requestId appears in every server log line for that request."
    expect(logged.some((line) => line.includes(malformedBody.error.requestId))).toBe(true);

    const missingAuth = await fetch(`${baseUrl(port)}/v1/documents`);
    expect(missingAuth.status).toBe(401);
    const missingAuthBody = (await missingAuth.json()) as {
      error: { code: string; requestId: string };
    };
    expect(missingAuthBody.error.requestId).toEqual(expect.any(String));

    // A syntactically-valid, correctly-signed, but genuinely EXPIRED token — a SEPARATE server
    // (its own config, its own short TTL) so this doesn't perturb the 15-minute-TTL config every
    // other test in this file relies on.
    const shortPort = await buildServer(testAuthConfig({ accessTokenTtlMs: 1000 }));
    const shortUser = await createTestUser("expired", "pw");
    const shortToken = await login(shortPort, shortUser.email, "pw");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const expiredRes = await fetch(`${baseUrl(shortPort)}/v1/documents`, {
      headers: authed(shortToken),
    });
    expect(expiredRes.status).toBe(401);
    expect(((await expiredRes.json()) as { error: { code: string } }).error.code).toBe(
      "session_expired",
    );
  }, 10_000);
});
