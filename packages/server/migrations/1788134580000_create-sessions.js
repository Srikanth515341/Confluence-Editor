// API/Protocol/Data Design Spec v1.0 §2.5 — sessions. DDL verbatim from
// the spec. See 1788134400000_create-users.js for why this file is ESM and why
// the DDL is otherwise unmodified.
//
// sessions_replica_uq enforces Engine Spec I1 (identifier uniqueness) at
// the storage layer, on top of documents.next_replica_id's allocation
// discipline (0002_create-documents.js) — belt and suspenders, same
// reasoning as this project's two independent engine-purity checks
// (CLAUDE.md, Phase 0).
//
// sessions_frontier_idx exists because the GC stability-frontier query
// (MIN(last_ack_seq) across sessions with last_seen_at within the active
// window, per document) runs every 60 seconds per document — see the
// column comment on last_ack_seq below for what breaks if this is wrong.

export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE sessions (
        id                UUID        PRIMARY KEY,
        user_id           UUID        NOT NULL REFERENCES users(id),
        document_id       UUID        NOT NULL REFERENCES documents(id),

        -- The OBSEQ replica id for this session, allocated from
        -- documents.next_replica_id. Unique per document FOREVER (see documents table).
        replica_id        BIGINT      NOT NULL,

        role_at_connect   document_role NOT NULL,
        connected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

        -- Highest document sequence this session has confirmed receiving.
        -- This column IS the acknowledgement watermark w(r) of Engine Spec
        -- Definition 7.1. The garbage-collection stability frontier is the MIN of
        -- this column across active sessions. Getting this wrong does not corrupt
        -- anything immediately; it causes GC to collect a tombstone another
        -- replica still needs, which strands that replica's operations forever.
        last_ack_seq      BIGINT      NOT NULL DEFAULT 0,

        -- Liveness. Advanced by PING. Drives BOTH presence expiry (8s) AND
        -- active-session eviction for GC (10 min). These two timers are DIFFERENT
        -- and must not be conflated: presence must disappear promptly, but the
        -- session must stay in the GC frontier for the full offline window or a
        -- returning client loses its anchors.
        last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        disconnected_at   TIMESTAMPTZ,

        CONSTRAINT sessions_replica_uq UNIQUE (document_id, replica_id)
    );

    -- The stability-frontier query runs on every GC cycle.
    CREATE INDEX sessions_frontier_idx ON sessions (document_id, last_seen_at, last_ack_seq);
  `);
};

export const down = (pgm) => {
  pgm.sql(`DROP TABLE sessions;`);
};
