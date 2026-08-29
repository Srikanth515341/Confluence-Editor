import { describe, expect, it } from "vitest";
import { SERVER_PACKAGE_NAME } from "./index.js";

describe("server package scaffolding", () => {
  it("exists and is importable", () => {
    expect(SERVER_PACKAGE_NAME).toBe("@collab-editor/server");
  });
});
