import { describe, expect, it } from "vitest";
import { Engine, compareIds, isClusterContinuing } from "./index.js";

describe("engine package public surface", () => {
  it("exports the Phase 1 primitives", () => {
    expect(typeof Engine).toBe("function");
    expect(typeof compareIds).toBe("function");
    expect(typeof isClusterContinuing).toBe("function");
  });
});
