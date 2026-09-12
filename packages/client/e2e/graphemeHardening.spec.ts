import { expect, test, type Page } from "@playwright/test";
import { INPUT_HARNESS_BUNDLE_PATH } from "./helpers.js";
// inputHarnessGlobal.d.ts is an ambient declaration file — picked up automatically via
// e2e/tsconfig.json's "include", no import needed.

/**
 * Phase 35 — grapheme cluster hardening at the real-browser level (Test Plan §7.4, GRA-01/GRA-02),
 * against real Chromium, Firefox, AND WebKit. GRA-03 (the classifier's own direct unit tests) and
 * the engine-level companions to GRA-01 (regional indicator / Devanagari matra / variation
 * selector, both replica-id orderings) live at the engine level instead
 * (`packages/engine/src/grapheme.test.ts`, `packages/testkit/src/adversarial/adversarial.test.ts`)
 * — see those files' own header comments. This file is what brings GRA-01's already-engine-proven
 * property ("bind is checked BEFORE replica id, so a concurrent plain character never splits a
 * cluster") up through the WHOLE real pipeline: real `beforeinput` dispatch -> inputPipeline.ts ->
 * SyncClient.localInsertText -> Engine.localInsert (bind auto-computed via isClusterContinuing) ->
 * real DomWriter render — for TWO independent, real DOM editors on one page, standing in for two
 * real peers (the same "two simulated clients, no real network" technique
 * `compositionController.test.ts`/`e2e/ime.spec.ts` already established, doubled to real DOM on
 * both sides here since GRA-01's own DoD requires "ASSERT both DOMs render byte-identically").
 *
 * MUT-04 (Safari-specific behaviours) and MUT-01's autocorrect-hardening row live in
 * `inputPipeline.spec.ts` (the autocorrect row, alongside its own pre-existing tests) and this
 * file's own final section (the two genuinely WebKit-automatable MUT-04 sub-cases) — see this
 * phase's end-of-phase report for the full manual/automated split.
 */

interface OneHarness {
  readonly editor: HTMLElement;
  readonly domWriter: import("./inputHarnessGlobal.js").HarnessDomWriter;
  readonly sync: import("./inputHarnessGlobal.js").HarnessSyncClient;
  readonly sentinel: import("./inputHarnessGlobal.js").HarnessMutationSentinel;
}

declare global {
  interface Window {
    __gA?: OneHarness;
    __gB?: OneHarness;
  }
}

/**
 * Builds TWO fully-wired, independent harnesses (`#editorA`/`#editorB`) on one page — each its
 * own DomWriter/SyncClient(seeded)/MutationSentinel/input pipeline, seeded to the SAME starting
 * CONTENT but with potentially DIFFERENT replica ids (per §2.4.1's "both orderings" rule).
 * Neither harness is connected to a real socket or to the other — every cross-harness effect in
 * this file is an explicit, test-driven relay, mirroring what a real server's broadcast would
 * deliver.
 *
 * The baseline is minted ONCE (on A's own engine) and REPLAYED node-for-node into B via
 * `applyRemote` — the same `syncFromSeed` technique this project's own adversarial suite,
 * DUR-01-style simulated clients, and `compositionController.test.ts` already establish.
 * Seeding each side via its OWN independent `localInsertText` call (an earlier, WRONG version of
 * this helper did exactly that) mints the baseline under TWO DIFFERENT replica ids, producing
 * two structurally DIFFERENT node graphs with completely different identifiers that only LOOK
 * identical as rendered text — a later relayed Delete/Insert referencing an A-side identifier
 * would then never resolve on B (its `target`/`parent` simply doesn't exist there), silently
 * buffering forever. Caught immediately by actually running this suite: EVERY GRA-01/GRA-02 test
 * failed with the peer never receiving the relayed operation before this fix.
 */
