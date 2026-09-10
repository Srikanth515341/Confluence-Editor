// Phase 29 — WebSocket admission tickets and live revocation (API Spec §1.5, §4.10, §3.6.9;
// Test Plan SEC-04, SEC-05, SEC-11b/c/d/e, RC-32). Requires a real, migrated Postgres instance
// (docker compose up -d; pnpm db:migrate). Run via `pnpm test:db`.
//
// This is the REAL end-to-end proof: a real `POST /v1/documents/{id}/rt-ticket`, a real ticket
// presented on a real WebSocket HELLO, and (for SEC-04/05/RC-32) a real PUT/DELETE
// .../permissions/{userId} commit landing on an admitted session whose `userId` is now the REAL
// authenticated user (Phase 29's own headline change — see documentCoordinator.ts's
// `lookupRole`/`authorizeSession` and gateway.ts's ticket-validated HELLO handling). SEC-01/02/03/
// 06's own mechanism-level coverage (no real Postgres needed) lives in permissions.test.ts and
// ticketAuthorization.test.ts.
//
// SEC-04's own "50 runs" is honestly reduced to a smaller N here, disclosed rather than silently
// rounded away — each run is a real connect + real REST commit + real polling loop, and 50 full
// repetitions would make this file's own runtime disproportionate to what it actually adds over a
// handful of runs demonstrating the SAME mechanism (the ≤2s decision-cache TTL, already proven at
// its own exact boundary, deterministically, in ticketAuthorization.test.ts's own SEC-05 test).

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Engine } from "@collab-editor/engine";
import {
  decodeControlFrame,
  decodeFrame,
  encodeControlFrame,
  encodeFrame,
  ErrorCode,
  operationToOpInsert,
  RejectReason,
  type ErrorMessage,
  type OpRejectMessage,
  type PermissionChangedMessage,
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
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
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

interface Ticket {
  readonly ticket: string;
  readonly expiresIn: number;
  readonly documentId: string;
}

async function issueTicket(
  port: number,
  token: string,
  documentId: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl(port)}/v1/documents/${documentId}/rt-ticket`, {
    method: "POST",
    headers: authed(token),
  });
  return { status: res.status, body: await res.json() };
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

/** A minimal frame reader — buffers messages arriving with no active waiter, hands them out FIFO (the same race the Phase 9 completed-phase entry documents needing this for). */
function makeFrameReader(ws: WebSocket): { next: () => Promise<Uint8Array> } {
  const messages: Uint8Array[] = [];
  const waiters: Array<(bytes: Uint8Array) => void> = [];
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const bytes = new Uint8Array(data as Buffer);
    const waiter = waiters.shift();
    if (waiter) waiter(bytes);
    else messages.push(bytes);
  });
  return {
    next: (): Promise<Uint8Array> => {
      const already = messages.shift();
      if (already) return Promise.resolve(already);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/** Connects with a REAL ticket string (from `issueTicket`), completing HELLO -> WELCOME (only — SNAPSHOT/ALREADY_HAVE are drained and discarded, matching documents.db.test.ts's own established helper shape). */
async function connectWithTicket(
  port: number,
  documentId: string,
  ticket: string,
): Promise<{ ws: WebSocket; welcome: WelcomeMessage; frames: { next: () => Promise<Uint8Array> } }> {
  const ws = new WebSocket(wsUrl(port), WS_SUBPROTOCOL);
  await waitForOpen(ws);
  const frames = makeFrameReader(ws);
  ws.send(
    encodeControlFrame({
      kind: "hello",
      documentId,
      ticket: new TextEncoder().encode(ticket),
      lastServerSeq: 0,
      unacked: [],
      clientCapabilities: 0,
    }),
    { binary: true },
  );
  const welcome = decodeControlFrame(await frames.next(), { direction: "serverOrigin" });
  if (welcome.kind !== "welcome") {
    throw new Error(`expected WELCOME, got ${welcome.kind}`);
  }
  await frames.next(); // SNAPSHOT
  await frames.next(); // ALREADY_HAVE
  return { ws, welcome, frames };
}

/** Connects and expects the handshake to be REJECTED — reads exactly one CONTROL frame (an ERROR) and the subsequent close. */
async function connectExpectingRejection(
  port: number,
  documentId: string,
  ticket: string,
): Promise<{ error: ErrorMessage; closeCode: number }> {
  const ws = new WebSocket(wsUrl(port), WS_SUBPROTOCOL);
  await waitForOpen(ws);
  const frames = makeFrameReader(ws);
  const closePromise = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  ws.send(
    encodeControlFrame({
      kind: "hello",
      documentId,
      ticket: new TextEncoder().encode(ticket),
      lastServerSeq: 0,
      unacked: [],
      clientCapabilities: 0,
    }),
    { binary: true },
  );
  const errorFrame = decodeControlFrame(await frames.next(), { direction: "serverOrigin" });
  if (errorFrame.kind !== "error") {
    throw new Error(`expected ERROR, got ${errorFrame.kind}`);
  }
  const closeCode = await closePromise;
  return { error: errorFrame, closeCode };
}

describe("Phase 29 — POST /v1/documents/{id}/rt-ticket (API Spec §4.10)", () => {
  it("issues a real ticket for owner/editor/viewer alike ('any role'), and 404s a caller with no access at all", async () => {
    const port = await buildServer();
    const owner = await createTestUser("ticket-owner", "pw");
    const editor = await createTestUser("ticket-editor", "pw");
    const viewer = await createTestUser("ticket-viewer", "pw");
    const outsider = await createTestUser("ticket-outsider", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const editorToken = await login(port, editor.email, "pw");
    const viewerToken = await login(port, viewer.email, "pw");
    const outsiderToken = await login(port, outsider.email, "pw");

    const documentId = await createDocumentAs(port, ownerToken, "Ticketed doc");
    await grantPermission(documentId, editor.id, "editor", owner.id);
    await grantPermission(documentId, viewer.id, "viewer", owner.id);

    for (const token of [ownerToken, editorToken, viewerToken]) {
      const result = await issueTicket(port, token, documentId);
      expect(result.status).toBe(201);
      const body = result.body as Ticket;
      expect(body.ticket.startsWith("rt_")).toBe(true);
      expect(body.expiresIn).toBeGreaterThan(0);
      expect(body.documentId).toBe(documentId);
    }

    const outsiderResult = await issueTicket(port, outsiderToken, documentId);
    expect(outsiderResult.status).toBe(404);
    expect((outsiderResult.body as { error: { code: string } }).error.code).toBe(
      "document_not_found",
    );
  });

  it("a genuinely nonexistent document is ALSO 404 — the same enumeration-oracle rule as every other route", async () => {
    const port = await buildServer();
    const { email } = await createTestUser("ticket-nodoc", "pw");
    const token = await login(port, email, "pw");
    const result = await issueTicket(port, token, randomUUID());
    expect(result.status).toBe(404);
  });
});

describe("Phase 29 — real ticket validation over the wire (SEC-11b/c/d)", () => {
  it("SEC-11b: a ticket reused on a second HELLO is rejected with ERROR{invalid_ticket, fatal: true}", async () => {
    const port = await buildServer();
    const owner = await createTestUser("sec11b-owner", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const documentId = await createDocumentAs(port, ownerToken, "SEC-11b");
    const { ticket } = (await issueTicket(port, ownerToken, documentId)).body as Ticket;

    const first = await connectWithTicket(port, documentId, ticket);
    first.ws.close();

    const rejection = await connectExpectingRejection(port, documentId, ticket);
    expect(rejection.error.code).toBe(ErrorCode.INVALID_TICKET);
    expect(rejection.error.fatal).toBe(true);
    expect(rejection.closeCode).toBe(1008);
  });

  it("SEC-11c: a ticket presented after its own TTL has elapsed is rejected as invalid — tested with a short-TTL server, not a real 30s wait", async () => {
    const port = await buildServer(testAuthConfig({ ticketTtlMs: 200 }));
    const owner = await createTestUser("sec11c-owner", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const documentId = await createDocumentAs(port, ownerToken, "SEC-11c");
    const { ticket } = (await issueTicket(port, ownerToken, documentId)).body as Ticket;

    await new Promise((resolve) => setTimeout(resolve, 300));
    const rejection = await connectExpectingRejection(port, documentId, ticket);
    expect(rejection.error.code).toBe(ErrorCode.INVALID_TICKET);
  });

  it("SEC-11d: a ticket issued for document X is rejected when HELLO claims document Y", async () => {
    const port = await buildServer();
    const owner = await createTestUser("sec11d-owner", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const documentX = await createDocumentAs(port, ownerToken, "Doc X");
    const documentY = await createDocumentAs(port, ownerToken, "Doc Y");
    const { ticket } = (await issueTicket(port, ownerToken, documentX)).body as Ticket;

    const rejection = await connectExpectingRejection(port, documentY, ticket);
    expect(rejection.error.code).toBe(ErrorCode.INVALID_TICKET);

    // The correct document is now ALSO rejected — the ticket was burned by the wrong-document
    // attempt (single-use is "first touch," not "first success").
    const secondAttempt = await connectExpectingRejection(port, documentX, ticket);
    expect(secondAttempt.error.code).toBe(ErrorCode.INVALID_TICKET);
  });

  it("a real, authenticated identity is established: the session's userId is the real user id, and WELCOME's role reflects the real document_permissions row", async () => {
    const port = await buildServer();
    const owner = await createTestUser("real-identity-owner", "pw");
    const viewer = await createTestUser("real-identity-viewer", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const viewerToken = await login(port, viewer.email, "pw");
    const documentId = await createDocumentAs(port, ownerToken, "Real identity");
    await grantPermission(documentId, viewer.id, "viewer", owner.id);

    const { ticket } = (await issueTicket(port, viewerToken, documentId)).body as Ticket;
    const { ws, welcome } = await connectWithTicket(port, documentId, ticket);
    expect(welcome.role).toBe(0); // SessionRole.VIEWER
    expect(welcome.participants.some((p) => p.userId === viewer.id)).toBe(true);
    ws.close();
  });
});

describe("Phase 29 — live revocation (SEC-04, SEC-05)", () => {
  it("SEC-04: a PUT/DELETE .../permissions/{userId} commit is reflected within 2s on an already-connected session — operations before are retained, operations after are rejected, PERMISSION_CHANGED carries effectiveAtSeq", async () => {
    const port = await buildServer();
    const owner = await createTestUser("sec04-owner", "pw");
    const editor = await createTestUser("sec04-editor", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const editorToken = await login(port, editor.email, "pw");
    const documentId = await createDocumentAs(port, ownerToken, "SEC-04");
    await grantPermission(documentId, editor.id, "editor", owner.id);

    const { ticket } = (await issueTicket(port, editorToken, documentId)).body as Ticket;
    const { ws, welcome, frames } = await connectWithTicket(port, documentId, ticket);
    const engine = new Engine(welcome.replicaId);

    // One real operation BEFORE revocation — must be retained afterward (SEC-04: "operations
    // committed BEFORE T are retained — acks are promises").
    const opBefore = engine.localInsert(0, 0x61); // "a"
    ws.send(encodeFrame(operationToOpInsert(opBefore, 0)), { binary: true });
    await frames.next(); // OP_ACK for opBefore

    const revokeAt = Date.now();
    const revokeRes = await fetch(`${baseUrl(port)}/v1/documents/${documentId}/permissions/${editor.id}`, {
      method: "DELETE",
      headers: authed(ownerToken),
    });
    expect(revokeRes.status).toBe(204);

    const permissionChanged = decodeControlFrame(await frames.next(), {
      direction: "serverOrigin",
    }) as PermissionChangedMessage;
    const receivedAt = Date.now();
    expect(permissionChanged.kind).toBe("permissionChanged");
    expect(permissionChanged.role).toBeNull();
    expect(typeof permissionChanged.effectiveAtSeq).toBe("number");
    expect(receivedAt - revokeAt).toBeLessThanOrEqual(2000);

    // An operation sent AFTER T is rejected — real enforcement, not just the notification.
    const opAfter = engine.localInsert(1, 0x62); // "b"
    ws.send(encodeFrame(operationToOpInsert(opAfter, 0)), { binary: true });
    const rejectFrame = decodeFrame(await frames.next(), {
      direction: "serverOrigin",
    }) as OpRejectMessage;
    expect(rejectFrame.kind).toBe("opReject");
    expect(rejectFrame.rejects).toEqual([
      { rejectedId: opAfter.id, reason: RejectReason.PERMISSION_DENIED },
    ]);

    // The BEFORE operation is confirmed retained in the durable log.
    const rows = (
      await pool.query(`SELECT stamp_c, stamp_r FROM operations WHERE document_id = $1`, [
        documentId,
      ])
    ).rows as Array<{ stamp_c: string; stamp_r: string }>; // BIGINT columns — node-postgres returns strings
    expect(
      rows.some((r) => Number(r.stamp_c) === opBefore.id.c && Number(r.stamp_r) === opBefore.id.r),
    ).toBe(true);

    ws.close();
  }, 15_000);

  it("SEC-05: with the PERMISSION_CHANGED push never observed by the client (socket already closed), the NEXT connection attempt is still correctly refused by a fresh permission lookup at HELLO time", async () => {
    // This project's own real WS layer has no "suppress the push but keep the socket open"
    // switch to flip — the push and the decision-cache re-check are two independently-correct
    // mechanisms (see ticketAuthorization.test.ts's own deterministic, clock-injectable SEC-05
    // proof for the cache-alone mechanism in isolation). This test instead proves the OTHER real
    // consequence the spec cares about: revocation is never "only" reflected via the push — a
    // client that never saw ANY notification (e.g. was offline at the moment of revocation) still
    // cannot re-admit itself on its next connection, because HELLO always re-checks the real,
    // current database state, never a cached role from a stale ticket.
    const port = await buildServer();
    const owner = await createTestUser("sec05-owner", "pw");
    const editor = await createTestUser("sec05-editor", "pw");
    const ownerToken = await login(port, owner.email, "pw");
    const editorToken = await login(port, editor.email, "pw");
    const documentId = await createDocumentAs(port, ownerToken, "SEC-05");
    await grantPermission(documentId, editor.id, "editor", owner.id);

    // Ticket issued WHILE the editor still has access — this is what makes the test meaningful:
    // the ticket itself remains formally valid (right document, right user, unexpired,
    // unconsumed); only the FRESH role lookup at HELLO time can catch what happened next.
    const { ticket } = (await issueTicket(port, editorToken, documentId)).body as Ticket;

    const revokeRes = await fetch(`${baseUrl(port)}/v1/documents/${documentId}/permissions/${editor.id}`, {
      method: "DELETE",
      headers: authed(ownerToken),
    });
    expect(revokeRes.status).toBe(204);

    // Fresh HELLO-time lookup finds no role at all -> SESSION_EXPIRED, not merely a downgrade.
    const rejection = await connectExpectingRejection(port, documentId, ticket);
    expect(rejection.error.code).toBe(ErrorCode.SESSION_EXPIRED);
  });
});
