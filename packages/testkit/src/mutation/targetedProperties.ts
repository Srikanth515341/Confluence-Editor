import { mulberry32, randInt } from "../fuzz/prng.js";
import type { LoadedEngineModule } from "./loadMutantEngine.js";
import type { CheckResult } from "./targetedChecks.js";

/**
 * A reduced-case-count reimplementation of PROP-1 (commutativity) and
 * PROP-2 (idempotence) against the dynamically loaded engine module —
 * the real fast-check-based suites in packages/testkit/src/property/
 * import `@collab-editor/engine` statically, which can never be a
 * mutated build. Run at a few hundred cases rather than 10,000: for
 * mutation testing the question is "does this suite catch the mutant at
 * all," not "how thoroughly" — a real counterexample to commutativity or
 * idempotence shows up within a handful of random trials if it exists.
 */

function cp(ch: string): number {
  return ch.codePointAt(0) as number;
}

export function runTargetedProperties(
  mod: LoadedEngineModule,
  seed: number,
  trials: number,
): CheckResult[] {
  const results: CheckResult[] = [];
  const { Engine } = mod;
  const rand = mulberry32(seed);

  // PROP-1: commutativity of a concurrent insert pair.
  {
    let failure: string | undefined;
    for (let t = 0; t < trials && !failure; t++) {
      try {
        const baseLen = randInt(rand, 1, 6);
        const seedEngine = new Engine(100);
        for (let i = 0; i < baseLen; i++) {
          seedEngine.localInsert(seedEngine.text().length, 0x61 + randInt(rand, 0, 25));
        }
        const seedOps = seedEngine.nodes.map((n) => ({
          kind: "insert",
          id: n.id,
          value: n.value,
          originLeft: n.originLeft,
          originRight: n.originRight,
          bind: n.bind,
        }));

        const a = new Engine(1);
        const b = new Engine(2);
        for (const op of seedOps) {
          a.applyRemote(op);
          b.applyRemote(op);
        }
        const pos = randInt(rand, 0, baseLen);
        const opA = a.localInsert(pos, cp("a"));
        const opB = b.localInsert(pos, cp("b"));

        const forward = new Engine(10);
        const reverse = new Engine(11);
        for (const op of seedOps) {
          forward.applyRemote(op);
          reverse.applyRemote(op);
        }
        forward.applyRemote(opA);
        forward.applyRemote(opB);
        reverse.applyRemote(opB);
        reverse.applyRemote(opA);

        if (
          forward.text() !== reverse.text() ||
          forward.stats().totalElements !== reverse.stats().totalElements
        ) {
          failure = `seed ${seed} trial ${t}: forward="${forward.text()}" reverse="${reverse.text()}"`;
        }
      } catch (err) {
        // A mutant can make integrate() itself throw (e.g. the Case C
        // canary firing under a rank-altering mutant like
        // M1_rank_by_counter, which redefines the very comparison the
        // canary uses) — that is itself a valid detection, not a reason
        // to crash the whole matrix run the way an uncaught exception
        // would.
        failure = `seed ${seed} trial ${t}: threw ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    results.push({
      name: `PROP-1 commutativity (${trials} trials)`,
      passed: failure === undefined,
      ...(failure !== undefined ? { detail: failure } : {}),
    });
  }

  // PROP-2: idempotence, checked on full structural state.
  {
    let failure: string | undefined;
    for (let t = 0; t < trials && !failure; t++) {
      try {
        const source = new Engine(1);
        const opCount = randInt(rand, 1, 10);
        const ops = [];
        for (let i = 0; i < opCount; i++) {
          const len = source.text().length;
          if (len === 0 || rand() < 0.7) {
            ops.push(
              source.localInsert(
                len === 0 ? 0 : randInt(rand, 0, len),
                0x61 + randInt(rand, 0, 25),
              ),
            );
          } else {
            ops.push(...source.localDelete(randInt(rand, 0, len - 1), 1));
          }
        }

        const once = new Engine(2);
        for (const op of ops) once.applyRemote(op);

        const twice = new Engine(3);
        for (const op of ops) {
          twice.applyRemote(op);
          twice.applyRemote(op);
        }

        if (
          once.text() !== twice.text() ||
          once.stats().totalElements !== twice.stats().totalElements
        ) {
          failure = `seed ${seed} trial ${t}: once="${once.text()}" twice="${twice.text()}"`;
        }
      } catch (err) {
        failure = `seed ${seed} trial ${t}: threw ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    results.push({
      name: `PROP-2 idempotence (${trials} trials)`,
      passed: failure === undefined,
      ...(failure !== undefined ? { detail: failure } : {}),
    });
  }

  return results;
}
