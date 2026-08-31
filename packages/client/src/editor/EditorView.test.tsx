// @vitest-environment jsdom
//
// No React Testing Library dependency (project convention: no external
// dependency unless necessary, e.g. connectionState.ts's own comment) —
// `react-dom/client` + `act` from `react` are enough to mount the component
// into a real jsdom container and assert on the resulting DOM.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@collab-editor/engine";
import { SyncClient } from "../sync/syncClient.js";
import { EditorView } from "./EditorView.js";

// Required for React's `act()` to work outside of @testing-library/react's own setup, which this
// project deliberately doesn't depend on (see this file's own header comment).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

/** A `SyncClient` that is never actually connected — `engine` is set directly and `state` is driven manually, the same no-network trick `inputPipeline.test.ts` uses. */
function makeSyncedClient(initialText = ""): SyncClient {
  const sync = new SyncClient({ url: "ws://unused", documentId: "doc" });
  sync.seedForTesting(new Engine(1));
  if (initialText.length > 0) {
    sync.localInsertText(0, initialText);
  }
  return sync;
}

describe("EditorView", () => {
  it("renders a contenteditable root", () => {
    const sync = makeSyncedClient();
    act(() => {
      root.render(<EditorView sync={sync} />);
    });
    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).not.toBeNull();
  });

  it("mounts existing engine content into the DOM when the client is already synced", () => {
    const sync = makeSyncedClient("hello");
    act(() => {
      root.render(<EditorView sync={sync} />);
    });
    const editable = container.querySelector('[contenteditable="true"]')!;
    expect(editable.textContent).toBe("hello");
  });

  it("mounts content once the client transitions to 'synced' after mount", () => {
    const sync = new SyncClient({ url: "ws://unused", documentId: "doc" }); // engine still null — not synced
    act(() => {
      root.render(<EditorView sync={sync} />);
    });
    const editable = container.querySelector('[contenteditable="true"]')!;
    expect(editable.textContent).toBe("");

    act(() => {
      // Populate the engine's content via the low-level `Engine` API (which has no "synced"
      // concept at all) BEFORE marking the client synced — exactly mirroring a real SNAPSHOT,
      // which always already contains its content by the time a client learns it's synced.
      // `seedForTesting` then flips `state` to "synced" in one step, which is what actually fires
      // EditorView's `state.subscribe` reaction and reads `engine.text()` — already "later" by then.
      const engine = new Engine(1);
      for (const ch of "later") {
        engine.localInsert(engine.text().length, ch.codePointAt(0)!);
      }
      sync.seedForTesting(engine);
    });

    expect(editable.textContent).toBe("later");
  });

  it("beforeinput through the mounted editor updates both the DOM and the engine", () => {
    const sync = makeSyncedClient("ab");
    act(() => {
      root.render(<EditorView sync={sync} />);
    });
    const editable = container.querySelector('[contenteditable="true"]')! as HTMLElement;

    const textNode = editable.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    act(() => {
      const event = new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "X",
        cancelable: true,
        bubbles: true,
      });
      editable.dispatchEvent(event);
    });

    expect(sync.engine!.text()).toBe("aXb");
    expect(editable.textContent).toBe("aXb");
  });
});
