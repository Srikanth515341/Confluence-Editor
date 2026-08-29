import {
  encodeStructureSnapshotBody,
  SessionRole,
  SnapshotForm,
  SyncMode,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@collab-editor/protocol";
import type { DocumentCoordinator } from "./documentCoordinator.js";

/**
 * API Spec §3.6.3: "form=0 MUST NOT be sent to a session with role editor
 * or owner." Live guard, not just a comment — Phase 9 DoD: "SNAPSHOT with
 * form: 0 to an editor role is rejected in code." Throws rather than
 * silently coercing the form, since sending plain text to an editor would
 * silently drop that session's ability to anchor future concurrent inserts
 * against the real structure (Engine Spec §4.3) — a correctness bug, not a
 * cosmetic one.
 */
export function assertSnapshotFormAllowed(form: SnapshotForm, role: SessionRole): void {
  if (form === SnapshotForm.PLAIN_TEXT && role !== SessionRole.VIEWER) {
    throw new Error(
      `assertSnapshotFormAllowed: SNAPSHOT form PLAIN_TEXT must not be sent to role ${SessionRole[role]} (API Spec §3.6.3)`,
    );
  }
}

/** Builds the WELCOME message for a session that just joined `coordinator` (API Spec §3.6.2). */
export function buildWelcomeMessage(
  coordinator: DocumentCoordinator,
  sessionId: string,
  replicaId: number,
): WelcomeMessage {
  return {
    kind: "welcome",
    sessionId,
    replicaId,
    // Hardcoded EDITOR for every session this phase — real roles/auth are Phase 26-29.
    role: SessionRole.EDITOR,
    serverSeq: Number(coordinator.currentSeq),
    // This phase only ever offers a fresh SNAPSHOT — CATCHUP (reconnection) is Phase 23,
    // and ALREADY_CURRENT never applies without reconnection support to make it meaningful.
    syncMode: SyncMode.SNAPSHOT,
    participants: coordinator.listParticipants(),
  };
}

/**
 * Builds the SNAPSHOT that follows WELCOME (API Spec §3.6.3), sent when
 * `syncMode === SNAPSHOT`. `form` is unconditionally STRUCTURE this phase:
 * every session's role is hardcoded to EDITOR (`buildWelcomeMessage`
 * above), and §3.6.3 forbids form:0 (plain text) for editor/owner — so
 * form:1 is the only legal choice regardless of what the client advertised
 * in HELLO's `clientCapabilities`. The structure body's byte layout
 * (`@collab-editor/protocol`'s `encodeStructureSnapshotBody`) is this
 * phase's own placeholder serialization — EXPECTED to be reworked once
 * Phase 20's block run-length encoding (Engine Spec §7.5) lands, not
 * merely "possibly wrong" (see snapshotBody.ts's doc comment).
 */
export function buildSnapshotMessage(coordinator: DocumentCoordinator): SnapshotMessage {
  const form = SnapshotForm.STRUCTURE;
  assertSnapshotFormAllowed(form, SessionRole.EDITOR);
  return {
    kind: "snapshot",
    seq: Number(coordinator.currentSeq),
    form,
    body: encodeStructureSnapshotBody(coordinator.engine.nodes),
  };
}
