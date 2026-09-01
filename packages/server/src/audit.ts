// The log-replay integrity audit (API Spec §6.6; Test Plan §3.2, DUR-01;
// PRD FR-PS-6). Phase 18's own framing, worth repeating here: this is
// the most important operational component in the entire system. Every
// OTHER check in this project compares replicas to each other — two
// clients, or a client against the server's own live engine — and would
// report health if they were all wrong in the same way (a shared bug in
// the Engine code, replicated identically everywhere). AUDIT() is the
// one check that doesn't have that blind spot: it compares the live
// server against an INDEPENDENT replay of what is durably in Postgres,
// built by an engine instance that shares no state with anything else
// currently running.

import { Engine } from "@collab-editor/engine";
import {
  type AuditRunInput,
  type OperationStore,
  type SeqOperation,
  type SnapshotRecord,
} from "./db/operationStore.js";
import { logger } from "./logger.js";

export interface AuditOptions {
  /**
   * The live coordinator's CURRENT materialized text, if this audit is
   * running with access to one (the in-process scheduler, auditScheduler.ts,
   * always has one; the standalone CLI, scripts/admin.ts, does not — it
   * has no way to reach a running server process's memory, so it omits
   * this and gets a DB-only audit: steps 1-4, never step 5). Comparing
   * against a STRING, not a `DocumentCoordinator` object, is deliberate —
   * it keeps this module decoupled from server/gateway internals; the
   * only thing AUDIT() needs from "the live coordinator" is the one
   * value DUR-01's assertion 6 actually compares.
   */
  readonly liveText?: string;
}

export interface AuditResult {
  readonly documentId: string;
  readonly result: "ok" | "mismatch" | "error";
  readonly replayedToSeq: bigint;
  readonly divergenceSeq: bigint | null;
  readonly detail: string;
}

/**
 * Replays `seqOps` (already ordered by seq — every caller in this file
 * loads them that way) into a fresh engine, stopping once `seq` exceeds
 * `throughSeq`. Used both for the full genesis replay (AUDIT step 2,
 * `throughSeq = Infinity`-equivalent, i.e. every op) and for bisect's
 * prefix replays (`throughSeq` = a specific snapshot's own seq).
 */
function replayThrough(seqOps: readonly SeqOperation[], throughSeq: bigint): Engine {
  const engine = new Engine(0); // arbitrary — this engine only ever applyRemote()s, never mints locally
  for (const { seq, op } of seqOps) {
    if (seq > throughSeq) {
      break; // seqOps is seq-ordered, so nothing after this point can be <= throughSeq either
    }
    engine.applyRemote(op);
  }
  return engine;
}

/**
 * BISECT (Scope-IN: "BISECT must be built, not skipped"). Invoked only
 * once AUDIT has already confirmed the LATEST snapshot's content
 * disagrees with an independent replay — this narrows WHICH snapshot,
 * across the document's entire history, is the first one that disagrees
 * (there may be many: every MAYBE-SNAPSHOT trigger, RFC §13.2, since this
 * document was created).
 *
 * The search space is the document's own snapshots, ascending by seq —
 * not an arbitrary seq range — because a snapshot's `content` is the
 * only thing genuinely checkable at a SPECIFIC, known seq without an
 * external reference; there is no independently-known "correct text"
 * at an arbitrary seq that isn't a snapshot boundary. `matches(i)` —
 * "does an independent genesis replay through snapshots[i].seq equal
 * snapshots[i].content" — is assumed MONOTONIC (true for a prefix of
 * the sorted snapshot list, false from some point on) for the purposes
 * of binary search. This is the same assumption every real bisection
 * tool makes (`git bisect` included) and has the same limitation: a
 * single, isolated, non-contiguous corruption (e.g. one specific
 * snapshot row hand-edited, with everything before AND after it
 * untouched) is not guaranteed to be found correctly by binary search —
 * only a linear scan is. It is the right tradeoff here because the
 * realistic failure mode this audit exists to catch — a persistence-
 * layer bug, not a single tampered row — plausibly corrupts a
 * CONTIGUOUS suffix of history once it starts, which IS monotonic.
 */
async function bisectSnapshotDivergence(
  seqOps: readonly SeqOperation[],
  snapshots: readonly SnapshotRecord[],
): Promise<{ readonly divergenceSeq: bigint; readonly detail: string }> {
  const matches = (i: number): boolean => {
    const snap = snapshots[i]!;
    return replayThrough(seqOps, snap.seq).text() === snap.content;
  };

  let lo = 0;
  let hi = snapshots.length - 1;
  let firstBad = snapshots.length - 1; // if the loop never narrows, the LAST snapshot is the only candidate
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (matches(mid)) {
      lo = mid + 1;
    } else {
      firstBad = mid;
      hi = mid - 1;
    }
  }

  const bad = snapshots[firstBad]!;
  return {
    divergenceSeq: bad.seq,
    detail:
      snapshots.length === 1
        ? `the only persisted snapshot (seq ${bad.seq}) disagrees with an independent genesis replay through that same seq — its content is corrupt, its structure column disagrees with what actually happened, or a bug wrote it wrong in the first place`
        : `snapshot at seq ${bad.seq} (of ${snapshots.length} total) is the first whose content disagrees with an independent genesis replay through that same seq`,
  };
}

/**
 * AUDIT(documentId) — API Spec §6.6, steps 1-6 (Phase 18 Scope-IN).
 * Always writes exactly one `audit_runs` row, whether the result is
 * 'ok', 'mismatch', or 'error' — a healthy run's own row is what "last
 * successful run" (the DoD's own metric) is computed from, so this never
 * skips writing on success the way an error-only logger would.
 */
