import { beforeEach, describe, expect, it } from "vitest";
import {
  encodeControlFrame,
  encodeFrame,
  encodeStructureSnapshotBody,
  RejectReason,
  SessionRole,
  SnapshotForm,
  SyncMode,
  type WelcomeMessage,
} from "@collab-editor/protocol";
import type { Identifier } from "@collab-editor/engine";
import { randomUUID } from "node:crypto";
import { SyncClient, type WebSocketLike, type RejectedEntry } from "./syncClient.js";

// Phase 25 (Option 2 / R0012's own scoped mitigation, Engine Spec §7.6 Rule 7.2) — end-to-end
// SyncClient-level proof that a LATE OP_REJECT (OFFLINE_WINDOW_EXCEEDED) for an insert this
// client already integrated locally is handled correctly in BOTH sub-cases: the clean case
// (revert succeeds, the document is genuinely corrected, both notification channels fire) and
// the cascading case (revert correctly refuses, the existing preserve-only behavior is
// unchanged). See tests/regression/R0012 and CLAUDE.md's own critical-flag entry for the full
// scenario this exists to mitigate.

class FakeWebSocket implements WebSocketLike {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  closed = false;

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code = 1005, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  triggerMessage(bytes: Uint8Array): void {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
}

describe("SyncClient — local-insert revert on a late OFFLINE_WINDOW_EXCEEDED rejection (Phase 25, Option 2, R0012)", () => {
  let sockets: FakeWebSocket[];
  let client: SyncClient;
  const documentId = randomUUID();

  beforeEach(() => {
    sockets = [];
    client = new SyncClient({
      url: "ws://fake",
      documentId,
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
    });
  });

  function welcomeFrame(replicaId: number): Uint8Array {
    const msg: WelcomeMessage = {
      kind: "welcome",
      sessionId: randomUUID(),
      replicaId,
      role: SessionRole.EDITOR,
      serverSeq: 0,
      syncMode: SyncMode.SNAPSHOT,
      participants: [],
    };
    return encodeControlFrame(msg);
  }

  function snapshotFrame(seq: number): Uint8Array {
    return encodeControlFrame({
      kind: "snapshot",
      seq,
      form: SnapshotForm.STRUCTURE,
      body: encodeStructureSnapshotBody([]),
    });
  }

  function alreadyHaveFrame(alreadyHave: Identifier[] = []): Uint8Array {
    return encodeControlFrame({ kind: "alreadyHave", alreadyHave });
  }

  function opRejectFrame(rejectedId: Identifier, reason: RejectReason, detail = ""): Uint8Array {
    return encodeFrame({ kind: "opReject", rejects: [{ rejectedId, reason }], detail });
  }

  async function reachSynced(): Promise<FakeWebSocket> {
    client.connect();
    const ws = sockets[0]!;
    ws.triggerOpen();
    ws.triggerMessage(welcomeFrame(1));
    ws.triggerMessage(snapshotFrame(0));
    ws.triggerMessage(alreadyHaveFrame([]));
    await Promise.resolve(); // flush the handshakeGate microtask, per this file's own established pattern
    return ws;
  }

  it("the CLEAN case: reverts the local insert, corrects engine.text(), fires BOTH notification channels, and marks the preserved entry reverted", async () => {
    await reachSynced();

    const [opA] = client.localInsertText(0, "A");
    expect(client.engine!.text()).toBe("A");
    const [opD] = client.localInsertText(1, "D"); // a leaf -- nothing chains onto it yet
    expect(client.engine!.text()).toBe("AD");
    void opA;

    let remoteOpsFired = 0;
    client.onRemoteOpsApplied(() => {
      remoteOpsFired += 1;
    });
    let revertedEntry: RejectedEntry | undefined;
    client.onLocalInsertReverted((entry) => {
      revertedEntry = entry;
    });

    const ws = sockets[0]!;
    ws.triggerMessage(opRejectFrame(opD!.id, RejectReason.OFFLINE_WINDOW_EXCEEDED, "stuck"));

    expect(client.engine!.text()).toBe("A"); // genuinely corrected -- not merely preserved-but-still-shown
    expect(remoteOpsFired).toBe(1); // the DOM-re-render signal fired
    expect(revertedEntry).toBeDefined();
    expect(revertedEntry!.reverted).toBe(true);
    expect(revertedEntry!.op.id).toEqual(opD!.id);

    const preserved = client.listRejected();
    expect(preserved).toHaveLength(1);
    expect(preserved[0]!.reverted).toBe(true);
  });

  it("the CASCADING case: a later local insert already chains onto the rejected node -- revert refuses, document unchanged, content still preserved (unreverted)", async () => {
    await reachSynced();

    const [opA] = client.localInsertText(0, "A");
    const [opD] = client.localInsertText(1, "D");
    const [opE] = client.localInsertText(2, "E"); // chains directly onto opD before the rejection ever arrives
    expect(client.engine!.text()).toBe("ADE");
    void opA;

    let remoteOpsFired = 0;
    client.onRemoteOpsApplied(() => {
      remoteOpsFired += 1;
    });
    let revertedEntry: RejectedEntry | undefined;
    client.onLocalInsertReverted((entry) => {
      revertedEntry = entry;
    });

    const ws = sockets[0]!;
    ws.triggerMessage(opRejectFrame(opD!.id, RejectReason.OFFLINE_WINDOW_EXCEEDED, "stuck"));

    expect(client.engine!.text()).toBe("ADE"); // completely unchanged -- no partial/unsafe removal
    expect(remoteOpsFired).toBe(0); // no revert happened -- no re-render signal fired
    expect(revertedEntry).toBeUndefined(); // the revert-specific notification never fires on refusal

    const preserved = client.listRejected();
    expect(preserved).toHaveLength(1); // content is still preserved, exactly as before this fix
    expect(preserved[0]!.reverted).toBe(false);
    expect(preserved[0]!.op.id).toEqual(opD!.id);
    void opE;
  });

  it("a rejected DELETE is never reverted (out of this fix's disclosed scope) -- preserved exactly as before", async () => {
    await reachSynced();

    client.localInsertText(0, "AB");
    const [delOp] = client.localDelete(0, 1); // deletes "A"
    expect(client.engine!.text()).toBe("B");

    let remoteOpsFired = 0;
    client.onRemoteOpsApplied(() => {
      remoteOpsFired += 1;
    });

    const ws = sockets[0]!;
    ws.triggerMessage(opRejectFrame(delOp!.id, RejectReason.OFFLINE_WINDOW_EXCEEDED, "stuck"));

    expect(client.engine!.text()).toBe("B"); // unchanged -- deletes are never reverted by this fix
    expect(remoteOpsFired).toBe(0);
    const preserved = client.listRejected();
    expect(preserved).toHaveLength(1);
    expect(preserved[0]!.reverted).toBe(false);
  });
});
