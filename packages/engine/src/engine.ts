import type { Identifier } from "./identifier.js";
import type { Node } from "./node.js";
import type { Operation } from "./operation.js";

/** Structural metrics feeding PRD M8 / RFC §7.8's tombstone-ratio observability. */
export interface EngineStats {
  readonly totalElements: number;
  readonly tombstones: number;
  readonly visibleLength: number;
}

/**
 * OBSEQ convergence engine — Phase 1 shell.
 *
 * This phase implements only the data structures and identifier generation
 * (Engine Spec §2, §3). integrate() / applyRemote() / applyDelete() /
 * applyUndelete() (Engine Spec §4.3–§4.6) are Phase 3; the index (§8.5) is
 * Phase 19; garbage collection (§7) is Phase 21; undo (§9) is Phase 36. The
 * shape below exists now so later phases extend one class rather than
 * re-deriving its fields.
 *
 * Purity: this class touches nothing but its own in-memory fields. No DOM,
 * no network, no storage, no wall clock — enforced independently by
 * eslint.config.js and scripts/check-engine-purity.mjs.
 */
export class Engine {
  readonly replicaId: number;

  /**
   * Lamport clock. Advanced ONLY by mint() (+1) and observe() (max) — see
   * their docstrings. Never read or written anywhere else in this class.
   */
  private clock = 0;

  /** Ordered node sequence S (Engine Spec Definition 2.2). Populated starting Phase 3. */
  readonly nodes: Node[] = [];

  /** Identifier → Node lookup K (Engine Spec Definition 2.2), keyed by a serialized identifier. */
  private readonly byKey = new Map<string, Node>();

  /**
   * Origin stamps of operations already applied — the mechanism behind
   * Engine Spec §6.3's idempotence guarantee (applying an already-present
   * identifier is a no-op). Populated starting Phase 3.
   */
  private readonly applied = new Set<string>();

  /** Operations buffered because their causal dependencies are unmet (Engine Spec §4.2). */
  readonly pending: Operation[] = [];

  constructor(replicaId: number) {
    this.replicaId = replicaId;
  }

  /**
   * Mints a NEW local identifier. Advances the clock by exactly 1.
   *
   * Engine Spec §3.4 documents a real defect: an earlier implementation
   * advanced the clock TWICE per local operation, because a combined
   * tick-and-merge routine called this same increment a second time when
   * the freshly-minted operation was applied locally. Convergence was
   * completely unaffected — identifiers stayed unique and totally ordered,
   * and all 60,000 fuzz seeds passed — but counters for sequential typing
   * ran 1,3,5,7,9 instead of 1,2,3,4,5. Consecutive counters are exactly
   * what RFC §7.5's block run-length encoding requires (Engine Spec
   * Definition 7.5, condition 2), so block compression on ordinary typing
   * silently collapsed from a measured 20,000x to 1.0x — the entire M8
   * memory-recovery strategy stopped working, with every correctness test
   * still green. Invariant I0 exists because of this exact failure, and it
   * is why mint() and observe() are separate methods below and must NEVER
   * be merged into one "tick-and-merge" routine, no matter how convenient
   * that looks at a call site.
   */
  mint(): Identifier {
    this.clock += 1;
    return { c: this.clock, r: this.replicaId };
  }

  /**
   * Merges a REMOTE Lamport counter into the clock WITHOUT minting.
   * Called when integrating any operation this replica did not originate,
   * so that a later local mint() cannot produce a counter the remote side
   * has already used. Deliberately separate from mint() — see its
   * docstring for why merging the two is the exact defect Invariant I0
   * guards against.
   */
  observe(remoteCounter: number): void {
    this.clock = Math.max(this.clock, remoteCounter);
  }

  /** Current clock value. Exposed for tests and diagnostics only — never for ordering decisions. */
  get currentClock(): number {
    return this.clock;
  }

  /** Visible sequence vis(S): non-tombstoned nodes, in structure order (Definition 2.3). */
  visible(): readonly Node[] {
    return this.nodes.filter((n) => !n.deleted);
  }

  /** Materialized document (Definition 2.4): concatenation of visible scalars, in order. */
  text(): string {
    return this.visible()
      .map((n) => String.fromCodePoint(n.value))
      .join("");
  }

  /** Structural metrics: total nodes, tombstone count, visible length. */
  stats(): EngineStats {
    let tombstones = 0;
    for (const n of this.nodes) {
      if (n.deleted) {
        tombstones += 1;
      }
    }
    return {
      totalElements: this.nodes.length,
      tombstones,
      visibleLength: this.nodes.length - tombstones,
    };
  }
}