export async function auditDocument(
  documentId: string,
  store: OperationStore,
  options: AuditOptions = {},
): Promise<AuditResult> {
  // Step 2: replay the log from genesis into a FRESH engine instance (DUR-01's own wording) —
  // done before step 1 in THIS function's order only because both are needed for step 4's
  // comparison and loading the log first lets replayedToSeq be computed from real data even if
  // no snapshot exists yet.
  const seqOps = await store.loadFullOperationLogWithSeq(documentId);
  const replay = new Engine(0);
  for (const { op } of seqOps) {
    replay.applyRemote(op);
  }
  const replayedToSeq = seqOps.length > 0 ? seqOps[seqOps.length - 1]!.seq : 0n;

  // Step 3: pendingCount() === 0 (Engine Spec I9). Checked, and reported, BEFORE any text
  // comparison — DUR-01's own reasoning: a replay whose buffer is non-empty can still
  // materialize correctly if the stranded operations were duplicates or later deletes, while an
  // operation has in fact been permanently orphaned. A text match here would be a FALSE PASS.
  if (replay.pending.length !== 0) {
    const stuckIds = new Set(replay.pending.map((op) => `${op.id.r}:${op.id.c}`));
    const stuckSeqs = seqOps
      .filter(({ op }) => stuckIds.has(`${op.id.r}:${op.id.c}`))
      .map(({ seq }) => seq);
    const result: AuditResult = {
      documentId,
      result: "error",
      replayedToSeq,
      divergenceSeq: stuckSeqs[0] ?? null,
      detail: `${replay.pending.length} operation(s) never became ready after replaying ${seqOps.length} persisted operation(s) (Engine Spec I9) — the log is missing a causal dependency, at seq ${stuckSeqs.join(", ") || "(unknown — the stranded operation's own row could not be matched back to a seq)"}`,
    };
    await recordAndLog(store, result);
    return result;
  }

  const replayText = replay.text();

  // Step 1/4: find the latest snapshot; compare an independent genesis replay THROUGH THAT
  // SNAPSHOT'S OWN SEQ (not the full/latest replay — a snapshot legitimately represents a
  // PREFIX of history if operations have landed since it was taken, which is the normal case for
  // a continuously-running audit, not a bug) against its stored content, byte-for-byte.
  const latestSnapshot = await store.getLatestSnapshot(documentId);
  if (latestSnapshot) {
    const prefixText = replayThrough(seqOps, latestSnapshot.seq).text();
    if (prefixText !== latestSnapshot.content) {
      const allSnapshots = await store.listSnapshots(documentId);
      const bisected = await bisectSnapshotDivergence(seqOps, allSnapshots);
      const result: AuditResult = {
        documentId,
        result: "mismatch",
        replayedToSeq,
        divergenceSeq: bisected.divergenceSeq,
        detail: `genesis replay through seq ${latestSnapshot.seq} does not match the latest snapshot's stored content. ${bisected.detail}`,
      };
      await recordAndLog(store, result);
      return result;
    }
  }

  // Step 5: compare against the live coordinator's own materialize() — only possible when the
  // caller actually has one (see AuditOptions.liveText's own doc comment).
  if (options.liveText !== undefined && options.liveText !== replayText) {
    // Durable storage already checked out above (no snapshot disagreed with genesis) — so this
    // mismatch is NOT explained by a corrupted snapshot. Report that distinction explicitly
    // rather than reusing bisectSnapshotDivergence's result, which would be misleading here (it
    // would report "no divergence found," which is true but doesn't explain what's ACTUALLY
    // wrong: the live in-memory engine itself has drifted from what's durably stored).
    const result: AuditResult = {
      documentId,
      result: "mismatch",
      replayedToSeq,
      divergenceSeq: null,
      detail:
        `the live coordinator's materialize() disagrees with an independent genesis replay ` +
        `through seq ${replayedToSeq}, but durable storage is internally consistent (every ` +
        `persisted snapshot matches its own genesis replay) — this points to a live/in-memory ` +
        `bug in the running coordinator, not corruption in Postgres; investigate the live ` +
        `engine directly rather than the database`,
    };
    await recordAndLog(store, result);
    return result;
  }

  const result: AuditResult = {
    documentId,
    result: "ok",
    replayedToSeq,
    divergenceSeq: null,
    detail: `replayed ${seqOps.length} operation(s) through seq ${replayedToSeq}; pendingCount() === 0${latestSnapshot ? `; matches snapshot at seq ${latestSnapshot.seq}` : " (no snapshot exists yet)"}${options.liveText !== undefined ? "; matches the live coordinator" : ""}`,
  };
  await recordAndLog(store, result);
  return result;
}

async function recordAndLog(store: OperationStore, result: AuditResult): Promise<void> {
  const input: AuditRunInput = {
    documentId: result.documentId,
    replayedToSeq: result.replayedToSeq,
    result: result.result,
    divergenceSeq: result.divergenceSeq,
    detail: result.detail,
  };
  await store.writeAuditRun(input);
  const log = result.result === "ok" ? logger.info : logger.error;
  log("audit.completed", {
    documentId: result.documentId,
    result: result.result,
    replayedToSeq: result.replayedToSeq.toString(),
    divergenceSeq: result.divergenceSeq?.toString() ?? null,
    detail: result.detail,
  });
}

// Re-exported for direct use by audit.db.test.ts's bisect-specific assertions, without needing
// to reimplement the same prefix-replay logic there.
export { replayThrough };
