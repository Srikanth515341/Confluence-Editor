// Phase 33 — Presence rendering (API Spec §8.1, Test Plan PRES-03). Requires a real, migrated
// Postgres instance (docker compose up -d; pnpm db:migrate). Run via `pnpm test:db`.
//
// This is PRES-03's own DoD-flagged "critical correctness check": colour must be IDENTICAL across
// a real reconnection, which mints a brand-new `replicaId` every time (Engine Spec I1, "never
// reused") but must NOT mint a new colour — colour is a pure function of the REAL, stable
// authenticated user id (`packages/client/src/presence/color.ts`'s own header comment traces the
// exact chain: JWT `sub` -> ticket -> `CoordinatorSession.userId` -> `PresenceJoinMessage.userId`).
// A same-session, no-reconnect check would prove nothing about stability across a NEW replica id,
// which is exactly the scenario a colour keyed on `replicaId` (the wrong, tempting choice) would
// fail — this test forces a REAL disconnect and a REAL second connection, with a REAL second
// ticket, and confirms an INDEPENDENT OBSERVER sees the identical `userId` (and therefore,
// necessarily, the identical colour, since `userHue` is a pure function already exhaustively
// tested in isolation in `packages/client/src/presence/color.test.ts`) both times, while the
// `replicaId` genuinely differs.
//
// `userHue`/`caretColor` are DELIBERATELY reimplemented here as a small, local, standalone copy
// rather than imported from `@collab-editor/client` — `packages/server` has no dependency on the
// client package (and never should: the dependency direction in this project only ever runs
// engine/protocol -> server/client, never client -> server or server -> client) — the SAME
// "duplicate a small, pure, trivially-verifiable formula rather than invent a cross-package
// dependency for it" call this project already made for `wireHelpers.ts`'s own client-side
// duplication of server logic (Phase 10) and `testkit`'s own local copy of `captureCaret`'s
// shared-`visible()` optimization (Phase 32 follow-up).

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  decodeControlFrame,
  decodePresenceFrame,
  encodeControlFrame,
  peekChannel,
  Channel,
  type PresenceMessage,
  type WelcomeMessage,
} from "@collab-editor/protocol";
import { loadConfig } from "../config.js";
import type { AuthConfig } from "../config.js";
import { createCollabServer, type CollabServer } from "../server.js";
import { WS_PATH, WS_SUBPROTOCOL } from "../gateway.js";
import { PostgresOperationStore } from "./operationStore.js";
import { hashPassword } from "../passwordHash.js";
import { createPool, type DbPool } from "./pool.js";

/** A standalone, LITERAL copy of `packages/client/src/presence/color.ts`'s own `userHue` — see this file's own header comment for why this is a deliberate duplication, not an accidental drift risk (the formula is pure, tiny, and independently unit-tested to exhaustion elsewhere). */
function userHue(userId: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const GOLDEN = 137.508;
  return ((h % 360) + GOLDEN * ((h >>> 9) % 5)) % 360;
}

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

function testAuthConfig(): AuthConfig {
  return {
    jwtAccessSecret: "test-access-secret-do-not-use-in-prod",
    jwtRefreshSecret: "test-refresh-secret-do-not-use-in-prod",
    accessTokenTtlMs: 15 * 60 * 1000,
    refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    loginRateLimitPerIp: { max: 1000, windowMs: 15 * 60 * 1000 },
    loginRateLimitPerAccount: { max: 1000, windowMs: 15 * 60 * 1000 },
    ticketTtlMs: 30_000,
    ticketRateLimit: { max: 1000, windowMs: 60 * 1000 },
  };
}

