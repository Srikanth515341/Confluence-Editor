import {
  Engine,
  type DeleteOperation,
  type InsertOperation,
  type Node,
} from "@collab-editor/engine";

/**
 * Reconstructs a fresh `Engine`'s full state from a decoded structure-form
 * SNAPSHOT (API Spec §3.6.3, `packages/protocol/src/snapshotBody.ts`).
 *
 * There is no separate "load state directly" mutation path on `Engine` —
 * deliberately: the only way `nodes`/`byKey`/`deleted`/`deletedBy` are
 * ever allowed to change is through `applyRemote()`'s normal
 * ready()/integrate() pipeline, which is exactly what 60,000 convergence
 * fuzz trials (Test Plan §2.2) and the adversarial suite (§2.4) have
 * exercised. So seeding replays each snapshot node as the synthetic
 * remote operation(s) that would have produced it:
 *
 *  - every node becomes an INSERT (its own id/value/originLeft/
 *    originRight/bind — a snapshot node carries exactly the fields an
 *    InsertOperation needs);
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
 * is exactly what a structural walk needs: a node's `originLeft` is always
 * structurally to its left (so already replayed by the time we reach it),
 * but `originRight` is always structurally to its RIGHT (not yet replayed)
 * — every non-final insert is buffered on first attempt and resolved once
 * its `originRight` is replayed later in the same pass.
 */
export function seedEngineFromSnapshot(replicaId: number, nodes: readonly Node[]): Engine {
  const engine = new Engine(replicaId);

  for (const node of nodes) {
    const insertOp: InsertOperation = {
      kind: "insert",
      id: node.id,
      value: node.value,
      originLeft: node.originLeft,
      originRight: node.originRight,
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

  return engine;
}
