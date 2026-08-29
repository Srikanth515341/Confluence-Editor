import { describe, expect, it } from "vitest";
import { TESTKIT_PACKAGE_NAME, runTrial, createToyAdapter, C1_BASELINE } from "./index.js";

describe("testkit package scaffolding", () => {
  it("exists and is importable", () => {
    expect(TESTKIT_PACKAGE_NAME).toBe("@collab-editor/testkit");
  });

  it("exports the Phase 2 fuzz harness primitives", () => {
    expect(typeof runTrial).toBe("function");
    expect(typeof createToyAdapter).toBe("function");
    expect(C1_BASELINE.name).toBe("C1-baseline");
  });
});
