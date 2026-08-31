// API/Protocol/Data Design Spec v1.0 §2.6 — operations, the append-only
// log. DDL verbatim from the spec. See 1788134400000_create-users.js for why this
// file is ESM and why the DDL is otherwise unmodified.
//
// PRIMARY KEY (document_id, seq) is deliberately in that column order —
// it is what lets THE reconnection query
//     SELECT ... FROM operations WHERE document_id = $1 AND seq > $2 ORDER BY seq
// be served as a primary-key range scan with no secondary index (Phase
// 15 DoD: verified via EXPLAIN in schema.db.test.ts).
//
// operations_stamp_uq is duplicate-suppression layer 3 (API Spec §9.1):
// even if the protocol's ALREADY_HAVE tracking and the engine's own
// applyRemote() idempotence check (Engine Spec §4.5/§6.3, keyed on the
// operation's own id) were both buggy, a retried operation still cannot
// be committed twice at the storage layer.
//
// operations_no_update / operations_no_delete make the append-only
// guarantee (PRD FR-PS-1) structural rather than a matter of application
// code discipline — a future migration or a bug in some later phase's
// write path cannot quietly introduce a mutation path, because there is
// no UPDATE/DELETE path for Postgres itself to execute; both rules
// rewrite the statement to a silent no-op.

export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TYPE op_kind AS ENUM ('insert', 'delete', 'undelete');

    CREATE TABLE operations (
        document_id     UUID        NOT NULL REFERENCES documents(id),
        seq             BIGINT      NOT NULL,

        -- The ORIGIN STAMP: the operation's globally unique identity, taken from
        -- the OBSEQ identifier rather than a generated UUID.
        -- stamp_r = replica that minted it, stamp_c = its Lamport counter.
        stamp_r         BIGINT      NOT NULL,
        stamp_c         BIGINT      NOT NULL,

        -- Attribution is taken from the AUTHENTICATED SESSION and never from the
        -- client-supplied payload. A client that puts another user's id in a
        -- frame has that field overwritten here, not honoured.
        author_session  UUID        NOT NULL REFERENCES sessions(id),
        author_user     UUID        NOT NULL REFERENCES users(id),

        kind            op_kind     NOT NULL,
        payload         BYTEA       NOT NULL,   -- the binary op body, verbatim
        committed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- observability ONLY;
                                    -- never read for ordering (PRD FR-CE-2)

        PRIMARY KEY (document_id, seq)
    );

    -- THE reconnection query:
    --     SELECT ... FROM operations
    --      WHERE document_id = $1 AND seq > $2 ORDER BY seq LIMIT $3
    -- is served directly by the primary key. No secondary index is needed for it,
    -- and the range scan is sequential. This is why seq is the second PK column.

    -- Duplicate suppression at the storage layer (layer 3). A retried operation
    -- cannot be double-committed even if both the protocol's ALREADY_HAVE set and
    -- the engine's idempotence check were buggy.
    CREATE UNIQUE INDEX operations_stamp_uq ON operations (document_id, stamp_r, stamp_c);

    -- PRD FR-PS-1: append-only. No UPDATE or DELETE path exists in application code.
    -- Enforced at the database so a future migration cannot quietly introduce one.
    CREATE RULE operations_no_update AS ON UPDATE TO operations DO INSTEAD NOTHING;
    CREATE RULE operations_no_delete AS ON DELETE TO operations DO INSTEAD NOTHING;
  `);
};

export const down = (pgm) => {
  // DROP TABLE also drops operations_stamp_uq, operations_no_update, and
  // operations_no_delete — all owned by the table.
  pgm.sql(`
    DROP TABLE operations;
    DROP TYPE op_kind;
  `);
};
