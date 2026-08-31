// API/Protocol/Data Design Spec v1.0 §2.4 — document_permissions. DDL
// verbatim from the spec. See 1788134400000_create-users.js for why this file is
// ESM and why the DDL is otherwise unmodified.
//
// docperm_single_owner_idx is the load-bearing constraint of this table
// (PRD FR-PM-1/FR-PM-6, Phase 15's own scope table): a partial unique
// index on (document_id) WHERE role = 'owner' makes a zero- or
// two-owner state UNCOMMITTABLE. Ownership transfer (revoke old owner's
// row + insert/promote new owner, or two UPDATEs) can therefore never
// leave the database in a two-owner state even under a crash mid-
// transaction or a race between two concurrent transfer attempts —
// the database enforces the atomicity, not application-level sequencing
// or locking.

export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TYPE document_role AS ENUM ('owner', 'editor', 'viewer');

    CREATE TABLE document_permissions (
        document_id  UUID          NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id      UUID          NOT NULL REFERENCES users(id),
        role         document_role NOT NULL,
        granted_by   UUID          NOT NULL REFERENCES users(id),
        granted_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
        PRIMARY KEY (document_id, user_id)
    );

    -- Supports "list documents I can see" without scanning documents.
    CREATE INDEX docperm_user_idx ON document_permissions (user_id, document_id);

    -- PRD FR-PM-1: exactly one owner per document, at all times. Enforced by the
    -- database rather than by application code, because FR-PM-6 requires ownership
    -- transfer to be atomic and a check-then-write in application code is not.
    CREATE UNIQUE INDEX docperm_single_owner_idx
        ON document_permissions (document_id) WHERE role = 'owner';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE document_permissions;
    DROP TYPE document_role;
  `);
};
