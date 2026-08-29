import { describe, expect, it } from "vitest";
import { PROTOCOL_PACKAGE_NAME } from "./index.js";

describe("protocol package", () => {
  it("exists and is importable", () => {
    expect(PROTOCOL_PACKAGE_NAME).toBe("@collab-editor/protocol");
  });
});
