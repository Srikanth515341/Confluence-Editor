#!/usr/bin/env node
// Independent grep-based check for engine purity, deliberately separate from
// the ESLint rule (eslint.config.js) rather than relying on it alone.
// Two independent checks that must both pass is the same principle applied
// throughout the design docs (e.g. API Spec §9.1's three duplicate-protection
// layers): a single check can be silently disabled or misconfigured without
// anyone noticing, but two independent ones passing at once is real evidence.
//
// Source: PRD NG-3, RFC §4.4, Engine Spec §5 (I0, C9).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const engineSrc = join(__dirname, "..", "packages", "engine", "src");

/** @type {{pattern: RegExp, reason: string}[]} */
const FORBIDDEN = [
  { pattern: /\bDate\.now\s*\(/, reason: "wall-clock read (Date.now) — Engine Spec I0" },
  { pattern: /\bnew Date\s*\(/, reason: "wall-clock read (new Date) — Engine Spec I0" },
  {
    pattern: /\bperformance\.now\s*\(/,
    reason: "wall-clock read (performance.now) — Engine Spec I0",
  },
  {
    pattern: /\.getTime\s*\(/,
    reason: "wall-clock read (getTime) — Engine Spec §10.8 C9",
  },
  { pattern: /\bdocument\s*\./, reason: "DOM access (document) — PRD NG-3 / FR-CE-14" },
  { pattern: /\bwindow\s*\./, reason: "DOM/browser global access (window) — PRD NG-3" },
  { pattern: /\bfetch\s*\(/, reason: "network access (fetch) — Engine Spec §5 purity" },
  { pattern: /\bnew WebSocket\s*\(/, reason: "network access (WebSocket) — Engine Spec §5 purity" },
  { pattern: /from\s+["']node:?fs["']/, reason: "filesystem I/O import — Engine Spec §5 purity" },
  { pattern: /from\s+["']node:?http["']/, reason: "network I/O import — Engine Spec §5 purity" },
  {
    pattern: /from\s+["']react(-dom)?["']/,
    reason: "UI framework import — engine must have no DOM dependency",
  },
];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  let files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      files = files.concat(walk(full));
    } else if ([".ts", ".tsx"].includes(extname(full))) {
      // Test files are scanned too, deliberately: this check exists to be an
      // independent second enforcement of the same boundary ESLint enforces
      // (which also covers *.test.ts), not a narrower one. See eslint.config.js.
      files.push(full);
    }
  }
  return files;
}

function main() {
  let files;
  try {
    files = walk(engineSrc);
  } catch (err) {
    console.error(`check-engine-purity: could not read ${engineSrc}: ${err.message}`);
    process.exit(1);
  }

  /** @type {{file: string, line: number, reason: string, text: string}[]} */
  const violations = [];

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, idx) => {
      for (const { pattern, reason } of FORBIDDEN) {
        if (pattern.test(text)) {
          violations.push({ file, line: idx + 1, reason, text: text.trim() });
        }
      }
    });
  }

  if (violations.length > 0) {
    console.error("Engine purity violation(s) found in packages/engine/src:\n");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    ${v.text}`);
      console.error(`    -> ${v.reason}\n`);
    }
    console.error(`${violations.length} violation(s). See PRD NG-3, RFC §4.4, Engine Spec §5.`);
    process.exit(1);
  }

  console.log(`check-engine-purity: OK (${files.length} file(s) scanned, 0 violations).`);
}

main();
