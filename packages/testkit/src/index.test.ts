import { describe, expect, it } from "vitest";
import { TESTKIT_PACKAGE_NAME } from "./index.js";

describe("testkit package scaffolding", () => {
  it("exists and is importable", () => {
    expect(TESTKIT_PACKAGE_NAME).toBe("@collab-editor/testkit");
  });
});
