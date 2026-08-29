import type { ReplicaAdapter, ReplicaFactory } from "./adapter.js";

interface ToyOp {
  readonly kind: "insert" | "delete";
  readonly value: number;
}

/**
 * A DELIBERATELY WRONG replica: every remote operation is applied by
 * always appending (insert) or popping from the end (delete), completely
 * ignoring where the operation actually belongs. This is the naive
 * index-based operation merge PRD §1.2(c) walks through by hand — "looks
 * correct and is not," because both keystrokes get delivered and nothing
 * is dropped, yet the replicas still diverge.
 *
 * It exists solely to prove this phase's Definition of Done: that the
 * harness's divergence assertion actually fires. It is never used against
 * the real engine.
 */
export function createToyAdapter(): ReplicaFactory<ToyOp> {
  return (replicaId: number): ReplicaAdapter<ToyOp> => {
    const chars: number[] = [];

    return {
      replicaId,

      localInsert(visibleIndex, value) {
        chars.splice(visibleIndex, 0, value);
        return { kind: "insert", value };
      },

      localDelete(visibleIndex, count) {
        const removed = chars.splice(visibleIndex, count);
        return removed.map((value): ToyOp => ({ kind: "delete", value }));
      },

      applyRemote(op) {
        // THE BUG: no origin, no stable position — always appends or pops
        // at the end, regardless of where the remote user actually typed.
        if (op.kind === "insert") {
          chars.push(op.value);
        } else {
          chars.pop();
        }
        return { buffered: false };
      },

      text() {
        return chars.map((c) => String.fromCodePoint(c)).join("");
      },

      structureLength() {
        return chars.length;
      },

      pendingCount() {
        return 0; // the toy never buffers anything — it is wrong in a different way entirely
      },
    };
  };
}
