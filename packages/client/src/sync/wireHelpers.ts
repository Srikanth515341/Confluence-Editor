import type { DeleteOperation, InsertOperation, Operation } from "@collab-editor/engine";
import {
  expandDeleteBatch,
  expandInsertRun,
  opDeleteToOperation,
  opInsertToOperation,
  opUndeleteToOperation,
  operationToOpDelete,
  operationToOpInsert,
  operationToOpUndelete,
  type OpInsertRunMessage,
  type OpsMessage,
} from "@collab-editor/protocol";

/**
 * Expands any inbound OPS message into the engine Operation(s) it
 * represents — the client-side mirror of `packages/server/src/ingest.ts`'s
 * `toOperations`. Duplicated rather than imported: `packages/client` must
 * not depend on `@collab-editor/server` (a client-side module has no
 * business depending on the server package), and this is a small, stable,
 * pure function built entirely from Phase 7's `@collab-editor/protocol`
 * exports.
 */
export function toOperations(msg: OpsMessage): Operation[] {
  switch (msg.kind) {
    case "opInsert":
      return [opInsertToOperation(msg)];
    case "opInsertRun":
      return expandInsertRun(msg);
    case "opDelete":
      return [opDeleteToOperation(msg)];
    case "opDeleteBatch":
      return expandDeleteBatch(msg);
    case "opUndelete":
      return [opUndeleteToOperation(msg)];
    case "opAck":
    case "opReject":
      throw new Error(`toOperations: ${msg.kind} carries no operation to apply`);
  }
}

/** The reverse direction: one locally-minted engine Operation to the OPS message that carries it (always `seq: 0` — client-origin, API Spec §3.5.1). */
export function operationToOpsMessage(op: Operation): OpsMessage {
  switch (op.kind) {
    case "insert":
      return operationToOpInsert(op, 0);
    case "delete":
      return operationToOpDelete(op, 0);
    case "undelete":
      return operationToOpUndelete(op, 0);
  }
}

/**
 * Coalesces a sequence of locally-minted `InsertOperation`s (as produced by
 * calling `Engine.localInsert()` once per character, in ascending-position
 * order — Phase 12's `SyncClient.localInsertText`) into as few OPS
 * messages as possible, per API Spec §3.5.2: consecutive characters from
 * one run mint CONSECUTIVE counters by construction (Engine Spec §3.4), so
 * any maximal run of two or more with the SAME `bind` flag (§3.5.2 models a
 * run as one grapheme-cluster-uniform burst — there is no per-character
 * bind bit on the wire) becomes one OP_INSERT_RUN; everything else
 * (singletons, or a bind-flag change) falls back to individual OP_INSERT
 * messages. This is what turns a 2,000-character paste into ONE wire frame
 * instead of 2,000 (Test Plan MUT-01), while still coalescing correctly
 * around any embedded combining marks in less common inputs.
 *
 * REGRESSION FIX (2026-09-06, Phase 25 DUR-06 investigation — see
 * wireHelpers.test.ts's own "REGRESSION" describe block): grouping used to
 * check ONLY `bind` equality. `expandInsertRun`'s decoder hardcodes a
 * specific chain relationship for every run member after the first —
 * `parent === previous.id && side === "R"` (see expand.ts's own doc
 * comment) — which genuinely holds for THIS function's original caller
 * (`SyncClient.localInsertText`'s synchronous typing burst: traced against
 * `FugueTree.decidePlacement`, the left-origin at each subsequent position
 * is always the just-minted previous character, which has zero
 * `rightChildren`, so `decidePlacement` unconditionally returns
 * `{parent: prev.id, side: "R"}` every time) but is NOT guaranteed for
 * `operationsToWireMessages`'s other caller (`reconcileOfflineQueue`'s
 * reconciliation resend, whose operations are independently re-anchored
 * against the live engine, not a contiguous typed chain). `continuesRun`
 * below checks the actual chain relationship, not just `bind` — a group
 * only coalesces into one run if EVERY adjacent pair genuinely forms the
 * chain the decoder will assume. This changes nothing for the original
 * caller (the chain always holds there, proven above) and correctly
 * splits at any non-chain boundary for the reconciliation caller.
 */
function continuesRun(next: InsertOperation, prev: InsertOperation): boolean {
  return (
    next.bind === prev.bind &&
    next.side === "R" &&
    next.parent !== null &&
    next.parent.c === prev.id.c &&
    next.parent.r === prev.id.r &&
    // Belt-and-suspenders: counter contiguity is implied by "these are two
    // sequential mints on the same engine with nothing else interleaved,"
    // which is true for both current callers, but the wire format's
    // `firstId.c + j` decode arithmetic depends on it directly — check it
    // explicitly rather than relying on an invariant enforced two files away.
    next.id.r === prev.id.r &&
    next.id.c === prev.id.c + 1
  );
}

