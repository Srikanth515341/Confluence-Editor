// API/Protocol/Data Design Spec v1.0 §2.7 — snapshots. DDL verbatim from
// the spec. See 1788134400000_create-users.js for why this file is ESM and why
// the DDL is otherwise unmodified.
//
// snapshots_latest_idx (document_id, seq DESC) serves "latest snapshot
// at or before target seq" — the first step of every history
// reconstruction and of coordinator warm start (Phase 15 scope table).

export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE snapshots (
        document_id  UUID        NOT NULL REFERENCES documents(id),
        seq          BIGINT      NOT NULL,   -- state AFTER applying operations up to and including seq

        -- Materialized visible text: engine.materialize() at this seq.
        -- This is what the integrity audit compares a log replay against.
        content      TEXT        NOT NULL,

        -- Serialized OBSEQ structure including tombstones, block-encoded (later
        -- phase). Lets a coordinator resume without replaying from genesis, and
        -- lets a fresh client be seeded in one message.
        structure    BYTEA       NOT NULL,

        op_count     INTEGER     NOT NULL,   -- operations since the previous snapshot
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (document_id, seq)
    );

    -- "Latest snapshot at or before target seq" — the first step of every history
    -- reconstruction and of coordinator warm start.
    CREATE INDEX snapshots_latest_idx ON snapshots (document_id, seq DESC);
  `);
};

export const down = (pgm) => {
  pgm.sql(`DROP TABLE snapshots;`);
};
