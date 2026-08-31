// API/Protocol/Data Design Spec v1.0 §2.8 — version_marks and
// audit_runs. DDL verbatim from the spec, kept as one migration file
// because the spec itself presents them as one section. See
// 1788134400000_create-users.js for why this file is ESM and why the DDL is
// otherwise unmodified.

export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TYPE version_kind AS ENUM ('auto', 'manual', 'restore');

    CREATE TABLE version_marks (
        id           UUID         PRIMARY KEY,
        document_id  UUID         NOT NULL REFERENCES documents(id),
        seq          BIGINT       NOT NULL,
        kind         version_kind NOT NULL,
        label        TEXT,
        created_by   UUID         REFERENCES users(id),   -- NULL for kind='auto'
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
    CREATE INDEX version_marks_doc_idx ON version_marks (document_id, seq DESC);

    CREATE TABLE audit_runs (
        id              UUID        PRIMARY KEY,
        document_id     UUID        NOT NULL REFERENCES documents(id),
        replayed_to_seq BIGINT      NOT NULL,
        result          TEXT        NOT NULL CHECK (result IN ('ok','mismatch','error')),
        divergence_seq  BIGINT,     -- first seq at which replay diverged, when known
        detail          TEXT,
        ran_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_runs_bad_idx ON audit_runs (document_id, ran_at DESC) WHERE result <> 'ok';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE audit_runs;
    DROP TABLE version_marks;
    DROP TYPE version_kind;
  `);
};
