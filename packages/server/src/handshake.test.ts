import { describe, expect, it } from "vitest";
import { SessionRole, SnapshotForm } from "@collab-editor/protocol";
import { assertSnapshotFormAllowed, buildSnapshotMessage } from "./handshake.js";
import { DocumentCoordinator } from "./documentCoordinator.js";

describe("assertSnapshotFormAllowed (API Spec §3.6.3)", () => {
  it("rejects form: PLAIN_TEXT for an EDITOR role — in code, not just by convention", () => {
    expect(() => assertSnapshotFormAllowed(SnapshotForm.PLAIN_TEXT, SessionRole.EDITOR)).toThrow();
  });

  it("rejects form: PLAIN_TEXT for an OWNER role too", () => {
    expect(() => assertSnapshotFormAllowed(SnapshotForm.PLAIN_TEXT, SessionRole.OWNER)).toThrow();
  });

  it("allows form: PLAIN_TEXT for a VIEWER role", () => {
    expect(() =>
      assertSnapshotFormAllowed(SnapshotForm.PLAIN_TEXT, SessionRole.VIEWER),
    ).not.toThrow();
  });

  it("allows form: STRUCTURE for every role", () => {
    expect(() =>
      assertSnapshotFormAllowed(SnapshotForm.STRUCTURE, SessionRole.VIEWER),
    ).not.toThrow();
    expect(() =>
      assertSnapshotFormAllowed(SnapshotForm.STRUCTURE, SessionRole.EDITOR),
    ).not.toThrow();
    expect(() =>
      assertSnapshotFormAllowed(SnapshotForm.STRUCTURE, SessionRole.OWNER),
    ).not.toThrow();
  });
});

describe("buildSnapshotMessage", () => {
  it("always builds form: STRUCTURE this phase, since every session's role is hardcoded to EDITOR", () => {
    const coordinator = new DocumentCoordinator("doc-1");
    const snapshot = buildSnapshotMessage(coordinator);
    expect(snapshot.form).toBe(SnapshotForm.STRUCTURE);
  });
});
