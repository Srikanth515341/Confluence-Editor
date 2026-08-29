/**
 * Placeholder. The real operation union — Insert, Delete, and Undelete
 * records (Engine Spec §4.1) — is defined in Phase 3, alongside
 * integrate()/applyRemote() and the readiness/buffering rules that consume
 * it. It is declared now, minimally, only so the Engine shell in this phase
 * has a concrete type for its `pending` buffer (Engine Spec §4.2).
 */
export interface Operation {
  readonly kind: string;
}
