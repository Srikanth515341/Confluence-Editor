import type { Identifier } from "@collab-editor/engine";
import {
  CLIENT_CAP_HAS_RESIDENT_ENGINE,
  encodeCatchupOperation,
  encodeStructureSnapshotBody,
  SessionRole,
  SnapshotForm,
  SyncMode,
  type AlreadyHaveMessage,
  type CatchupBeginMessage,
  type CatchupChunkMessage,
  type CatchupEndMessage,
  type HelloMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@collab-editor/protocol";
import type { SeqOperation } from "./db/operationStore.js";
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

/**
 * Builds the WELCOME message for a session that just joined `coordinator` (API Spec §3.6.2).
 * `syncMode` is decided by {@link decideSyncMode} — see that function for the SNAPSHOT/
 * CATCHUP/ALREADY_CURRENT decision itself. `role` defaults to EDITOR — real roles/auth are
 * still Phase 26-29; the only way this phase (24) ever passes anything else is
 * `DocumentCoordinator.testOnlyQueueRoleOverride`'s own consuming call site in gateway.ts
 * (Test Plan RC-32). "Viewers may read": a VIEWER role does not change `syncMode` or gate
 * CATCHUP/SNAPSHOT delivery in any way — only writePath.ts's `authorize` step (Phase 24) acts
 * on it, for OPS traffic specifically.
 */
export function buildWelcomeMessage(
  coordinator: DocumentCoordinator,
  sessionId: string,
  replicaId: number,
  syncMode: SyncMode,
  role: SessionRole = SessionRole.EDITOR,
): WelcomeMessage {
  return {
    kind: "welcome",
    sessionId,
    replicaId,
    role,
    serverSeq: Number(coordinator.currentSeq),
    syncMode,
    participants: coordinator.listParticipants(),
  };
}

/**
 * Decides WELCOME's `syncMode` (API Spec §3.6.2, Phase 23's reconnection
 * handshake) from what the client reported in HELLO and where the
 * document's own log currently stands:
 *
 * - SNAPSHOT — the client has no resident engine to apply a delta onto
 *   (`CLIENT_CAP_HAS_RESIDENT_ENGINE` unset: a fresh join, or a fresh page
 *   load that only restored durable METADATA, Phase 22, never actual
 *   document content), OR its reported `lastServerSeq` is 0 (never
 *   connected before) or somehow AHEAD of `currentSeq` (should not happen
 *   in practice; treated as "start fresh" rather than trusted or rejected
 *   — the same self-healing latitude this project has taken for other
 *   defensive edge cases since Phase 8).
 * - ALREADY_CURRENT — `lastServerSeq === currentSeq`: the client's own
 *   resident engine is already caught up: nothing to send state-sync-wise.
 * - CATCHUP — everything else: a resident engine trailing behind
 *   `currentSeq` by a real, known amount. `buildCatchupMessages` sends the
 *   `(lastServerSeq, currentSeq]` delta instead of a full SNAPSHOT.
 *
 * ALREADY_HAVE (the client's own unacked-stamp reconciliation) is decided
 * completely independently of this — see `buildAlreadyHaveMessage` — and
 * is sent regardless of which of these three modes applies.
 */
export function decideSyncMode(hello: HelloMessage, currentSeq: bigint): SyncMode {
  const hasResidentEngine = (hello.clientCapabilities & CLIENT_CAP_HAS_RESIDENT_ENGINE) !== 0;
  const lastServerSeq = BigInt(hello.lastServerSeq);
  if (!hasResidentEngine || lastServerSeq <= 0n || lastServerSeq > currentSeq) {
    return SyncMode.SNAPSHOT;
  }
  if (lastServerSeq === currentSeq) {
    return SyncMode.ALREADY_CURRENT;
  }
  return SyncMode.CATCHUP;
}

/** Mandatory chunking (Scope-IN, API Spec §3.6.5): ≤256 operations or ≤64KB encoded per chunk. */
const CATCHUP_CHUNK_MAX_OPS = 256;
const CATCHUP_CHUNK_MAX_BYTES = 64 * 1024;

/** Groups a seq-ordered range of operations into CATCHUP_CHUNK messages, each carrying its own last operation's seq as `throughSeq`. Exported for direct unit testing of the chunking boundaries. */
export function chunkCatchupOperations(rangeOps: readonly SeqOperation[]): CatchupChunkMessage[] {
  const chunks: CatchupChunkMessage[] = [];
  let current: Array<SeqOperation["op"]> = [];
  let currentBytes = 0;
  let currentThroughSeq = 0;
  for (const { op, seq } of rangeOps) {
    const opBytes = encodeCatchupOperation(op).length;
    if (
      current.length > 0 &&
      (current.length >= CATCHUP_CHUNK_MAX_OPS || currentBytes + opBytes > CATCHUP_CHUNK_MAX_BYTES)
    ) {
      chunks.push({ kind: "catchupChunk", throughSeq: currentThroughSeq, ops: current });
      current = [];
      currentBytes = 0;
    }
    current.push(op);
    currentBytes += opBytes;
    currentThroughSeq = Number(seq);
  }
  if (current.length > 0) {
    chunks.push({ kind: "catchupChunk", throughSeq: currentThroughSeq, ops: current });
  }
  return chunks;
}

/**
 * Builds the full CATCHUP_BEGIN / CATCHUP_CHUNK[] / CATCHUP_END sequence
 * for a client whose WELCOME carried `syncMode: CATCHUP` (API Spec
 * §3.6.4-§3.6.6). `toSeq` is read from `coordinator.currentSeq` at the
 * moment this is called (may already be behind by the time all chunks
 * finish streaming, if concurrent operations commit meanwhile — those
 * simply reach this session afterward via the normal live OPS broadcast,
 * same as for any already-joined session; see CatchupBeginMessage's own
 * doc comment).
 */
export async function buildCatchupMessages(
  coordinator: DocumentCoordinator,
  fromSeq: number,
): Promise<{
  readonly begin: CatchupBeginMessage;
  readonly chunks: readonly CatchupChunkMessage[];
  readonly end: CatchupEndMessage;
}> {
  const toSeq = coordinator.currentSeq;
  const rangeOps = await coordinator.operationStore.loadOperationLogRange(
    coordinator.documentId,
    BigInt(fromSeq),
    toSeq,
  );
  const chunks = chunkCatchupOperations(rangeOps);
  return {
    begin: { kind: "catchupBegin", fromSeq, toSeq: Number(toSeq), totalOps: rangeOps.length },
    chunks,
    end: { kind: "catchupEnd", toSeq: Number(toSeq), totalOps: rangeOps.length },
  };
}

/**
 * Builds ALREADY_HAVE (API Spec §3.6.7) from the client's own HELLO.unacked
 * stamps — checked against durable storage (`findExistingStamps`, GC-
 * independent, see its own doc comment), never the live engine's
 * structure. Sent unconditionally, even when `unackedStamps` is empty or
 * none of it is already committed (an empty `alreadyHave` array is a
 * complete, meaningful answer: "resend everything," not "nothing to
 * report").
 */
export async function buildAlreadyHaveMessage(
  coordinator: DocumentCoordinator,
  unackedStamps: readonly Identifier[],
): Promise<AlreadyHaveMessage> {
  if (unackedStamps.length === 0) {
    return { kind: "alreadyHave", alreadyHave: [] };
  }
  const alreadyHave = await coordinator.operationStore.findExistingStamps(
    coordinator.documentId,
    unackedStamps,
  );
  return { kind: "alreadyHave", alreadyHave };
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
