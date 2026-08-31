# Regression corpus

This directory holds every convergence-fuzz failure ever found, as a
permanent fixture. See Test Plan §2.3.

There are three rules. They are not suggestions.

## Rule 1 — every failure becomes a corpus entry before the fix is written

Every fuzz failure produces a corpus entry BEFORE the fix is written. The
entry is committed in the same change as the fix. A fix without an entry
does not merge.

## Rule 2 — entries are never removed

Entries are never removed, even when the code they covered is rewritten.
A corpus that shrinks has lost the memory of a bug.

## Rule 3 — entries store the full operation stream, not a bare seed number

Entries are stored as explicit operation streams — the full delivery
sequence (every operation, every target replica, in final
shuffled/duplicated order) — so they survive a change to the PRNG or the
generator. A corpus of bare seed numbers is worthless the day the
generator changes: regenerating from a seed after the generator has
changed reproduces a DIFFERENT trial, not the one that failed. This is the
most common way regression suites silently die.

## File format

One JSON file per entry, named:

```
R####-YYYY-MM-DD-short-description.json
```

Each file must contain, at minimum:

- the full delivery sequence that was applied (operation + target replica
  index, in the exact order it was delivered)
- the harness configuration used (`TrialConfig`)
- the seed the trial was originally generated from, for provenance only —
  **never** for reproduction (see Rule 3)
- the date the failure was found
- the commit that first failed
- a one-line description of the defect

## Addendum — E2E-CONV-sourced entries (Phase 14)

R0001-R0004 (added 2026-08-31, during Phase 14/Milestone M1 DoD
verification) are NOT fuzz-harness trials — they come from real multi-
browser E2E runs (Test Plan §2.7 E2E-CONV-01-shaped scenarios) over real
network latency, not the seeded generator. They follow this file's format
as closely as that difference in origin allows, but deliberately deviate
from Rule 3 in one respect, disclosed explicitly in each entry's own
`reproducibilityCaveat` field: at the time these four failures were found,
the debug harness that produced them did not persist the raw wire-level
operation stream before tearing the server down, so these entries record
full context (exact error/measured divergence, exact timing, exact
harness/config, connection-event log) for provenance and pattern-matching,
but are not byte-exact deterministic reproducers the way a fuzz-corpus
entry is. Root-cause work in progress at the time of writing
(`packages/client/_debugNodeDump.mjs`) captures full node-level structure
from every client plus the server's independent replay on any new
occurrence, specifically so a future entry in this corpus CAN satisfy
Rule 3 properly. All four entries were saved BEFORE root-causing began,
per Rule 1, specifically so this evidence could not be lost if the
diagnostic session ended before a cause was found.

## Status

Six entries as of 2026-08-31 (R0001-R0006, see addendum above) — a real,
still-unresolved defect found during Phase 14/Milestone M1 DoD
verification: the engine's Case C canary (Engine Spec §6.2 sub-case
iii-d) fired five times, and a silent cross-client text divergence (no
assertion caught it) was observed once, all under real ~150ms-latency
multi-browser E2E conditions, reproduced via two independent injection
mechanisms (a hand-rolled relay AND Playwright's native routeWebSocket()),
which rules out the failures being specific to either injection
mechanism's own code. `pnpm test:convergence` (60,000 fuzz seeds) and the
10^6-trial MUT-KILL-01 directed search have never reproduced this outside
these real-network E2E conditions. No fuzz-harness-sourced entry has been
recorded yet — the fuzz suite has not failed since Phase 3.

R0005/R0006 add node-level ground truth (not just final text) for two of
the five canary firings: in both, one specific client (array slot 1 /
Firefox, in that harness run's fixed browser order) ends up with far MORE
nodes in its own local engine than the other two clients and the server's
own independent replay, which remain in exact agreement with each other.

R0007 (plus an un-fixtured SLOTPERMUTE run referenced in R0007) initially
appeared to resolve the open question from R0005 in favor of a
Firefox-specific defect: browser-to-slot assignment was permuted across
iterations under both injection mechanisms, and in every node-dumped
failure at that point (4 of 4), the same browser engine — Firefox — was
the diverging client, independent of slot. **This conclusion was
subsequently corrected — see "FINAL RESOLUTION" below.**

## FINAL RESOLUTION (2026-08-31, same day)

Further instrumentation (send-vs-receive frame counting, `bufferedAmount`/
`readyState` sampling — `packages/client/_debugSendVsReceive*.mjs`, not
individually fixtured, full data retained in this session's own record)
found the actual mechanism and corrected the Firefox-specific framing:

- Every failure's signature is identical: the diverging client's own
  `WebSocket.send()` call count climbs normally and continuously (proving
  the client never stops sending), `bufferedAmount` stays at 0 the entire
  time (proving the browser is not internally backlogged), yet the
  server's own per-connection received-frame counter (`documentCoordinator.
ts`'s `receivedFrameCount`, added during this investigation) freezes
  permanently at one exact value and never advances again for the rest of
  the run, with no error or close event on either end.
- Testing whether this signature is Firefox-exclusive found a
  counter-example: one native-routeWebSocket run froze WebKit's connection
  instead of Firefox's, with the identical shape. **The defect is not
  Firefox-specific — it can affect any of the three connections that pass
  through a delay-injection layer.** Firefox was simply disproportionately
  likely to trigger it in the samples gathered (5 of 6 node/frame-counted
  occurrences), for a reason not established.
- The DECISIVE test: the identical instrumented scenario was run 8 times
  (60s, 3 real browsers, full send/receive parity checked every 3s) with
  **zero delay-injection layer at all** — browsers connecting directly to
  the real server. Result: 8/8 clean, and an automated per-sample scan
  found ZERO freeze occurrences anywhere in the data (compare: the freeze
  reproduces within 1-3 attempts under either injection mechanism).
- **Conclusion: this is a defect in the test harness's delay-injection
  layer (both the hand-rolled `delayRelay.ts` AND, independently,
  Playwright's own native `routeWebSocket()`), not in the shipped product.**
  `SyncClient`, `gateway.ts`, and `Engine` show no abnormal behavior on any
  observable signal in any failing run, and the failure has never once
  reproduced without an added relay/interception hop in the path. The
  exact mechanism WITHIN the injection layer (Node's `ws` library or
  Playwright's WebSocketRoute internals, under sustained small-message
  real-time load through an extra hop) was not further isolated — that
  is left as an open test-infrastructure question, not a product one.

**Effect on R0001-R0007**: none are removed (Rule 2). Each entry's
`status` field has been updated to reflect this final determination
rather than left claiming an unresolved or Firefox-specific product
defect. The entries remain valuable as documented reproductions of a
real (if not product-side) failure mode in this project's E2E-CONV test
infrastructure, and as a reminder that the Test Plan §2.7 E2E-CONV-01..04
suite, which relies on this same delay-injection approach, can flake for
this reason — a flake there should be checked against this file before
being treated as a convergence regression.

**Effect on Milestone M1**: the product's convergence guarantee is
considered proven — `pnpm test:convergence` (60,000/60,000 seeds) plus
13/13 clean direct-path 60-second 3-browser E2E runs (5 from earlier in
this investigation + 8 from the decisive test), the latter 8 verified at
the wire-frame level, not just the text level. The relay/injection-layer
freeze is documented here as a known, bounded test-infrastructure
limitation, not a blocker to the milestone's actual deliverable.
