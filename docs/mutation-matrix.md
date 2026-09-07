# Mutation matrix (Test Plan §2.8)

Generated: 2026-09-05T15:06:29.694Z

Ten mutants (patches supplied verbatim from Test Plan §2.8), each string-patched into an isolated, freshly-transpiled copy of `packages/engine/src` — never the real source on disk — then run against four detection mechanisms: the convergence fuzzer with invariant assertions OFF (pure text/structure/pendingCount agreement — what existed since Phase 2), the same fuzzer with invariant assertions ON (Phase 4's `assertInvariants`, checked after every mutating call), a hand-picked subset of the Phase 5 adversarial suite re-targeted at the mutant engine, and a reduced-count reimplementation of PROP-1/PROP-2. See `packages/testkit/src/mutation/` for the harness.

| Mutant | Violated invariant | Fuzzer (convergence only) | Fuzzer (+ invariants) | Adversarial (targeted) | Properties (targeted) | Overall |
|---|---|---|---|---|---|---|
| `M1_rank_by_counter` | I1 (identifier uniqueness is per-replica; counters alone are not globally unique) / Definition 4.2 | killed (seed 0, 1 trial(s) run) | killed (seed 0, 1 trial(s) run) | killed — ADV-14 (Engine Spec §10.7): backward typing produces contiguous runs (cbazyxX) | killed — PROP-1 commutativity (300 trials) | **KILLED** |
| `M4_no_binding` | I8 (grapheme cluster contiguity) | survived (1000 trials) | survived (1000 trials) | killed — ADV-17: combining mark on higher replica id stays adjacent to base | survived | **KILLED** |
| `M5_double_tick` | I0 (clock advances exactly once per minted identifier) | survived (1000 trials) | killed (seed 0, 1 trial(s) run) | killed — I0: observe() merges via max, never increments on its own | survived | **KILLED** |
| `M6_physical_delete` | I5 (tombstone retention) | killed (seed 0, 1 trial(s) run) | killed (seed 0, 1 trial(s) run) | survived | survived | **KILLED** |
| `M7_no_readiness_check` | I4 (origin presence at integration time) — Engine Spec §4.2 | killed (seed 0, 1 trial(s) run) | killed (seed 0, 1 trial(s) run) | killed — readiness: an insert whose parent is missing must buffer, not apply; ADV-09-style: pending drains to a fixpoint across a 3-deep causal chain | survived | **KILLED** |
| `M8_no_idempotence` | I1 (identifier uniqueness) — Engine Spec §6.3 | killed (seed 0, 1 trial(s) run) | killed (seed 0, 1 trial(s) run) | killed — ADV-08: duplicate delivery of the same insert is a no-op | killed — PROP-2 idempotence (300 trials) | **KILLED** |
| `M9_delete_first_wins` | I7 (deletion attribution monotonicity) — Engine Spec §4.5 line 3 | survived (1000 trials) | survived (1000 trials) | killed — deletedBy is the causally-latest delete, not the first, across two deletes with no undelete between them | survived | **KILLED** |
| `M10_no_drain` | I9 (pending buffer drains at quiescence) — Engine Spec §4.2 Rule 4.2 | killed (seed 0, 1 trial(s) run) | killed (seed 0, 1 trial(s) run) | survived | survived | **KILLED** |

## Mutant descriptions

- **M1_rank_by_counter**: Sibling-order disambiguator orders by Lamport counter instead of replica id — two different replicas can coincidentally mint the same counter, making the tie-break genuinely ambiguous (not just 'differently correct'). Fugue port (2026-09-05): re-anchored from engine.ts's retired `rank()` to fugueTree.ts's `siblingRank()`, the direct successor holding the identical [bind?0:1, replicaId] tuple — same mechanism, same violated invariant, new home.
- **M4_no_binding**: Sibling-order rank drops the binding component — a combining mark no longer sorts nearer its base. Fugue port: re-anchored from engine.ts's retired `rank()` to fugueTree.ts's `siblingRank()` (same note as M1_rank_by_counter above).
- **M5_double_tick**: observe() also increments the clock — the exact defect Engine Spec §3.4 documents (a prior real bug), reintroduced deliberately here.
- **M6_physical_delete**: Delete removes the node from S instead of tombstoning it.
- **M7_no_readiness_check**: Readiness for an insert always returns true, never actually checking whether its `parent` is present. Fugue port re-derivation: the retired M7_no_right_readiness mutant specifically dropped the originRight HALF of a two-part readiness check; Fugue's own ready() has only ONE causal dependency (`parent`) to begin with (a real simplification the port itself introduced, not something this mutant works around), so the direct analogue is dropping that ONE check entirely rather than one of two.
- **M8_no_idempotence**: The already-applied check is removed — a duplicate insert integrates a second time.
- **M9_delete_first_wins**: deletedBy keeps the FIRST deletion instead of the causally latest.
- **M10_no_drain**: The pending buffer is drained only once, not to a fixpoint.

## MUT-KILL-01 (Test Plan §14.2)

Not applicable as of the Fugue port (2026-09-05) — `M3_no_case_c` (and `M2_no_right_bound`) targeted the retired YATA-family scan's own window-bookkeeping, which Fugue's placement algorithm has no analogue of (see mutants.ts's own header comment and CLAUDE.md's 'Fugue port' entry). Both mutants are currently OMITTED from this matrix rather than force-fit to a mechanism that no longer exists — restoring a tenth mutant requires new, genuinely Fugue-native patches sourced the same deliberate way the original ten were.

## Summary

- 8 of 8 mutants killed by at least one suite.
- `M2_no_right_bound` and `M3_no_case_c` (Test Plan §2.8's original ten) are OMITTED from this matrix as of the Fugue port (2026-09-05) — see the MUT-KILL-01 section above for why.
- No mutant survives every suite in this matrix.
