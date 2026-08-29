import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type { MutantDefinition } from "./mutants.js";

/**
 * Loads a fresh, isolated copy of the engine — either the unmutated
 * baseline (`mutant: null`) or with exactly one mutant patch applied —
 * as a genuinely separate module instance. This is why the harness
 * string-patches and re-transpiles into a scratch directory rather than
 * mutating and reloading packages/engine/src directly: the REAL source
 * on disk must never be touched, and Node's ESM loader caches modules by
 * URL, so a fresh temp path per load is what makes ten sequential mutant
 * loads in one process actually observe ten different implementations
 * instead of the first one cached forever.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const engineSrcDir = join(here, "..", "..", "..", "engine", "src");

// Only these are ever needed by a mutant run: invariants.ts is included
// unmutated so assertInvariants() still runs against whatever Engine
// instance the mutant produces (its import of Engine is type-only, so it
// carries no runtime coupling to which Engine class is actually loaded).
const SOURCE_FILES = [
  "identifier.ts",
  "node.ts",
  "operation.ts",
  "grapheme.ts",
  "engine.ts",
  "invariants.ts",
];

function transpile(tsSource: string): string {
  const { outputText, diagnostics } = ts.transpileModule(tsSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      importHelpers: false,
    },
    reportDiagnostics: true,
  });
  if (diagnostics && diagnostics.length > 0) {
    const messages = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    throw new Error(`mutant engine transpile diagnostics: ${messages.join("; ")}`);
  }
  return outputText;
}

let loadCounter = 0;

export interface EngineNodeLike {
  readonly id: { readonly c: number; readonly r: number };
  readonly value: number;
  readonly originLeft: { readonly c: number; readonly r: number } | null;
  readonly originRight: { readonly c: number; readonly r: number } | null;
  readonly bind: boolean;
  deleted: boolean;
  deletedBy: { readonly c: number; readonly r: number } | null;
}

export interface EngineLike {
  readonly replicaId: number;
  readonly nodes: EngineNodeLike[];
  readonly pending: unknown[];
  readonly currentClock: number;
  mint(): { readonly c: number; readonly r: number };
  observe(remoteCounter: number): void;
  visible(): readonly EngineNodeLike[];
  text(): string;
  stats(): {
    readonly totalElements: number;
    readonly tombstones: number;
    readonly visibleLength: number;
  };
  localInsert(visibleIndex: number, value: number, bind?: boolean): unknown;
  localDelete(visibleIndex: number, count: number): readonly unknown[];
  applyRemote(op: unknown): { readonly buffered: boolean };
}

export interface LoadedEngineModule {
  readonly Engine: new (replicaId: number) => EngineLike;
  readonly assertInvariants: (
    engine: EngineLike,
    options?: { readonly quiescent?: boolean },
  ) => void;
  readonly InvariantViolation: new (message?: string) => Error;
  readonly dispose: () => void;
}

/**
 * Loads the engine with `mutant` applied, or the unmutated baseline if
 * `mutant` is null. Throws if the mutant's `find` text does not appear
 * EXACTLY once in its target file — a mutant that silently fails to
 * apply (because the source moved on) would be worse than no mutant at
 * all: it would report "killed" or "survived" for code that was never
 * actually mutated.
 */
export async function loadEngine(mutant: MutantDefinition | null): Promise<LoadedEngineModule> {
  loadCounter += 1;
  const dir = mkdtempSync(join(tmpdir(), "obseq-mutant-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");

  for (const fileName of SOURCE_FILES) {
    let source = readFileSync(join(engineSrcDir, fileName), "utf8");
    if (mutant && mutant.file === fileName) {
      const occurrences = source.split(mutant.find).length - 1;
      if (occurrences !== 1) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(
          `mutant ${mutant.id}: expected exactly 1 occurrence of its find-text in ${fileName}, found ` +
            `${occurrences}. The harness fails loudly rather than silently applying a no-op mutation.`,
        );
      }
      source = source.replace(mutant.find, mutant.replace);
    }
    const jsFileName = fileName.replace(/\.ts$/, ".js");
    writeFileSync(join(dir, jsFileName), transpile(source), "utf8");
  }

  const engineUrl = pathToFileURL(join(dir, "engine.js"));
  engineUrl.search = `v=${loadCounter}`;
  const invariantsUrl = pathToFileURL(join(dir, "invariants.js"));
  invariantsUrl.search = `v=${loadCounter}`;

  const [engineModule, invariantsModule] = await Promise.all([
    import(engineUrl.href) as Promise<{ Engine: LoadedEngineModule["Engine"] }>,
    import(invariantsUrl.href) as Promise<{
      assertInvariants: LoadedEngineModule["assertInvariants"];
      InvariantViolation: LoadedEngineModule["InvariantViolation"];
    }>,
  ]);

  return {
    Engine: engineModule.Engine,
    assertInvariants: invariantsModule.assertInvariants,
    InvariantViolation: invariantsModule.InvariantViolation,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
