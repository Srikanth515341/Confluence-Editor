// Phase 26 — Test Plan SEC-11g, verbatim: "1,000 samples each of unknown-email and
// wrong-password login — the timing distributions are statistically indistinguishable." Requires
// a real, migrated Postgres instance (docker compose up -d; pnpm db:migrate). Run via
// `pnpm test:db`. A LONG real test by design — 2,000 real Argon2id comparisons (~130ms each on
// this project's own measured hardware) is inherently ~4-5 real minutes; see this file's own
// `it(..., <timeout>)` for the explicit per-test override this requires.
//
// Calls `attemptLogin` DIRECTLY, not through a real HTTP request — see authService.ts's own
// header comment for why this is the correct, not merely convenient, thing to do: rate limiting
// is a genuinely separate concern from "does the credential-verification code path itself leak a
// timing signal," and going through the full HTTP/rate-limit layer for 2,000 rapid attempts
// would trip this project's own per-account/per-IP limiter almost immediately, contaminating the
// measurement with 429-vs-401 timing differences that have nothing to do with SEC-11g's own
// actual question.

import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { attemptLogin } from "../authService.js";
import { hashPassword } from "../passwordHash.js";
import { createPool, type DbPool } from "./pool.js";

let pool: DbPool;

beforeAll(() => {
  pool = createPool(loadConfig().databaseUrl);
});

afterAll(async () => {
  await pool.end();
});

interface Stats {
  readonly mean: number;
  readonly stdev: number;
  readonly p50: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}

function computeStats(samplesMs: readonly number[]): Stats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1);
  return {
    mean,
    stdev: Math.sqrt(variance),
    p50: sorted[Math.floor(n * 0.5)]!,
    p95: sorted[Math.floor(n * 0.95)]!,
    min: sorted[0]!,
    max: sorted[n - 1]!,
  };
}

/**
 * Welch's two-sample t-test (unequal variances) — the "via a t-test" half of SEC-11g's own
 * explicit alternative wording ("via a t-test or simply comparing p50/p95/mean"). At n=1,000 per
 * group, the Central Limit Theorem already makes the sampling distribution of each group's own
 * MEAN closely normal regardless of the underlying per-call timing distribution's own shape, so
 * comparing the resulting t-statistic against the STANDARD NORMAL distribution (rather than
 * computing the exact Student's-t degrees-of-freedom/p-value via the incomplete beta function)
 * is a legitimate, standard large-sample approximation — not a shortcut that weakens the result.
 */
function welchTStatistic(a: readonly number[], b: readonly number[]): number {
  const statsA = computeStats(a);
  const statsB = computeStats(b);
  const seA = statsA.stdev ** 2 / a.length;
  const seB = statsB.stdev ** 2 / b.length;
  return (statsA.mean - statsB.mean) / Math.sqrt(seA + seB);
}

const SAMPLE_COUNT = 1000;
// A generous, deliberately calibrated bound — NOT the naive "just use a 95%/99% significance
// cutoff on the t-statistic" approach. At n=1,000 per group, a t-test has enough statistical
// POWER to flag even a trivially small, practically meaningless timing difference (a few hundred
// MICROSECONDS) as "significant" — exactly the same "a literal textbook threshold doesn't survive
// contact with the real sampling distribution at this sample size" lesson this project's own
// RC-34 jitter-threshold investigation already learned (CLAUDE.md, Phase 23) applied here. The
// bug this test actually exists to catch — an early return that skips the ~130ms Argon2id
// comparison entirely for an unknown email — would produce a mean-timing gap on the order of the
// FULL hash cost itself (~130ms), not a few percent of it. |t| < 8 is comfortably far above the
// noise floor real timing jitter produces at this sample size (Welch's t staying near 0 for two
// genuinely identical-cost code paths) while remaining utterly incapable of passing for the
// actual bug class this test guards against, which would drive |t| into the hundreds given
// Argon2id's own measured ~1-5ms run-to-run stdev against a ~130ms mean gap.
const T_STATISTIC_BOUND = 8;
// A second, independent, unit-denominated check (SEC-11g's own explicit "simply comparing
// p50/p95/mean" alternative) — the two means must be within a small ABSOLUTE number of
// milliseconds of each other, regardless of what the t-test says. 20ms is small relative to the
// ~130ms Argon2id cost this project measured (Phase 26 investigation, same hardware this test
// itself runs on) but generous relative to ordinary OS-scheduling/GC-pause jitter across 1,000
// real database round trips plus 1,000 real Argon2id calls per group.
const MEAN_DIFFERENCE_BOUND_MS = 20;