async function setupDualHarness(
  page: Page,
  baseline: string,
  replicaIdA: number,
  replicaIdB: number,
): Promise<void> {
  await page.setContent(
    '<div id="editorA" contenteditable="true"></div><div id="editorB" contenteditable="true"></div>',
  );
  await page.addScriptTag({ path: INPUT_HARNESS_BUNDLE_PATH });
  await page.evaluate(
    ({ text, ra, rb }) => {
      function construct(elementId: string, replicaId: number): OneHarness {
        const editor = document.getElementById(elementId)!;
        const domWriter = new window.InputHarness.DomWriter();
        const sync = new window.InputHarness.SyncClient({ url: "ws://unused", documentId: "doc" });
        sync.seedForTesting(new window.InputHarness.Engine(replicaId));
        const sentinel = new window.InputHarness.MutationSentinel({
          root: editor,
          domWriter,
          getEngineText: () => sync.engine?.text(),
        });
        return { editor, domWriter, sync, sentinel };
      }
      const a = construct("editorA", ra);
      const b = construct("editorB", rb);

      if (text.length > 0) {
        a.sync.localInsertText(0, text);
        for (const node of a.sync.engine!.nodes) {
          b.sync.engine!.applyRemote({
            kind: "insert",
            id: node.id,
            value: node.value,
            parent: node.parent,
            side: node.side,
            bind: node.bind,
          });
        }
      }

      for (const h of [a, b]) {
        h.sentinel.applyPatches(() => h.domWriter.mount(h.editor, h.sync.engine!.text()));
        h.sentinel.start();
        window.InputHarness.attachInputPipeline(h.editor, {
          domWriter: h.domWriter,
          sync: h.sync,
          sentinel: h.sentinel,
        });
      }

      window.__gA = a;
      window.__gB = b;
    },
    { text: baseline, ra: replicaIdA, rb: replicaIdB },
  );
}

type Side = "A" | "B";

function harnessRef(side: Side): "__gA" | "__gB" {
  return side === "A" ? "__gA" : "__gB";
}

async function engineText(page: Page, side: Side): Promise<string> {
  return page.evaluate((ref) => window[ref]!.sync.engine!.text(), harnessRef(side));
}

async function domText(page: Page, side: Side): Promise<string> {
  return page.evaluate((ref) => window[ref]!.domWriter.materializedText(), harnessRef(side));
}

async function reconciliationCount(page: Page, side: Side): Promise<number> {
  return page.evaluate((ref) => window[ref]!.sentinel.metrics.reconciliation, harnessRef(side));
}

/** Places a collapsed caret at visible (scalar) index `v` on `side`, via the REAL `visToDom` position mapping (Phase 11) — correct for astral/multi-scalar fixtures, unlike a hand-rolled UTF-16-offset walker. */
async function placeCaret(page: Page, side: Side, v: number): Promise<void> {
  await page.evaluate(
    ({ ref, visIndex }) => {
      const h = window[ref]!;
      const pos = window.InputHarness.visToDom(h.domWriter.index, h.editor, visIndex);
      const range = document.createRange();
      range.setStart(pos.node, pos.offset);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { ref: harnessRef(side), visIndex: v },
  );
}

async function focusEditor(page: Page, side: Side): Promise<void> {
  await page.click(side === "A" ? "#editorA" : "#editorB");
}

type SerializableOp =
  | {
      kind: "insert";
      id: { c: number; r: number };
      value: number;
      parent: { c: number; r: number } | null;
      side: "L" | "R";
      bind: boolean;
    }
  | { kind: "delete"; id: { c: number; r: number }; target: { c: number; r: number } };

/**
 * Dispatches a REAL `beforeinput` event of `inputType` on `side`'s editor (letting the real
 * pipeline mint through `SyncClient.localInsertText`/`localDelete` exactly as a genuine keystroke
 * would), then diffs `engine.nodes` before/after to recover exactly which operation(s) that one
 * dispatch produced — a real dispatch's own return value is swallowed inside `inputPipeline.ts`,
 * so this is the only way to recover it from OUTSIDE the pipeline without adding a test-only
 * production hook.
 */
async function dispatchAndDiff(
  page: Page,
  side: Side,
  inputType: string,
  data: string,
): Promise<SerializableOp[]> {
  return page.evaluate(
    ({ ref, type, d }) => {
      const h = window[ref]!;
      const engine = h.sync.engine!;
      const before = new Map(
        engine.nodes.map((n) => [`${n.id.c}:${n.id.r}`, { deleted: n.deleted }]),
      );
      const event = new InputEvent("beforeinput", {
        inputType: type,
        data: d,
        cancelable: true,
        bubbles: true,
      });
      h.editor.dispatchEvent(event);
      const ops: SerializableOp[] = [];
      for (const node of engine.nodes) {
        const key = `${node.id.c}:${node.id.r}`;
        const prior = before.get(key);
        if (!prior) {
          ops.push({
            kind: "insert",
            id: node.id,
            value: node.value,
            parent: node.parent,
            side: node.side,
            bind: node.bind,
          });
        } else if (node.deleted && !prior.deleted && node.deletedBy) {
          ops.push({ kind: "delete", id: node.deletedBy, target: node.id });
        }
      }
      return ops;
    },
    { ref: harnessRef(side), type: inputType, d: data },
  );
}

/** Real `Backspace` keystroke (not a synthetic beforeinput) on `side` — this project's own established distinction (GRA-02's own DoD wants a genuine keystroke, matching `inputPipeline.spec.ts`'s existing family-emoji test). Diffs the same way {@link dispatchAndDiff} does. */
async function backspaceAndDiff(page: Page, side: Side): Promise<SerializableOp[]> {
  const before = await page.evaluate((ref) => {
    const engine = window[ref]!.sync.engine!;
    return engine.nodes.map((n) => ({ key: `${n.id.c}:${n.id.r}`, deleted: n.deleted }));
  }, harnessRef(side));
  await focusEditor(page, side);
  await page.keyboard.press("Backspace");
  return page.evaluate(
    ({ ref, beforeList }) => {
      const beforeMap = new Map(beforeList.map((b) => [b.key, b.deleted]));
      const engine = window[ref]!.sync.engine!;
      const ops: SerializableOp[] = [];
      for (const node of engine.nodes) {
        const key = `${node.id.c}:${node.id.r}`;
        const wasDeleted = beforeMap.get(key);
        if (node.deleted && wasDeleted === false && node.deletedBy) {
          ops.push({ kind: "delete", id: node.deletedBy, target: node.id });
        }
      }
      return ops;
    },
    { ref: harnessRef(side), beforeList: before },
  );
}

/** Relays `ops` (minted on the OTHER side) into `side`'s own engine via `applyRemote`, then reacts exactly the way `EditorView.tsx`'s own `onRemoteOpsApplied` handler does (a full re-mount from the now-current `engine.text()`) — there is no React component in this harness to wire that reaction through automatically. */
async function relayInto(page: Page, side: Side, ops: readonly SerializableOp[]): Promise<void> {
  await page.evaluate(
    ({ ref, incoming }) => {
      const h = window[ref]!;
      const engine = h.sync.engine!;
      for (const op of incoming) {
        engine.applyRemote(op as never);
      }
      h.sentinel.applyPatches(() => h.domWriter.mount(h.editor, engine.text()));
    },
    { ref: harnessRef(side), incoming: ops },
  );
}

async function graphemeCount(page: Page, text: string): Promise<number> {
  return page.evaluate(
    (t) => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)).length,
    text,
  );
}

