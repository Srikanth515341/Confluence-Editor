import { SyncClient, type SyncClientOptions } from "./syncClient.js";
import type { ConnectionState } from "./connectionState.js";

/**
 * Minimal headless harness (Scope-IN: "A minimal headless harness (no
 * React) driving two SyncClient instances against the real server") — no
 * DOM, no React, just enough orchestration to prove two independent
 * `SyncClient`s converge over the wire. Deliberately thin: it takes a
 * server URL and hands back two connected, synced clients plus a couple
 * of generic wait helpers, rather than encoding any specific test
 * scenario — the phase's DoD scenarios (kill-the-server, crash-loop, ...)
 * each compose these primitives differently.
 */
export interface HeadlessPair {
  readonly a: SyncClient;
  readonly b: SyncClient;
}

export function waitForState(
  client: SyncClient,
  target: ConnectionState,
  timeoutMs = 10_000,
): Promise<void> {
  if (client.state.value === target) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`waitForState: timed out after ${timeoutMs}ms waiting for "${target}"`));
    }, timeoutMs);
    const unsubscribe = client.state.subscribe((value) => {
      if (value === target) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/** Creates two SyncClients against the same document and waits until both have completed a handshake. */
export async function connectPair(
  documentId: string,
  makeOptions: (label: "a" | "b") => Omit<SyncClientOptions, "documentId">,
): Promise<HeadlessPair> {
  const a = new SyncClient({ ...makeOptions("a"), documentId });
  const b = new SyncClient({ ...makeOptions("b"), documentId });
  a.connect();
  b.connect();
  await Promise.all([waitForState(a, "synced"), waitForState(b, "synced")]);
  return { a, b };
}

/** Polls both clients' `engine.text()` until they match (or times out) — the harness's definition of "converged." */
export async function waitForConvergence(
  pair: HeadlessPair,
  timeoutMs = 10_000,
  pollMs = 20,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const textA = pair.a.engine?.text();
    const textB = pair.b.engine?.text();
    if (textA !== undefined && textA === textB) {
      return textA;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForConvergence: timed out after ${timeoutMs}ms (a=${JSON.stringify(textA)}, b=${JSON.stringify(textB)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Drives `count` local inserts, alternating which client originates each
 * one, then waits for convergence. Yields to the event loop periodically
 * so frames actually flush over the real socket rather than piling up
 * synchronously.
 */
export async function runConvergenceWorkload(pair: HeadlessPair, count: number): Promise<string> {
  for (let i = 0; i < count; i++) {
    const client = i % 2 === 0 ? pair.a : pair.b;
    const engine = client.engine;
    if (!engine) {
      throw new Error("runConvergenceWorkload: client is not synced");
    }
    const value = 0x61 + (i % 26); // 'a'..'z' cycling
    client.localInsert(engine.text().length, value);
    if (i % 25 === 24) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return waitForConvergence(pair);
}
