// Presence rendering (Phase 33, API Spec §8). Colour assignment (§8.1) and the overlay renderer
// (§8.2/§8.3) — see each file's own header comment. Distinct from `sync/presence.ts` (Phase 31),
// which handles the WIRE/rate-limiting side of presence and deliberately has no engine import;
// this directory is the RENDERING side and legitimately does.

export { caretColor, selectionColor, userHue } from "./color.js";
export {
  PresenceOverlay,
  densityTierFor,
  type PresenceDensityTier,
  type PresenceOverlayDeps,
} from "./presenceOverlay.js";
