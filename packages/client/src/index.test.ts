import { describe, expect, it } from "vitest";
import { CLIENT_PACKAGE_NAME } from "./index.js";

describe("client package scaffolding", () => {
  it("exists and is importable", () => {
    expect(CLIENT_PACKAGE_NAME).toBe("@collab-editor/client");
  });
});
