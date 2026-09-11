import { describe, expect, it } from "vitest";
import { decodePresenceFrame, SessionRole, type PresenceMessage } from "@collab-editor/protocol";
import { PresenceLeaveReason, PresenceRoom, type PresenceParticipant } from "./presenceManager.js";

function makeSink(): { received: PresenceMessage[]; send: (frame: Uint8Array) => void } {
  const received: PresenceMessage[] = [];
  return {
    received,
    send: (frame) => received.push(decodePresenceFrame(frame, { direction: "serverOrigin" })),
  };
}

function participant(overrides: Partial<PresenceParticipant> = {}): PresenceParticipant {
  return {
    sessionId: "s1",
    replicaId: 1,
    userId: "11111111-1111-1111-1111-111111111111",
    displayName: "Alice",
    role: SessionRole.EDITOR,
    ...overrides,
  };
}

describe("PresenceRoom — structural isolation (Phase 31, API Spec §3.8)", () => {
  it("join broadcasts PRESENCE_JOIN to existing participants, never to the joiner itself", () => {
    const room = new PresenceRoom();
    const a = makeSink();
    room.join(participant({ sessionId: "a", replicaId: 1, displayName: "A" }), a.send);
    expect(a.received).toHaveLength(0); // nobody else was here yet

    const b = makeSink();
    room.join(participant({ sessionId: "b", replicaId: 2, displayName: "B" }), b.send);
    expect(b.received).toHaveLength(0); // B never gets its own JOIN
    expect(a.received).toEqual([
      { kind: "presenceJoin", replicaId: 2, userId: expect.any(String), displayName: "B", role: SessionRole.EDITOR },
    ]);
  });

  it("sendRoster includes every current participant, including the requester itself", () => {
    const room = new PresenceRoom();
    room.join(participant({ sessionId: "a", replicaId: 1, displayName: "A" }), makeSink().send);
    const b = makeSink();
    room.join(participant({ sessionId: "b", replicaId: 2, displayName: "B" }), b.send);

    room.sendRoster("b");
    expect(b.received).toEqual([
      {
        kind: "presenceRoster",
        participants: expect.arrayContaining([
          expect.objectContaining({ replicaId: 1, displayName: "A" }),
          expect.objectContaining({ replicaId: 2, displayName: "B" }),
        ]),
      },
    ]);
    const roster = b.received[0];
    if (roster?.kind === "presenceRoster") {
      expect(roster.participants).toHaveLength(2);
    }
  });

  it("leave broadcasts PRESENCE_LEAVE with the given reason and removes the participant", () => {
    const room = new PresenceRoom();
    room.join(participant({ sessionId: "a", replicaId: 1 }), makeSink().send);
    const b = makeSink();
    room.join(participant({ sessionId: "b", replicaId: 2 }), b.send);

    room.leave("a", PresenceLeaveReason.CLEAN);
    expect(b.received).toEqual([{ kind: "presenceLeave", replicaId: 1, reason: PresenceLeaveReason.CLEAN }]);
    expect(room.size).toBe(1);
  });

  it("leave is idempotent — a second call for an already-removed session is a silent no-op", () => {
    const room = new PresenceRoom();
    room.join(participant({ sessionId: "a", replicaId: 1 }), makeSink().send);
    const b = makeSink();
    room.join(participant({ sessionId: "b", replicaId: 2 }), b.send);

    room.leave("a", PresenceLeaveReason.CLEAN);
    b.received.length = 0;
    room.leave("a", PresenceLeaveReason.STALE); // e.g. the socket's own later 'close' event
    expect(b.received).toHaveLength(0);
  });

  it("handleUpdate relays a client's own presenceUpdate to peers with the real replicaId filled in", () => {
    const room = new PresenceRoom();
    room.join(participant({ sessionId: "a", replicaId: 7 }), makeSink().send);
    const b = makeSink();
    room.join(participant({ sessionId: "b", replicaId: 2 }), b.send);

    room.handleUpdate("a", {
      kind: "presenceUpdate",
      replicaId: 0, // as the client itself always sends it
      anchor: { c: 5, r: 7 },
      focus: { c: 5, r: 7 },
      collapsed: true,
    });

    expect(b.received).toEqual([
      { kind: "presenceUpdate", replicaId: 7, anchor: { c: 5, r: 7 }, focus: { c: 5, r: 7 }, collapsed: true },
    ]);
  });

  it("handleUpdate never echoes back to the sender itself", () => {
    const room = new PresenceRoom();
    const a = makeSink();
    room.join(participant({ sessionId: "a", replicaId: 1 }), a.send);
    room.handleUpdate("a", { kind: "presenceUpdate", replicaId: 0, anchor: null, focus: null, collapsed: true });
    expect(a.received).toHaveLength(0);
  });

  it("handleUpdate silently drops updates once a session exceeds the server-side 20/s ceiling — never queues them", () => {
    const room = new PresenceRoom();
    room.join(participant({ sessionId: "a", replicaId: 1 }), makeSink().send);
    const b = makeSink();
    room.join(participant({ sessionId: "b", replicaId: 2 }), b.send);

    const nowMs = 1_000_000;
    for (let i = 0; i < 30; i++) {
      room.handleUpdate(
        "a",
        { kind: "presenceUpdate", replicaId: 0, anchor: null, focus: null, collapsed: true },
        nowMs, // all within the SAME 1-second window
      );
    }
    // Server ceiling is 20/s (presenceManager.ts's own PRESENCE_SERVER_RULE) — 30 attempts in the
    // same instant must not all land; excess is dropped, not buffered for later delivery.
    expect(b.received.length).toBe(20);

    // A later window admits more, proving this is a genuine sliding window, not a permanent cutoff.
    room.handleUpdate(
      "a",
      { kind: "presenceUpdate", replicaId: 0, anchor: null, focus: null, collapsed: true },
      nowMs + 2000,
    );
    expect(b.received.length).toBe(21);
  });

  it("handleUpdate for a non-member session is a silent no-op, never throws", () => {
    const room = new PresenceRoom();
    const b = makeSink();
    room.join(participant({ sessionId: "b", replicaId: 2 }), b.send);
    expect(() =>
      room.handleUpdate("ghost", { kind: "presenceUpdate", replicaId: 0, anchor: null, focus: null, collapsed: true }),
    ).not.toThrow();
    expect(b.received).toHaveLength(0);
  });
});
