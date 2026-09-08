import { describe, expect, it } from "vitest";
import {
  ALL_DOCUMENT_ROLES,
  GRANTABLE_ROLES,
  canonicalJsonStringify,
  decodeDocumentListCursor,
  encodeDocumentListCursor,
  hashRequestBody,
  isDocumentRole,
  isGrantableRole,
  maskEmail,
  resolveTitleForCreate,
  resolveTitleForUpdate,
  toDocumentSummary,
} from "./documentService.js";
import type { DocumentRow } from "./db/documentStore.js";

function fakeDocumentRow(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: "doc-1",
    title: "A Title",
    ownerId: "user-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    currentSeq: 42n,
    structureSize: 10,
    tombstoneCount: 2,
    accessRevokedAt: null,
    ...overrides,
  };
}

describe("documentService (Phase 27, API Spec §4.3-§4.6/§4.16/§9.2)", () => {
  describe("resolveTitleForCreate — POST's own rule: optional, defaults to Untitled, max 512 chars", () => {
    it("defaults to 'Untitled' when the title is omitted entirely", () => {
      expect(resolveTitleForCreate(undefined)).toEqual({ ok: true, title: "Untitled" });
    });
    it("accepts a normal string title unchanged", () => {
      expect(resolveTitleForCreate("Design review")).toEqual({ ok: true, title: "Design review" });
    });
    it("accepts a title of EXACTLY 512 characters (the boundary itself is valid)", () => {
      const title = "x".repeat(512);
      expect(resolveTitleForCreate(title)).toEqual({ ok: true, title });
    });
    it("rejects a title of 513 characters", () => {
      expect(resolveTitleForCreate("x".repeat(513))).toEqual({ ok: false });
    });
    it("rejects a non-string title", () => {
      expect(resolveTitleForCreate(123)).toEqual({ ok: false });
      expect(resolveTitleForCreate(null)).toEqual({ ok: false });
      expect(resolveTitleForCreate(["a"])).toEqual({ ok: false });
    });
  });

  describe("resolveTitleForUpdate — PATCH's own stricter rule: title is REQUIRED, non-empty, max 512 chars", () => {
    it("rejects an omitted title (PATCH has no sensible default — there is nothing else to update)", () => {
      expect(resolveTitleForUpdate(undefined)).toEqual({ ok: false });
    });
    it("rejects an empty string", () => {
      expect(resolveTitleForUpdate("")).toEqual({ ok: false });
    });
    it("accepts a normal title", () => {
      expect(resolveTitleForUpdate("New title")).toEqual({ ok: true, title: "New title" });
    });
    it("rejects a title over 512 characters", () => {
      expect(resolveTitleForUpdate("x".repeat(513))).toEqual({ ok: false });
    });
  });

  describe("isGrantableRole — Phase 28's PUT permissions endpoint's own role enum: 'editor'|'viewer' only, never 'owner'", () => {
    it("accepts every GRANTABLE_ROLES value", () => {
      for (const role of GRANTABLE_ROLES) {
        expect(isGrantableRole(role)).toBe(true);
      }
    });
    it("rejects 'owner' — ownership can only ever be TRANSFERRED (POST /owner), never GRANTED via PUT", () => {
      expect(isGrantableRole("owner")).toBe(false);
    });
    it("rejects a non-string/garbage value", () => {
      expect(isGrantableRole(123)).toBe(false);
      expect(isGrantableRole(undefined)).toBe(false);
      expect(isGrantableRole("administrator")).toBe(false);
    });
  });

  describe("maskEmail — API Spec §4.16's own literal example: 'a***@example.com'", () => {
    it("keeps the first character of the local part and the whole domain", () => {
      expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    });
    it("works for a single-character local part too", () => {
      expect(maskEmail("a@example.com")).toBe("a***@example.com");
    });
  });

  describe("canonicalJsonStringify / hashRequestBody — API Spec §9.2's 'same body' check must be key-order-independent", () => {
    it("produces the identical hash regardless of key order", () => {
      const a = hashRequestBody({ title: "x", extra: 1 });
      const b = hashRequestBody({ extra: 1, title: "x" });
      expect(a).toBe(b);
    });
    it("produces different hashes for genuinely different bodies", () => {
      expect(hashRequestBody({ title: "x" })).not.toBe(hashRequestBody({ title: "y" }));
    });
    it("canonicalJsonStringify sorts nested object keys too", () => {
      expect(canonicalJsonStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
        canonicalJsonStringify({ a: { c: 3, d: 2 }, b: 1 }),
      );
    });
  });

  describe("toDocumentSummary — the create-response object's exact shape", () => {
    it("maps a DocumentRow into the response shape, with currentSeq as a plain number (API Spec §4.3's own literal example)", () => {
      const summary = toDocumentSummary(fakeDocumentRow(), "editor");
      expect(summary).toEqual({
        id: "doc-1",
        title: "A Title",
        ownerId: "user-1",
        role: "editor",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        currentSeq: 42,
      });
    });
  });

  describe("document list cursor — opaque, round-trips exactly, rejects garbage", () => {
    it("round-trips an (updatedAt, id) pair exactly", () => {
      const updatedAt = new Date("2026-03-01T12:34:56.789Z");
      const cursor = encodeDocumentListCursor({ updatedAt, id: "doc-42" });
      expect(decodeDocumentListCursor(cursor)).toEqual({ updatedAt, id: "doc-42" });
    });
    it("returns undefined (never throws) for garbage input", () => {
      expect(decodeDocumentListCursor("not-a-real-cursor")).toBeUndefined();
      expect(decodeDocumentListCursor(Buffer.from("{}").toString("base64url"))).toBeUndefined();
      expect(
        decodeDocumentListCursor(
          Buffer.from(JSON.stringify({ updatedAt: "not-a-date", id: "x" })).toString("base64url"),
        ),
      ).toBeUndefined();
    });
  });

  describe("isDocumentRole / ALL_DOCUMENT_ROLES", () => {
    it("accepts exactly the three real roles", () => {
      expect(ALL_DOCUMENT_ROLES).toEqual(["owner", "editor", "viewer"]);
      for (const role of ALL_DOCUMENT_ROLES) {
        expect(isDocumentRole(role)).toBe(true);
      }
    });
    it("rejects anything else", () => {
      expect(isDocumentRole("admin")).toBe(false);
      expect(isDocumentRole("")).toBe(false);
    });
  });
});