interface ClusterFixture {
  readonly label: string;
  readonly baseline: string; // the shared starting content, ending exactly at the cluster boundary
  readonly continuation: string; // what A appends (the cluster-continuation scalar(s))
  readonly expectedCombined: string; // baseline + continuation + "x"
  readonly expectedClusterCountBeforeX: number; // grapheme count of (baseline + continuation) alone
}

const GRA01_FIXTURES: readonly ClusterFixture[] = [
  {
    label: "combining acute",
    baseline: "e",
    continuation: "́",
    expectedCombined: "éx",
    expectedClusterCountBeforeX: 1,
  },
  {
    label: "ZWJ family emoji continuation",
    baseline: "\u{1F468}", // man
    continuation: "‍",
    expectedCombined: "\u{1F468}‍x",
    expectedClusterCountBeforeX: 1,
  },
  {
    label: "regional-indicator flag pair",
    baseline: "\u{1F1FA}", // regional indicator U
    continuation: "\u{1F1F8}", // regional indicator S -> US flag
    expectedCombined: "\u{1F1FA}\u{1F1F8}x",
    expectedClusterCountBeforeX: 1,
  },
  {
    label: "Devanagari consonant+matra",
    baseline: "क", // क (KA)
    continuation: "ि", // vowel sign I
    expectedCombined: "किx",
    expectedClusterCountBeforeX: 1,
  },
  {
    label: "variation selector",
    baseline: "☺", // ☺
    continuation: "️", // VS-16
    expectedCombined: "☺️x",
    expectedClusterCountBeforeX: 1,
  },
];

