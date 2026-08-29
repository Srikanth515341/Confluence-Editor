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

## Status

Empty as of Phase 2. No fuzz failure has been recorded yet, because
`integrate()` does not exist yet (Phase 3) — the convergence suite
(`pnpm test:convergence`) is currently failing for that reason, which is
expected and does not itself produce a corpus entry. The first entries
land once real trials run against the real engine and something breaks.
