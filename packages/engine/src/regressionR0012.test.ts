import { describe, expect, it } from "vitest";
import { Engine } from "./engine.js";

// tests/regression/R0012-2026-09-06-live-client-anchors-server-collected-tombstone.json
//
// CRITICAL, OPEN, UNRESOLVED as of 2026-09-06 -- see CLAUDE.md's critical-flag entry of the
// same date for the full account and the fix options under consideration. This test is the
// permanent, automated regression protection for R0012's own minimal reproduction (Test Plan
// §2.3 Rule 3 -- a complete, deterministic operation stream, no fault injection required).
//
// THIS TEST IS EXPECTED TO PASS TODAY, DOCUMENTING A REAL, UNFIXED BUG -- it is not a
// "should never happen" assertion (unlike most of this project's own regression tests). It
// exists so that once a fix (see CLAUDE.md's Option 1/2/3 discussion) actually lands, changing
// this test's own final assertions to the NEW, FIXED behavior is a deliberate, visible,
// reviewed change -- not a silent regression nobody notices.
//
// Discovered while investigating a Phase 25 M8-e soak-test failure (30,000 real operations,
// coordinator.engine.pending ended at 1,400, not 0). The soak test's own simulated clients have
// no reconnection-reconciliation logic at all, which made it initially look like the failure
// might be scoped ONLY to that simplified test harness. Explicitly checked, per the user's own
// direct challenge, against ORDINARY Engine.localInsert() -- the exact call a real,
// continuously-connected SyncClient's every live keystroke makes -- and confirmed the race is
// general, not specific to any test harness.
describe("R0012 — a live, continuously-connected client's ordinary localInsert() can anchor to a node the server has already garbage-collected", () => {
  it("reproduces a permanent, silent, single-client divergence — no reconnection, no offline queueing, no fault injection", () => {
    // Two engines standing in for "the client" (replica 1) and "the server" (replica 0),
    // built to an IDENTICAL converged state via applyRemote, exactly as a real client/server
    // pair would be after ordinary sync.
    const client = new Engine(1);
    const server = new Engine(0);

    const opA = client.localInsert(0, "A".codePointAt(0)!); // parent: null, side: "R"
    const opB = client.localInsert(1, "B".codePointAt(0)!); // parent: opA.id, side: "R" (a chain -- opB is opA's own right child)
    expect(client.text()).toBe("AB");

    server.applyRemote(opA);
    server.applyRemote(opB);
    expect(server.text()).toBe("AB");

    // Delete "B" -- an entirely ordinary user action, nothing anomalous. Applied to both
    // engines, with real GC delete-context on the server (mirroring writePath.ts's own
    // applyRemote(op, context) call for every real delete).
    const [delB] = client.localDelete(1, 1);
    expect(client.text()).toBe("A");
    server.applyRemote(delB!, { seq: 1n, atMs: 0 });
    expect(server.text()).toBe("A");

    // THE SERVER collects opB. Condition 3 ("no live node anchors this") is evaluated purely
    // against the SERVER's OWN current tree at this moment -- it structurally cannot know
    // about an operation the client has not yet minted or sent. This models the real
    // stability-frontier + undo-horizon conditions (RFC's own "unvalidated" default: 5 minutes
    // / 200 ops per replica) all having been satisfied -- reached deterministically here via a
    // direct collect() call rather than real waiting, to isolate the STRUCTURAL point from any
    // timing question.
    const result = server.collect(1n, { nowMs: 1, maxAgeMs: 0, maxOpsPerReplica: 0 });
    expect(result.incomplete).toBe(false);
    expect(result.collectedCount).toBe(1);
    expect(server.hasIdentifier(opB.id)).toBe(false); // opB is now PHYSICALLY GONE server-side

    // THE CLIENT was never told opB was collected (GC broadcasts nothing to clients -- Engine
    // Spec's own design) and never runs its own GC -- opB is still sitting in the client's own
    // tree, tombstoned, exactly as before. The client now performs an ORDINARY new local
    // insert -- nothing about this call is reconnection, reconciliation, or offline queueing;
    // it is `Engine.localInsert`, the exact function every live keystroke calls.
    // FugueTree.decidePlacement(visibleIndex=1)'s SECOND branch fires here (leftOriginNode is
    // opA, which already has a right child, opB) and calls leftmostDescendant(opB) -- which
    // performs NO deleted-status check at all -- returning the TOMBSTONED opB as the new
    // operation's own parent.
    const opD = client.localInsert(1, "D".codePointAt(0)!);
    expect(opD.parent).toEqual(opB.id); // anchored to the node the server already collected
    expect(opD.side).toBe("L");

    // The client's own engine applies opD SYNCHRONOUSLY at mint time (fundamental to this
    // project's real-time-feel design since Phase 3/10) -- the client's own view becomes "AD"
    // immediately and permanently, with no network round trip required to see it.
    expect(client.text()).toBe("AD");

    // The client sends opD to the server, exactly as any ordinary live keystroke would.
    const { buffered } = server.applyRemote(opD);
    expect(buffered).toBe(true); // opB can never come back -- PERMANENT, not a transient reorder
    expect(server.text()).toBe("A"); // the server (and every other real peer) never sees "D"

    // The defining consequence: client and server have PERMANENTLY, SILENTLY diverged. No
    // further real-world event resolves this on its own -- opD sits in server.pending forever
    // unless something explicitly evicts it (offlineWindowScheduler.ts's Rule 7.2 sweep), and
    // even then, the CLIENT's own local engine has no mechanism to walk back an
    // already-integrated insert. "AD" remains permanently, incorrectly visible to this one
    // user unless a currently-unbuilt client-side reversal mechanism is added (see CLAUDE.md's
    // Option 1/2/3 discussion for this exact date).
    expect(client.text()).not.toBe(server.text());
  });
});