for (const fixture of GRA01_FIXTURES) {
  for (const [replicaA, replicaB] of [
    [1, 2],
    [2, 1],
  ] as const) {
    test(`GRA-01: ${fixture.label} — concurrent insert does not split the cluster (replica ordering A=${replicaA}, B=${replicaB})`, async ({
      page,
    }) => {
      await setupDualHarness(page, fixture.baseline, replicaA, replicaB);
      const boundary = Array.from(fixture.baseline).length; // scalar count of the shared baseline
      await placeCaret(page, "A", boundary);
      await placeCaret(page, "B", boundary);

      // Both clients mint LOCALLY, concurrently — neither has seen the other's op yet.
      const opsFromA = await dispatchAndDiff(page, "A", "insertText", fixture.continuation);
      const opsFromB = await dispatchAndDiff(page, "B", "insertText", "x");

      // Now exchange — exactly like a real server relaying each op to the OTHER session.
      await relayInto(page, "B", opsFromA);
      await relayInto(page, "A", opsFromB);

      const domA = await domText(page, "A");
      const domB = await domText(page, "B");
      const engineA = await engineText(page, "A");
      const engineB = await engineText(page, "B");

      // Byte-identical DOMs (GRA-01 step 3).
      expect(domA).toBe(domB);
      expect(engineA).toBe(engineB);
      expect(domA).toBe(fixture.expectedCombined);

      // The cluster is intact (GRA-01 step 4) — same grapheme count before and after the
      // concurrent 'x', and specifically the base+continuation is still exactly ONE cluster.
      const wholeCount = await graphemeCount(page, domA);
      expect(wholeCount).toBe(fixture.expectedClusterCountBeforeX + 1); // the cluster, plus 'x'
      const clusterAlone = await graphemeCount(page, fixture.baseline + fixture.continuation);
      expect(clusterAlone).toBe(fixture.expectedClusterCountBeforeX);

      // The continuation did NOT migrate onto B's character (GRA-01 step 5) — 'x' is the LAST
      // character, never adjacent to the base on its own.
      expect(domA.endsWith("x")).toBe(true);
      expect(domA.startsWith(fixture.baseline + fixture.continuation)).toBe(true);

      expect(await reconciliationCount(page, "A")).toBe(0);
      expect(await reconciliationCount(page, "B")).toBe(0);
    });
  }
}

interface BackspaceFixture {
  readonly label: string;
  readonly baseline: string; // full content, cluster at the very end
  readonly clusterScalarCount: number; // how many Delete operations backspace must emit
}

const GRA02_FIXTURES: readonly BackspaceFixture[] = [
  { label: "combining acute (é as e + combining mark)", baseline: "café", clusterScalarCount: 2 },
  {
    label:
      "ZWJ family emoji (already covered once for real keystrokes in inputPipeline.spec.ts — repeated here for the FULL fixture sweep)",
    baseline: "x\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}",
    clusterScalarCount: 7,
  },
  { label: "regional-indicator flag pair", baseline: "x\u{1F1FA}\u{1F1F8}", clusterScalarCount: 2 },
  { label: "Devanagari consonant+matra", baseline: "xकि", clusterScalarCount: 2 },
  { label: "variation selector", baseline: "x☺️", clusterScalarCount: 2 },
];

for (const fixture of GRA02_FIXTURES) {
  test(`GRA-02: ${fixture.label} — Backspace removes the WHOLE cluster in one keystroke, and the peer converges`, async ({
    page,
  }) => {
    await setupDualHarness(page, fixture.baseline, 1, 2);
    const end = Array.from(fixture.baseline).length;
    await placeCaret(page, "A", end);

    const before = await engineText(page, "A");
    const deleteOps = await backspaceAndDiff(page, "A");

    expect(deleteOps).toHaveLength(fixture.clusterScalarCount); // ASSERT: Delete-op count === cluster scalar count
    expect(deleteOps.every((op) => op.kind === "delete")).toBe(true);

    const expectedRemaining = Array.from(before).slice(0, -fixture.clusterScalarCount).join("");
    const afterA = await engineText(page, "A");
    expect(afterA).toBe(expectedRemaining); // ASSERT: the entire cluster is gone, not one code point
    expect(await domText(page, "A")).toBe(expectedRemaining);

    // ASSERT: the peer converges.
    await relayInto(page, "B", deleteOps);
    expect(await engineText(page, "B")).toBe(expectedRemaining);
    expect(await domText(page, "B")).toBe(expectedRemaining);

    expect(await reconciliationCount(page, "A")).toBe(0);
  });
}

/**
 * MUT-04 — the TWO Safari-specific sub-cases Test Plan §7.4's own text explicitly names as
 * "reliably testable via WebKit automation" (unlike the OS-level press-and-hold accent menu and
 * iOS autocapitalize, which cannot be — see this phase's own end-of-phase report for the required
 * manual verification steps for those). Both run on all three engines (proving the SAME handling
 * is genuinely uniform, not accidentally WebKit-only), each asserting convergence with a peer and
 * `binding.reconciliation === 0`, per the phase brief's own explicit requirement.
 */
