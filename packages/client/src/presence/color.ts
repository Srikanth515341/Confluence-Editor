/**
 * API Spec §8.1 — colour assignment. Colour is a PURE function of a participant's real, stable
 * authenticated user id, so every observer independently computes the identical colour for the
 * identical person, with no negotiation and no server assignment at all (no wire message carries a
 * colour anywhere in this project — see PRES-03's own requirement, and the identity note below,
 * for why).
 *
 * WHICH identity value this is fed, confirmed by tracing the real code (not assumed) before this
 * phase wrote a single line: `PresenceJoinMessage.userId`/`PresenceRosterEntry.userId`
 * (`@collab-editor/protocol`) are populated, server-side, from `CoordinatorSession.userId`
 * (`documentCoordinator.ts`), which — for a REAL, ticket-authenticated connection (Phase 29's
 * `gateway.ts`) — is `realIdentity.userId`, itself `consumed.userId` from a real, single-use
 * `POST /v1/documents/{id}/rt-ticket` (`httpApp.ts`), issued from `req.auth.user.sub`
 * (`restErrors.ts`'s `AuthLocals`) — the JWT's own `sub` claim (`tokens.ts`: "// user id"), signed
 * at login (Phase 26) from the real `users.id` PRIMARY KEY. This is the SAME value across every
 * reconnect for the same account (a fresh ticket and a fresh, never-reused `replicaId` are minted
 * on every connect, Engine Spec I1 — but `users.id` never changes), which is exactly what makes a
 * colour derived from it stable across reconnection (PRES-03's own literal requirement) where a
 * colour derived from `replicaId` would not be. A connection with NO real `auth` deps configured
 * (every pre-Phase-29 test, and any deployment that doesn't supply them) still falls back to a
 * fresh `randomUUID()` per connection (`gateway.ts`, unchanged, disclosed since Phase 16) — colour
 * stability across reconnection is consequently NOT available in that configuration, an already-
 * disclosed limitation of running without real auth, not a new gap this phase introduces.
 */

const GOLDEN_ANGLE_DEGREES = 137.508;

/**
 * FNV-1a hash → hue in [0, 360), with golden-angle offsetting to spread nearby hash values
 * apart (this file's own header comment explains why "nearby" matters at all: a plain `h % 360`
 * alone would leave hash values that happen to collide on the same bucket — or land close
 * together — indistinguishable or hard to tell apart at a glance; golden-angle spacing, applied
 * via a SECOND, coarser hash-derived index (`(h >>> 9) % 5`), pushes such values apart by a
 * quantity (137.508°, `mod 360`) chosen specifically because repeated additions of it never
 * re-align on a short cycle — the same "golden angle" spacing used for phyllotaxis/sunflower-seed
 * packing, for the identical reason: no small integer multiple of it is close to a multiple of
 * 360°). Ported LITERALLY from the phase's own supplied pseudocode (API Spec §8.1) — every
 * operator, shift amount, and constant matches verbatim; no discretionary reinterpretation.
 */
export function userHue(userId: string): number {
  let h = 2166136261 >>> 0; // FNV-1a 32-bit offset basis
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0; // FNV-1a 32-bit prime
  }
  return ((h % 360) + GOLDEN_ANGLE_DEGREES * ((h >>> 9) % 5)) % 360;
}

/** A participant's caret colour — opaque, fully saturated at a fixed lightness (API Spec §8.1: "fixed saturation/lightness keep contrast predictable; only lightness changes for high-contrast/dark themes, hue stays stable"). */
export function caretColor(userId: string): string {
  return `hsl(${userHue(userId)} 70% 45%)`;
}

/** The SAME hue as {@link caretColor}, at 22% alpha — a translucent selection wash, never opaque (so overlapping washes from several participants still let the underlying text stay readable, API Spec §8.3's own reasoning for why the 9-15 tier suppresses these entirely rather than accepting more overlap). */
export function selectionColor(userId: string): string {
  return `hsl(${userHue(userId)} 70% 45% / 0.22)`;
}
