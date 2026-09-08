import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { sendError } from "./restErrors.js";

function fakeResponse(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

describe("sendError (Phase 27, API Spec §5.1's error envelope)", () => {
  it("sends exactly the §5.1 shape, with `details` omitted (not present as `undefined`/`null`) when not given", () => {
    const res = fakeResponse();
    sendError(res, 404, "document_not_found", "No such document", "req-1");
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: "document_not_found", message: "No such document", requestId: "req-1" },
    });
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { error: object };
    expect(Object.keys(call.error)).toEqual(["code", "message", "requestId"]); // no `details` key at all
  });

  it("includes `details` only when explicitly given — §5.1's own 'details only present for validation_failed' carve-out", () => {
    const res = fakeResponse();
    sendError(res, 400, "validation_failed", "title too long", "req-2", { fields: ["title"] });
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: "validation_failed",
        message: "title too long",
        requestId: "req-2",
        details: { fields: ["title"] },
      },
    });
  });
});