test.describe("MUT-04 — Safari-specific behaviours (automatable subset)", () => {
  test("smart quotes/dashes substitution (insertReplacementText) — the correction sticks and converges, reconciliation stays 0", async ({
    page,
  }) => {
    await setupDualHarness(page, "she said 'hi' - really", 1, 2);
    // Real Safari's smart-quotes/dashes substitution fires as a real `insertReplacementText`
    // beforeinput (the SAME inputType autocorrect/spellcheck already use, MUT-01) — the genuine
    // OS-level TRIGGER cannot be automated, but the real event this project's own pipeline must
    // handle correctly can be, via the same "real event object, synthetic origin" methodology
    // Phase 12 already established for autocorrect.
    await placeCaret(page, "A", 0);
    // Select the straight-quoted word and replace with curly quotes, mirroring a real substitution.
    await page.evaluate(() => {
      const h = window.__gA!;
      const pos1 = window.InputHarness.visToDom(h.domWriter.index, h.editor, 9);
      const pos2 = window.InputHarness.visToDom(h.domWriter.index, h.editor, 13);
      const range = document.createRange();
      range.setStart(pos1.node, pos1.offset);
      range.setEnd(pos2.node, pos2.offset);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    const ops = await dispatchAndDiff(page, "A", "insertReplacementText", "‘hi’"); // curly single quotes
    expect(await engineText(page, "A")).toBe("she said ‘hi’ - really");
    expect(await domText(page, "A")).toBe("she said ‘hi’ - really"); // the correction STICKS in the DOM, not just the engine
    expect(await reconciliationCount(page, "A")).toBe(0); // never absorbed/reverted by the sentinel

    await relayInto(page, "B", ops);
    expect(await engineText(page, "B")).toBe(await engineText(page, "A")); // converges with the peer
  });

  test("Selection API returns an ELEMENT node for an empty, freshly-focused contenteditable — typing still converges with a peer, reconciliation stays 0", async ({
    page,
    browserName,
  }) => {
    // Test Plan §7.4's own point: WebKit is known to report `Range.startContainer` as the
    // element itself (not a text node) for an empty, just-focused contenteditable, historically
    // a divergence from Chromium (Phase 11's own DOM-03 already established this at the
    // position-MAPPING level, and disclosed there that "Chromium inserts a <br>, WebKit does
    // not"). CHECKED DIRECTLY as part of this phase, not assumed: a standalone probe against
    // this project's own current Playwright-bundled Chromium/Firefox/WebKit builds (no
    // DomWriter/pipeline involved, a bare `<div contenteditable>` + a real click) found ALL
    // THREE engines report an ELEMENT `startContainer` for this exact scenario today — the
    // browsers have converged on this one point since whatever versions originally motivated the
    // Test Plan's own wording. This test still exercises the real, current DOM shape end to end
    // through the WHOLE pipeline + sentinel (not just Phase 11's position-mapping function in
    // isolation) on all three engines — it is no longer a cross-engine DIFFERENTIATOR, but it is
    // still the real API Spec §7.2.3 "element node" case `normalizeElementPosition` exists to
    // handle, genuinely reached by a real click in a real browser, not synthesized.
    await setupDualHarness(page, "", 1, 2);
    await focusEditor(page, "A");
    const containerIsElement = await page.evaluate(() => {
      const sel = window.getSelection();
      return sel?.rangeCount
        ? sel.getRangeAt(0).startContainer.nodeType === Node.ELEMENT_NODE
        : null;
    });
    // Asserted directly (not merely annotated): the standalone probe above confirmed this is
    // `true` on all three of THIS project's current Playwright-bundled engines, so this test
    // genuinely exercises the ELEMENT-node case on every run, not just "on WebKit, maybe."
    expect(containerIsElement).toBe(true);
    test.info().annotations.push({
      type: "selection-container-kind",
      description: `${browserName}: startContainer is an ELEMENT node for an empty, focused contenteditable`,
    });

    const ops = await dispatchAndDiff(page, "A", "insertText", "hi");
    expect(await engineText(page, "A")).toBe("hi");
    expect(await domText(page, "A")).toBe("hi");
    expect(await reconciliationCount(page, "A")).toBe(0);

    await relayInto(page, "B", ops);
    expect(await engineText(page, "B")).toBe("hi");
  });
});
