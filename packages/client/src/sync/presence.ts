/**
 * Client-side PRESENCE cap enforcement (API Spec §9.3-§9.5, Phase 31) — TWO of the spec's three
 * enforcement points; the THIRD (a server-side ceiling that drops excess) lives entirely in
 * `packages/server/src/presenceManager.ts`. Deliberately has NO import from
 * `@collab-editor/engine` or any persistence module (Scope-IN: "structural isolation — the
 * presence code has no import from the engine or persistence layer") — a cursor/selection
 * position is passed in as an already-resolved, fully opaque value; this module never inspects,
 * mutates, or even knows the real shape of an `Identifier`, only that it can be handed, as-is, to
 * a `send` callback the caller supplies.
 */

export interface PresencePosition {
  readonly anchor: unknown | null;
  readonly focus: unknown | null;
  readonly collapsed: boolean;
}

/** §9.3 point 1: "coalescing on a 50ms trailing edge." */
const COALESCE_MS = 50;
/** §9.3 point 2: "a hard cap at 20/s" — a sliding window over the trailing second. */
const MAX_UPDATES_PER_SECOND = 20;
const HARD_CAP_WINDOW_MS = 1000;

/**
 * Coalesces a rapid stream of local cursor/selection changes into at most one PRESENCE_UPDATE
 * roughly every 50ms, REPLACING whatever was pending rather than queuing it (§9.3: "only the
 * newest cursor position matters") — a trailing-edge design: the timer is armed on the FIRST
 * change after an idle period and is NEVER reset by later changes arriving before it fires, so a
 * sustained stream of changes still flushes on a steady ~50ms cadence (this alone already
 * produces at most 20 sends/second; the separate hard cap below is a second, independent
 * enforcement point — belt and suspenders, not redundant by accident, per this phase's own
 * explicit three-point design).
 */
export class PresenceUpdateCoalescer {
  private pendingPosition: PresencePosition | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sentAtMs: number[] = [];

  constructor(
    /** Called with the coalesced/capped position — never more often than the cap allows. */
    private readonly send: (position: PresencePosition) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Called on every local cursor/selection change. REPLACES any not-yet-flushed pending position. */
  update(position: PresencePosition): void {
    this.pendingPosition = position;
    if (this.coalesceTimer !== undefined) {
      return; // a trailing-edge timer is already armed; it will pick up this newer position when it fires
    }
    this.coalesceTimer = setTimeout(() => this.flush(), COALESCE_MS);
    this.coalesceTimer.unref?.();
  }

  private flush(): void {
    this.coalesceTimer = undefined;
    const position = this.pendingPosition;
    this.pendingPosition = null;
    if (position === null) {
      return;
    }
    const nowMs = this.now();
    // §9.3 point 2 — the client's own hard cap, independent of the coalescing above.
    while (this.sentAtMs.length > 0 && nowMs - this.sentAtMs[0]! >= HARD_CAP_WINDOW_MS) {
      this.sentAtMs.shift();
    }
    if (this.sentAtMs.length >= MAX_UPDATES_PER_SECOND) {
      return; // dropped — the NEXT local change re-arms the timer and gets its own chance
    }
    this.sentAtMs.push(nowMs);
    this.send(position);
  }

  /** Cancels any pending coalesced update — called on disconnect so a stale timer never fires against a torn-down connection. */
  dispose(): void {
    if (this.coalesceTimer !== undefined) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = undefined;
    }
    this.pendingPosition = null;
  }
}
