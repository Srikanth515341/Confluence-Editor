/**
 * The connection lifecycle (Scope-IN: "Connection state machine: connecting
 * | synced | reconnecting | offline, exposed as an observable"):
 *
 * - `connecting`   the very first attempt after `connect()` is called,
 *                   before this client has EVER reached `synced` once.
 * - `synced`        a full HELLO->WELCOME->SNAPSHOT handshake has
 *                   completed; `engine` reflects real document state.
 * - `reconnecting`  the socket was lost (or a sequence gap forced a
 *                   deliberate close, API Spec §3.7.5) and an automatic
 *                   retry (with backoff) is in progress — covers both the
 *                   backoff wait and the connection attempt itself as one
 *                   state, since from the caller's perspective there is
 *                   nothing actionable to distinguish between them.
 * - `offline`       `disconnect()` was called explicitly; no further
 *                   automatic retries happen until `connect()` is called
 *                   again.
 */
export type ConnectionState = "connecting" | "synced" | "reconnecting" | "offline";

/** Read side of an observable value — current value plus change notification. */
export interface Observable<T> {
  readonly value: T;
  /** Registers `listener`, called on every change (not on subscribe). Returns an unsubscribe function. */
  subscribe(listener: (value: T) => void): () => void;
}

/** Minimal observable value. No external dependency — this project has no reactive-state library yet. */
export class ObservableValue<T> implements Observable<T> {
  private current: T;
  private readonly listeners = new Set<(value: T) => void>();

  constructor(initial: T) {
    this.current = initial;
  }

  get value(): T {
    return this.current;
  }

  set(next: T): void {
    if (next === this.current) {
      return; // no-op on a redundant set — listeners only ever see real transitions
    }
    this.current = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