export function operationsToRunMessages(ops: readonly InsertOperation[]): OpsMessage[] {
  const messages: OpsMessage[] = [];
  let i = 0;
  while (i < ops.length) {
    let j = i + 1;
    while (j < ops.length && continuesRun(ops[j]!, ops[j - 1]!)) {
      j += 1;
    }
    const group = ops.slice(i, j);
    const first = group[0]!;
    if (group.length >= 2) {
      const runMsg: OpInsertRunMessage = {
        kind: "opInsertRun",
        seq: 0,
        firstId: first.id,
        firstParent: first.parent,
        firstSide: first.side,
        bind: first.bind,
        values: group.map((op) => op.value),
      };
      messages.push(runMsg);
    } else {
      messages.push(operationToOpInsert(first, 0));
    }
    i = j;
  }
  return messages;
}

/**
 * Phase 24 — coalesces a MIXED sequence of freshly re-minted Operations (Insert AND Delete
 * both, as produced by `reconcileOfflineQueue.ts`'s reconnection replay) into as few OPS
 * messages as possible: a maximal run of ≥2 consecutive INSERTs (same `bind`) becomes one
 * OP_INSERT_RUN (delegates to {@link operationsToRunMessages}); a maximal run of ≥2
 * consecutive DELETEs from one replica becomes one OP_DELETE_BATCH (API Spec §3.5.4 — n≥2,
 * consecutive `id.c`, exactly what consecutive `Engine.localDelete()` calls under one engine
 * produce by construction, Invariant I0); everything else (singletons, or a kind boundary)
 * falls back to individual OP_INSERT/OP_DELETE messages.
 *
 * This is what lets a large reconnection reconciliation (Test Plan RC-32: 400 operations)
 * reach the server as ONE (or a small few) wire frame(s) instead of hundreds — which in turn
 * is what lets a server-side rejection of the WHOLE batch (e.g. PERMISSION_DENIED) arrive back
 * at the client as ONE OP_REJECT response, per RC-32's own "in one response" requirement:
 * `processIncomingOperation` (server, writePath.ts) rejects one incoming message's entire
 * expanded `ops` array as a single unit, so fewer incoming messages means fewer, larger
 * OP_REJECT batches.
 */
export function operationsToWireMessages(ops: readonly Operation[]): OpsMessage[] {
  const messages: OpsMessage[] = [];
  let i = 0;
  while (i < ops.length) {
    const kind = ops[i]!.kind;
    let j = i + 1;
    while (j < ops.length && ops[j]!.kind === kind) {
      j += 1;
    }
    const group = ops.slice(i, j);
    if (kind === "insert") {
      messages.push(...operationsToRunMessages(group as InsertOperation[]));
    } else if (kind === "delete") {
      messages.push(...deleteOperationsToMessages(group as DeleteOperation[]));
    } else {
      // "undelete" — never produced by this client's own local mint paths (localInsert/
      // localDelete only, Engine Spec §9.3's resurrection semantics are Phase 36) —
      // reconcileOfflineQueue.ts's own doc comment already establishes this is unreachable via
      // this client's public API. One OP_UNDELETE per item, defensively, rather than a silent
      // drop, should that ever change.
      for (const op of group) {
        messages.push(operationToOpsMessage(op));
      }
    }
    i = j;
  }
  return messages;
}

/** The DELETE half of {@link operationsToWireMessages} — same maximal-run coalescing shape as {@link operationsToRunMessages}, but grouping by consecutive `id.c` from one replica (API Spec §3.5.4's OP_DELETE_BATCH contract) instead of by `bind`. */
function deleteOperationsToMessages(ops: readonly DeleteOperation[]): OpsMessage[] {
  const messages: OpsMessage[] = [];
  let i = 0;
  while (i < ops.length) {
    let j = i + 1;
    while (
      j < ops.length &&
      ops[j]!.id.r === ops[i]!.id.r &&
      ops[j]!.id.c === ops[j - 1]!.id.c + 1
    ) {
      j += 1;
    }
    const group = ops.slice(i, j);
    if (group.length >= 2) {
      messages.push({
        kind: "opDeleteBatch",
        seq: 0,
        by: group[0]!.id.r,
        atFirst: group[0]!.id.c,
        targets: group.map((op) => op.target),
      });
    } else {
      messages.push(operationToOpDelete(group[0]!, 0));
    }
    i = j;
  }
  return messages;
}