describe("Phase 26 — Test Plan SEC-11g: login timing is indistinguishable between an unknown email and a wrong password", () => {
  it(
    "1,000 samples each, real Argon2id, real Postgres lookups — statistically indistinguishable timing",
    async () => {
      const email = `sec11g-${randomUUID()}@example.com`;
      await pool.query(
        `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
        [randomUUID(), email, "SEC-11g Test User", await hashPassword("the-real-password")],
      );

      // Warm up the JIT/allocator/connection pool with a few throwaway calls first — matches
      // this project's own established benchmark discipline (finalMemoryLatency.bench.test.ts's
      // own warm-up call) so the FIRST few real samples of each group aren't skewed by one-time
      // costs (module JIT compilation, the pool's first real connection) that have nothing to do
      // with the property under test.
      for (let i = 0; i < 5; i++) {
        await attemptLogin(pool, `warmup-${randomUUID()}@example.com`, "warmup");
        await attemptLogin(pool, email, "warmup-wrong-password");
      }

      const unknownEmailSamplesMs: number[] = [];
      const wrongPasswordSamplesMs: number[] = [];
      // Interleaved (one of each per loop iteration), not "all 1,000 unknown-email calls, then
      // all 1,000 wrong-password calls" — this spreads any slow real-world drift (a Postgres
      // autovacuum tick, a GC pause, OS scheduler noise) evenly across BOTH groups instead of
      // letting it land disproportionately in whichever group happens to run second, which would
      // itself manufacture a spurious timing difference unrelated to the actual code path.
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const startUnknown = performance.now();
        const unknownResult = await attemptLogin(pool, `no-such-user-${randomUUID()}@example.com`, "any-password");
        unknownEmailSamplesMs.push(performance.now() - startUnknown);
        expect(unknownResult).toBeNull();

        const startWrong = performance.now();
        const wrongResult = await attemptLogin(pool, email, "the-wrong-password");
        wrongPasswordSamplesMs.push(performance.now() - startWrong);
        expect(wrongResult).toBeNull();
      }

      const unknownStats = computeStats(unknownEmailSamplesMs);
      const wrongStats = computeStats(wrongPasswordSamplesMs);
      const t = welchTStatistic(unknownEmailSamplesMs, wrongPasswordSamplesMs);
      const meanDiffMs = Math.abs(unknownStats.mean - wrongStats.mean);

      // DoD's own explicit requirement: "give me the real numbers" (this project's established
      // convention since Phase 17) — printed regardless of pass/fail.
      console.log(
        `[SEC-11g] unknown-email (n=${SAMPLE_COUNT}): mean=${unknownStats.mean.toFixed(3)}ms ` +
          `stdev=${unknownStats.stdev.toFixed(3)}ms p50=${unknownStats.p50.toFixed(3)}ms ` +
          `p95=${unknownStats.p95.toFixed(3)}ms min=${unknownStats.min.toFixed(3)}ms max=${unknownStats.max.toFixed(3)}ms`,
      );
      console.log(
        `[SEC-11g] wrong-password (n=${SAMPLE_COUNT}): mean=${wrongStats.mean.toFixed(3)}ms ` +
          `stdev=${wrongStats.stdev.toFixed(3)}ms p50=${wrongStats.p50.toFixed(3)}ms ` +
          `p95=${wrongStats.p95.toFixed(3)}ms min=${wrongStats.min.toFixed(3)}ms max=${wrongStats.max.toFixed(3)}ms`,
      );
      console.log(
        `[SEC-11g] Welch's t-statistic = ${t.toFixed(4)} (bound: |t| < ${T_STATISTIC_BOUND}); ` +
          `mean difference = ${meanDiffMs.toFixed(3)}ms (bound: < ${MEAN_DIFFERENCE_BOUND_MS}ms)`,
      );

      expect(Math.abs(t)).toBeLessThan(T_STATISTIC_BOUND);
      expect(meanDiffMs).toBeLessThan(MEAN_DIFFERENCE_BOUND_MS);
    },
    600_000,
  );
});
