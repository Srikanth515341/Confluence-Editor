// Phase 23 — Monte Carlo simulation backing RC-34's recalibrated jitter
// threshold (packages/client/src/sync/reconnection.test.ts, "RC-34 —
// reconnection storm"). Run directly:
//
//   node packages/client/scripts/rc34JitterSimulation.mjs
//
// WHY THIS EXISTS: Test Plan §5.1's own literal wording for RC-34 ("no
// more than 15% of clients attempt within any 500ms window") is not
// statistically achievable at n=32 samples measured via a sliding-window
// MAXIMUM (an order statistic, not a density) — checked directly, that
// naive `32 * 0.15 ≈ 5` bound sits BELOW the average outcome of
// genuinely correct, independent full-jitter reconnection. This script
// is the actual derivation, not a number cited from memory: it is
// reproducible (fixed PRNG seed, no external dependencies), and prints
// both the "correct code" distribution the chosen threshold (16, i.e.
// 50% of the fleet) was picked from, and three specific broken-jitter
// scenarios exercising what that threshold does and does not catch —
// see the "Broken scenario" section below and the disclosed limitation
// recorded in reconnection.test.ts's own comment next to the assertion.
//
// Geometry matches the real test exactly: 32 clients, a 500ms
// measurement window, and a 16000ms delay range — RC-34's own test
// forces this range by running 5 rapid warm-up crash/reconnect cycles
// before the measured one, so backoff.ts's `nextDelayMs()` computes
// `base = min(cap, 500 * 2^5) = 16000` for every client's OWN jitter
// range at the moment being measured (see that test's own comment for
// the full reasoning on why the very first attempt's range, exactly as
// wide as the window itself, would make ANY threshold meaningless).

function maxInWindow(points, windowMs) {
  const sorted = [...points].sort((a, b) => a - b);
  let max = 0;
  for (const t of sorted) {
    const count = sorted.filter((other) => Math.abs(other - t) <= windowMs).length;
    if (count > max) max = count;
  }
  return max;
}

// Deterministic PRNG (mulberry32) — same family this project's own fuzz
// harness uses (packages/testkit/src/fuzz/prng.ts) — so this simulation
// is byte-reproducible across runs/machines, not dependent on Math.random().
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N_TRIALS = 20_000;
const N_CLIENTS = 32;
const RANGE_MS = 16_000;
const WINDOW_MS = 500;
const SEED = 12345;

function runCorrectDistribution() {
  const rand = mulberry32(SEED);
  const results = [];
  for (let trial = 0; trial < N_TRIALS; trial++) {
    const points = [];
    for (let i = 0; i < N_CLIENTS; i++) points.push(rand() * RANGE_MS);
    results.push(maxInWindow(points, WINDOW_MS));
  }
  results.sort((a, b) => a - b);
  return results;
}

function summarize(results) {
  const mean = results.reduce((s, x) => s + x, 0) / results.length;
  const pct = (p) => results[Math.floor(p * results.length)];
  const dist = {};
  for (const r of results) dist[r] = (dist[r] ?? 0) + 1;
  return { mean, p50: pct(0.5), p95: pct(0.95), p999: pct(0.999), max: results.at(-1), dist };
}

const results = runCorrectDistribution();
const summary = summarize(results);

console.log("=== RC-34 jitter threshold — Monte Carlo simulation (correct, uniform full-jitter code) ===");
console.log(
  `trials=${N_TRIALS} clients=${N_CLIENTS} range=${RANGE_MS}ms window=${WINDOW_MS}ms seed=${SEED}`,
);
console.log(
  `mean=${summary.mean.toFixed(3)} p50=${summary.p50} p95=${summary.p95} p99.9=${summary.p999} max=${summary.max}`,
);
console.log("distribution (maxInWindow value: count, percent of trials):");
for (const k of Object.keys(summary.dist)
  .map(Number)
  .sort((a, b) => a - b)) {
  console.log(`  ${k}: ${summary.dist[k]} (${((100 * summary.dist[k]) / N_TRIALS).toFixed(2)}%)`);
}

const NAIVE_BOUND = Math.ceil(N_CLIENTS * 0.15); // Test Plan §5.1's literal "15% of 32" reading
const naiveFailRate = results.filter((r) => r > NAIVE_BOUND).length / N_TRIALS;
console.log(
  `\nnaive literal bound (15% of ${N_CLIENTS} = ${NAIVE_BOUND}): ${(100 * naiveFailRate).toFixed(1)}% of CORRECT trials would fail this check — not usable at this sample size.`,
);

const CHOSEN_THRESHOLD = 16; // what reconnection.test.ts actually asserts: maxInWindow <= 16
const chosenFailRate = results.filter((r) => r > CHOSEN_THRESHOLD).length / N_TRIALS;
console.log(
  `chosen threshold (${CHOSEN_THRESHOLD}, 50% of the fleet): ${(100 * chosenFailRate).toFixed(3)}% of CORRECT trials fail — the actual false-positive rate reconnection.test.ts ships with.`,
);

// --- Broken-jitter scenarios: what the chosen threshold DOES and does NOT catch. ---
// This is the basis for the disclosed limitation recorded next to RC-34's assertion:
// the recalibrated threshold reliably catches the failure modes RC-34's own intent is
// aimed at (a reconnect stampede from disabled/correlated jitter), but is NOT a
// general-purpose jitter-correctness detector — see scenario 3.
function runScenario(name, seed, buildPoints, trials = 1000) {
  const rand = mulberry32(seed);
  let caught = 0;
  for (let trial = 0; trial < trials; trial++) {
    const points = buildPoints(rand);
    if (maxInWindow(points, WINDOW_MS) > CHOSEN_THRESHOLD) caught++;
  }
  console.log(
    `\n${name}: ${caught}/${trials} trials caught (maxInWindow > ${CHOSEN_THRESHOLD}) — ${((100 * caught) / trials).toFixed(1)}%`,
  );
}

console.log("\n=== Broken-jitter scenarios (does the chosen threshold catch them?) ===");

runScenario("Scenario 1 — jitter disabled entirely (all 32 clients fire at the identical instant)", 1, () =>
  new Array(N_CLIENTS).fill(RANGE_MS / 2),
);

runScenario(
  "Scenario 2 — correlated/narrow jitter (all 32 delays clustered into a 200ms sub-range instead of the full 16000ms range)",
  2,
  (rand) => {
    const points = [];
    for (let i = 0; i < N_CLIENTS; i++) points.push(RANGE_MS / 2 + rand() * 200);
    return points;
  },
);

runScenario(
  "Scenario 3 — half-range-shifted jitter (delay = base/2 + random*base/2 — still spans nearly the full range, just biased toward the high half; a subtler bug that PRESERVES spread)",
  3,
  (rand) => {
    const points = [];
    for (let i = 0; i < N_CLIENTS; i++) points.push(RANGE_MS / 2 + rand() * (RANGE_MS / 2));
    return points;
  },
);

console.log(
  "\nScenario 3 is the disclosed limitation: it is NOT reliably caught by this threshold (spread is preserved,\n" +
    "so no 500ms window accumulates enough points to trip a bound this loose) — recorded explicitly in\n" +
    "reconnection.test.ts's own comment rather than left implicit.",
);