async function buildServer(): Promise<number> {
  const server = createCollabServer({
    operationStore: new PostgresOperationStore(pool),
    auth: { pool, authConfig: testAuthConfig() },
  });
  servers.push(server);
  return server.listen(0);
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function createTestUser(localPart: string, displayName: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${localPart}+${randomUUID()}@example.com`;
  const passwordHash = await hashPassword("pw");
  await pool.query(`INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`, [
    id,
    email,
    displayName,
    passwordHash,
  ]);
  return { id, email };
}

async function login(port: number, email: string): Promise<string> {
  const res = await fetch(`${baseUrl(port)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "pw" }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function createDocumentAs(port: number, token: string): Promise<string> {
  const res = await fetch(`${baseUrl(port)}/v1/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: "presence-color-test" }),
  });
  return ((await res.json()) as { id: string }).id;
}

async function grantEditor(documentId: string, userId: string, grantedBy: string): Promise<void> {
  await pool.query(
    `INSERT INTO document_permissions (document_id, user_id, role, granted_by) VALUES ($1, $2, 'editor', $3)`,
    [documentId, userId, grantedBy],
  );
}

async function issueTicket(port: number, token: string, documentId: string): Promise<string> {
  const res = await fetch(`${baseUrl(port)}/v1/documents/${documentId}/rt-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status !== 201) throw new Error(`ticket issuance failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { ticket: string }).ticket;
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

/** Buffers messages arriving with no active waiter, hands them out FIFO — the same established pattern `db/tickets.db.test.ts` already uses. */
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

/** Reads frames (skipping any non-PRESENCE frame — none expected here, but robust regardless) until a `presenceJoin` for a DIFFERENT connection than this test's own observer arrives, with a bounded number of attempts so a genuine protocol regression fails the test instead of hanging it. */
async function waitForNextPresenceJoin(frames: { next: () => Promise<Uint8Array> }): Promise<{ userId: string; replicaId: number }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const bytes = await frames.next();
    if (peekChannel(bytes) !== Channel.PRESENCE) continue;
    const msg: PresenceMessage = decodePresenceFrame(bytes, { direction: "serverOrigin" });
    if (msg.kind === "presenceJoin") {
      return { userId: msg.userId, replicaId: msg.replicaId };
    }
  }
  throw new Error("no PRESENCE_JOIN arrived within 10 frames");
}

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
  if (welcome.kind !== "welcome") throw new Error(`expected WELCOME, got ${welcome.kind}`);
  await frames.next(); // SNAPSHOT
  await frames.next(); // ALREADY_HAVE
  await frames.next(); // PRESENCE_ROSTER — this test's own observer never needs its content (it joins first, so the roster is always empty of the mover at that point)
  return { ws, welcome, frames };
}

describe("Phase 33 — presence colour is identical across a real reconnection with a NEW replica id (PRES-03)", () => {
  it("an independent observer sees the IDENTICAL userId (and therefore colour) for the same account across a real disconnect + reconnect, while replicaId genuinely changes", async () => {
    const port = await buildServer();
    const owner = await createTestUser("presence-owner", "Owner");
    const mover = await createTestUser("presence-mover", "Mover");
    const ownerToken = await login(port, owner.email);
    const moverToken = await login(port, mover.email);
    const documentId = await createDocumentAs(port, ownerToken);
    await grantEditor(documentId, mover.id, owner.id);

    // The OBSERVER connects first (as the owner) and stays connected for the whole test — this is
    // the "independent observer" PRES-03 asks for: someone who never disconnects, watching the
    // SAME account join twice under two different replica ids.
    const observerTicket = await issueTicket(port, ownerToken, documentId);
    const observer = await connectWithTicket(port, documentId, observerTicket);

    // First connection: the "mover" joins under a real, freshly-issued ticket.
    const moverTicket1 = await issueTicket(port, moverToken, documentId);
    const moverConn1 = await connectWithTicket(port, documentId, moverTicket1);
    const firstJoin = await waitForNextPresenceJoin(observer.frames);
    expect(firstJoin.userId).toBe(mover.id); // the REAL, stable authenticated user id -- not a random per-connection placeholder

    // A REAL disconnect.
    moverConn1.ws.close();
    await new Promise((resolve) => moverConn1.ws.once("close", resolve));

    // A REAL reconnect, with a FRESH ticket (a used one can never be replayed, Phase 29 SEC-11b) --
    // this is what actually forces a brand-new `replicaId` (Engine Spec I1).
    const moverTicket2 = await issueTicket(port, moverToken, documentId);
    const moverConn2 = await connectWithTicket(port, documentId, moverTicket2);
    const secondJoin = await waitForNextPresenceJoin(observer.frames);

    // The headline claim: SAME userId, DIFFERENT replicaId.
    expect(secondJoin.userId).toBe(mover.id);
    expect(secondJoin.userId).toBe(firstJoin.userId);
    expect(secondJoin.replicaId).not.toBe(firstJoin.replicaId);
    expect(moverConn2.welcome.replicaId).not.toBe(moverConn1.welcome.replicaId);

    // And therefore, since `userHue`/`caretColor` are PURE functions of `userId` alone (exhaustively
    // verified against an independent BigInt oracle in `packages/client/src/presence/color.test.ts`),
    // the colour this observer would compute for "the mover" is byte-for-byte identical both times.
    expect(userHue(firstJoin.userId)).toBe(userHue(secondJoin.userId));

    observer.ws.close();
    moverConn2.ws.close();
  });
});
