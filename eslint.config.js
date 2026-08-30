// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

/**
 * Engine purity (PRD NG-3, RFC §4.4, Engine Spec §5 I0/C9):
 * packages/engine must never touch the DOM, the network, storage, or a clock.
 * This is enforced here, not just by convention, so a violation fails CI
 * rather than surfacing as a convergence bug months later.
 */
const engineGlobalsBan = [
  {
    name: "document",
    message: "Engine purity (Engine Spec §5 I0/C9): no DOM access in packages/engine.",
  },
  { name: "window", message: "Engine purity: no DOM access in packages/engine." },
  { name: "localStorage", message: "Engine purity: no storage access in packages/engine." },
  { name: "sessionStorage", message: "Engine purity: no storage access in packages/engine." },
  { name: "fetch", message: "Engine purity: no network access in packages/engine." },
  { name: "WebSocket", message: "Engine purity: no network access in packages/engine." },
  { name: "XMLHttpRequest", message: "Engine purity: no network access in packages/engine." },
];

const engineSyntaxBan = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message:
      "Engine purity (Engine Spec I0): no wall-clock reads. Ordering derives from Lamport counters only.",
  },
  {
    selector: "CallExpression[callee.object.name='performance'][callee.property.name='now']",
    message:
      "Engine purity (Engine Spec I0): no wall-clock reads. Ordering derives from Lamport counters only.",
  },
  {
    selector: "NewExpression[callee.name='Date']",
    message:
      "Engine purity (Engine Spec I0): no wall-clock reads. Ordering derives from Lamport counters only.",
  },
  {
    selector: "CallExpression[callee.property.name='getTime']",
    message:
      "Engine purity (Engine Spec §10.8 C9): no wall-clock reads. Ordering derives from Lamport counters only.",
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.turbo/**",
      // Phase 11: esbuild-generated Playwright test bundle — not source, gitignored, never linted.
      "**/e2e/.bundle/**",
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  // --- Plain Node scripts (build tooling, not part of any package) ---
  {
    files: ["scripts/**/*.mjs", "*.config.{js,ts}", "*.config.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      // Bare `any` requires an inline justification comment (project rule, §0.1);
      // ESLint cannot verify the comment exists, so this stays "warn" and is
      // reviewed by hand rather than silently allowed.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  // --- Engine purity boundary (packages/engine only) ---
  {
    files: ["packages/engine/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": ["error", ...engineGlobalsBan],
      "no-restricted-syntax": ["error", ...engineSyntaxBan],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "fs", message: "Engine purity: no I/O in packages/engine." },
            { name: "node:fs", message: "Engine purity: no I/O in packages/engine." },
            { name: "http", message: "Engine purity: no network access in packages/engine." },
            { name: "node:http", message: "Engine purity: no network access in packages/engine." },
            { name: "ws", message: "Engine purity: no network access in packages/engine." },
            { name: "react", message: "Engine purity: no DOM/UI dependency in packages/engine." },
            {
              name: "react-dom",
              message: "Engine purity: no DOM/UI dependency in packages/engine.",
            },
          ],
        },
      ],
    },
  },
);
