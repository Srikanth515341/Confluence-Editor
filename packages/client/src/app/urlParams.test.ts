import { describe, expect, it, vi } from "vitest";
import { getOrCreateDocumentId, getServerUrl, readDocumentId } from "./urlParams.js";

describe("readDocumentId", () => {
  it("reads an existing ?doc= value", () => {
    expect(readDocumentId("?doc=abc123")).toBe("abc123");
  });

  it("returns null when absent", () => {
    expect(readDocumentId("")).toBeNull();
    expect(readDocumentId("?other=x")).toBeNull();
  });

  it("returns null for an empty ?doc=", () => {
    expect(readDocumentId("?doc=")).toBeNull();
  });
});

describe("getOrCreateDocumentId — Phase 14 Scope-IN: open a document by URL", () => {
  it("returns the existing id and never calls replaceUrl when ?doc= is already present", () => {
    const replaceUrl = vi.fn();
    const id = getOrCreateDocumentId({ search: "?doc=existing-id" }, replaceUrl);
    expect(id).toBe("existing-id");
    expect(replaceUrl).not.toHaveBeenCalled();
  });

  it("mints a fresh id and writes it back via replaceUrl when absent", () => {
    const replaceUrl = vi.fn();
    const id = getOrCreateDocumentId({ search: "" }, replaceUrl, () => "minted-id");
    expect(id).toBe("minted-id");
    expect(replaceUrl).toHaveBeenCalledWith("?doc=minted-id");
  });

  it("preserves other query params when minting a new id", () => {
    const replaceUrl = vi.fn();
    getOrCreateDocumentId({ search: "?foo=bar" }, replaceUrl, () => "minted-id");
    const written = replaceUrl.mock.calls[0]![0] as string;
    const params = new URLSearchParams(written);
    expect(params.get("foo")).toBe("bar");
    expect(params.get("doc")).toBe("minted-id");
  });
});

describe("getServerUrl", () => {
  it("defaults to ws://<hostname>:8080/v1/rt over http", () => {
    const url = getServerUrl({ search: "", protocol: "http:", hostname: "localhost" });
    expect(url).toBe("ws://localhost:8080/v1/rt");
  });

  it("uses wss: when the page itself is https:", () => {
    const url = getServerUrl({ search: "", protocol: "https:", hostname: "example.com" });
    expect(url).toBe("wss://example.com:8080/v1/rt");
  });

  it("a ?server= override takes precedence over the derived default", () => {
    const url = getServerUrl({
      search: "?server=ws://127.0.0.1:54321/v1/rt",
      protocol: "http:",
      hostname: "localhost",
    });
    expect(url).toBe("ws://127.0.0.1:54321/v1/rt");
  });
});
