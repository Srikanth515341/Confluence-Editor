// API/Protocol/Data Design Spec v1.0 §2.3 — documents. DDL verbatim from
// the spec, including the source's own inline comments (kept as literal
// SQL comments in the migration body, not paraphrased) — see
// packages/server/migrations/1788134400000_create-users.js for why this file is
// ESM and why the DDL is otherwise unmodified.

export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE documents (
        id                UUID        PRIMARY KEY,
        title             TEXT        NOT NULL DEFAULT 'Untitled',
        owner_id          UUID        NOT NULL REFERENCES users(id),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

        -- Monotonic per-document operation sequence (PRD FR-PS-3). This is the
        -- ONLY sequence a client ever names; it is what CATCHUP ranges over.
        -- It orders the log. It does NOT participate in convergence: OBSEQ reaches
        -- the same state regardless of the order operations are applied, so this
        -- number is for gap detection and replay, never for merge arbitration.
        current_seq       BIGINT      NOT NULL DEFAULT 0,

        -- Allocator for OBSEQ replica identifiers (Engine Spec §3.2).
        -- CORRECTNESS-CRITICAL. Engine Spec I1 requires every identifier ever minted
        -- in this document to be unique. Identifiers are (counter, replica), and two
        -- sessions that reused a replica id could mint colliding identifiers even
        -- years apart, which breaks convergence silently. Therefore this counter is
        -- MONOTONIC FOR THE LIFETIME OF THE DOCUMENT and is never reset, never
        -- reclaimed, and never reused when a session ends.
        next_replica_id   BIGINT      NOT NULL DEFAULT 1,

        -- Observability for metadata-exhaustion threat and PRD M8.
        -- Maintained by the coordinator, not authoritative; the engine is.
        structure_size    INTEGER     NOT NULL DEFAULT 0,
        tombstone_count   INTEGER     NOT NULL DEFAULT 0,

        -- Soft-delete of ACCESS, not of content. PRD FR-VH-5 forbids destroying
        -- history; removing a document hides it and revokes sessions, and the
        -- operation log is retained.
        access_revoked_at TIMESTAMPTZ
    );
    CREATE INDEX documents_owner_idx ON documents (owner_id) WHERE access_revoked_at IS NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`DROP TABLE documents;`);
};
