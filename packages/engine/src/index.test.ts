import { describe, expect, it } from "vitest";
import { ENGINE_PACKAGE_NAME } from "./index.js";

describe("engine package scaffolding", () => {
  it("exists and is importable", () => {
    expect(ENGINE_PACKAGE_NAME).toBe("@collab-editor/engine");
  });
});
