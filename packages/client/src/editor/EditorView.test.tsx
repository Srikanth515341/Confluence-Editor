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
  sync.engine = new Engine(1);
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
      sync.engine = new Engine(1);
      sync.localInsertText(0, "later");
    });
    // SyncClient has no public "force synced" API (there is no offline edit queue this phase) — the
    // component only reacts to real state transitions, so drive the same `ObservableValue.set` the
    // real handshake would call, via its public `Observable<T>` surface cast back to the concrete type.
    act(() => {
      (sync.state as unknown as { set(v: "synced"): void }).set("synced");
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
