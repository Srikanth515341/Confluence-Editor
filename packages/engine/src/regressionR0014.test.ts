import { describe, expect, it } from "vitest";
import { Engine } from "./engine.js";

// tests/regression/R0014-2026-09-13-undo-idempotent-delete-enables-redo-resurrection.json
//
// FOUND AND FIXED the same phase (36), before merge -- unlike R0012 (still open as of this
// writing), this test asserts the CORRECT, FIXED behavior: it is a permanent regression guard,
// not a documented-bug placeholder. If this test ever starts failing again, Engine.undo()/
// redo()'s `hadEffect` tracking (see engine.ts's own `stepUndoRedo`/`undoStack` doc comments)
// has regressed.
//
// Found while writing Phase 36's own UNDO-07 (redo-symmetry) test for the UNDO-06 scenario
// (undo of an insert already deleted by a peer). The bug: undo's own "idempotent" Delete (Engine
// Spec §9.2, "possibly advances deletedBy... THE DOCUMENT IS UNCHANGED") silently reassigns
// `deletedBy` to the UNDOING replica as a side effect of applyDelete's own correct, necessary
// max-wins attribution logic -- and a LATER redo's Undelete then satisfies Engine Spec §4.6's
// replica-equality check against THAT reassigned attribution, resurrecting content a third
// party legitimately, independently deleted. A direct, silent violation of Engine Spec §9.3 /
// PRD OQ-3's own stated guarantee ("overriding it would resurrect text a colleague deliberately
// removed"), reachable via entirely ordinary use of the shipped undo/redo feature -- no fault
// injection, no reconnection, no GC/undo-horizon interaction required.
describe("R0014 — undo of an already-peer-deleted insert must not enable a LATER redo to resurrect it", () => {
  it("redo of a no-op undo stays a no-op, through repeated undo/redo cycles, never overriding the peer's own independent deletion", () => {
    const a = new Engine(10);
    const b = new Engine(20);

    const opA = a.localInsert(0, "x".codePointAt(0)!);
    b.applyRemote(opA);
    expect(b.text()).toBe("x");

    // B deletes A's own insert -- entirely independent of anything A does next.
    const [delOpB] = b.localDelete(0, 1);
    a.applyRemote(delOpB!);
    expect(a.text()).toBe("");
    expect(b.text()).toBe("");
    const nodeAfterBsDelete = a.nodes.find((n) => n.id.c === opA.id.c && n.id.r === opA.id.r)!;
    expect(nodeAfterBsDelete.deletedBy).toEqual(delOpB!.id); // B's own attribution, confirmed

    // A undoes ITS OWN original insert -- per Engine Spec §9.2, this is a real, transmitted
    // Delete, but the document must be UNCHANGED (already gone).
    const undoOutcome = a.undo();
    expect(undoOutcome.kind).toBe("applied");
    expect(a.text()).toBe(""); // no-op, as UNDO-06/FR-CE-12 requires
    if (undoOutcome.kind === "applied") {
      b.applyRemote(undoOutcome.operation);
    }
    expect(b.text()).toBe("");

    // THE BUG: at this point, pre-fix, `deletedBy` had already been silently reassigned to A's
    // own fresh delete as a side effect of the idempotent Delete above -- entirely invisible
    // from `a.text()` alone, which is exactly why this required a dedicated redo check to catch.
    for (let cycle = 0; cycle < 5; cycle++) {
      // A redoes -- per the bug, THIS is where a fixed engine must still refuse to resurrect,
      // and must keep refusing across MULTIPLE further redo/undo cycles of the same entry, not
      // just the first one.
      const redoOutcome = a.redo();
      expect(redoOutcome.kind).toBe("applied");
      expect(a.text()).toBe(""); // MUST stay empty -- B's deletion must never be overridden
      if (redoOutcome.kind === "applied") {
        b.applyRemote(redoOutcome.operation);
      }
      expect(b.text()).toBe("");

      const undoAgain = a.undo();
      expect(undoAgain.kind).toBe("applied");
      expect(a.text()).toBe("");
      if (undoAgain.kind === "applied") {
        b.applyRemote(undoAgain.operation);
      }
      expect(b.text()).toBe("");
    }
  });
});
