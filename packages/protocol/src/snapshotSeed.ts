import {
  Engine,
  type DeleteOperation,
  type InsertOperation,
  type Node,
} from "@collab-editor/engine";

/**
 * Replays a decoded structure-form SNAPSHOT's nodes (`snapshotBody.ts`)
 * into an EXISTING engine as the synthetic remote operation(s) that would
 * have produced them. Shared by two consumers as of Phase 17 — the
 * client (`SyncClient.handleSnapshot`, Phase 10, seeding a brand-new
 * `Engine` on every live SNAPSHOT) and the server
 * (`DocumentCoordinator.warmStart`, Phase 17, seeding its own
 * already-constructed `engine` from the latest persisted snapshot before
 * replaying the operation-log suffix on top) — moved here from
 * `packages/client/src/sync/snapshotSeed.ts` once a second consumer
 * needed the identical logic, rather than duplicating it the way
 * `wireHelpers.ts` deliberately duplicates server conversion helpers
 * client-side (that duplication exists specifically because a client
 * must never depend on `@collab-editor/server`; both client and server
 * already depend on `@collab-editor/protocol`, so there is no such
 * constraint here).
 *
 * There is no separate "load state directly" mutation path on `Engine` —
 * deliberately: the only way `nodes`/`byKey`/`deleted`/`deletedBy` are
 * ever allowed to change is through `applyRemote()`'s normal
 * ready()/integrate() pipeline, which is exactly what 60,000 convergence
 * fuzz trials (Test Plan §2.2) and the adversarial suite (§2.4) have
 * exercised. So seeding replays each snapshot node as the synthetic
 * remote operation(s) that would have produced it:
 *
 *  - every node becomes an INSERT (its own id/value/parent/side/bind —
 *    Fugue port, 2026-09-05 — a snapshot node carries exactly the fields
 *    an InsertOperation needs);
 *  - every node with `deleted: true` ALSO becomes a DELETE whose own `id`
 *    is the node's `deletedBy` — Engine Spec §4.5's causally-latest rule
 *    means `deletedBy` already IS the winning delete's own identity
 *    (`applyDelete` sets `node.deletedBy = op.id` directly), so replaying
 *    exactly that one synthetic delete reproduces the tombstone with the
 *    correct attribution, without needing to replay every historical
 *    concurrent delete that ever raced for this node.
 *
 * Nodes are fed in the snapshot's own (structural) order, but that is not
 * a correctness requirement — `applyRemote()`/`drain()` already buffer and
 * re-resolve out-of-order arrivals to a fixpoint (Engine Spec §4.2), which
 * is exactly what a structural walk needs regardless of DIRECTION. Note
 * this is a WEAKER guarantee under Fugue than the retired YATA design had:
 * `originLeft` was always structurally to a node's left (already replayed)
 * and `originRight` always to its right — a fixed direction. A Fugue
 * node's `parent` is structurally BEFORE it for `side: "R"` (an in-order
 * traversal visits a parent before its own right subtree) but structurally
 * AFTER it for `side: "L"` (the node becomes part of `parent`'s own LEFT
 * subtree, which an in-order traversal visits before `parent` itself) —
 * so a `side: "L"` node's dependency is fed AFTER it in a structural walk,
 * not before. This is still correct, not merely "usually fine": the
 * buffer/drain fixpoint does not care which direction a dependency lies
 * in, only that it eventually arrives in the same pass, which it always
 * does here (every node in `nodes` is fed exactly once).
 */
export function replaySnapshotNodesInto(engine: Engine, nodes: readonly Node[]): void {
  for (const node of nodes) {
    const insertOp: InsertOperation = {
      kind: "insert",
      id: node.id,
      value: node.value,
      parent: node.parent,
      side: node.side,
      bind: node.bind,
    };
    engine.applyRemote(insertOp);
  }

  for (const node of nodes) {
    if (node.deleted) {
      const deleteOp: DeleteOperation = {
        kind: "delete",
        id: node.deletedBy!, // node.deleted implies deletedBy !== null (Node's own invariant)
        target: node.id,
      };
      engine.applyRemote(deleteOp);
    }
  }
}

/** Constructs a BRAND NEW `Engine` and seeds it via {@link replaySnapshotNodesInto} — the client's own use case (Phase 10), which always builds a fresh `Engine` per SNAPSHOT rather than mutating an existing one. */
export function seedEngineFromSnapshot(replicaId: number, nodes: readonly Node[]): Engine {
  const engine = new Engine(replicaId);
  replaySnapshotNodesInto(engine, nodes);
  return engine;
}
