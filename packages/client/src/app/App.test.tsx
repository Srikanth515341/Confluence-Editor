// @vitest-environment jsdom
//
// No React Testing Library dependency, same convention as EditorView.test.tsx.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let originalHistory: History;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  originalHistory = window.history;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  window.history.replaceState(null, "", "/");
  void originalHistory;
});

describe("App — Phase 14 Scope-IN: open a document by URL, edit it, see a connection-state indicator", () => {
  it("renders a connection-state indicator and a contenteditable root", () => {
    window.history.replaceState(null, "", "/?doc=11111111-1111-4111-8111-111111111111");
    act(() => {
      root.render(<App />);
    });
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toMatch(/connecting/i);
    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).not.toBeNull();
  });

  it("mints a document id into the URL when none is present", () => {
    window.history.replaceState(null, "", "/");
    act(() => {
      root.render(<App />);
    });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("doc")).toBeTruthy();
  });

  it("reuses an existing ?doc= id rather than minting a new one", () => {
    window.history.replaceState(null, "", "/?doc=22222222-2222-4222-8222-222222222222");
    act(() => {
      root.render(<App />);
    });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("doc")).toBe("22222222-2222-4222-8222-222222222222");
  });
});
