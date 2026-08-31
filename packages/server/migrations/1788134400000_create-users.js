// API/Protocol/Data Design Spec v1.0 §2.2 — users. DDL below is verbatim
// from the spec (Phase 15 instructions: "do not modify column names,
// types, or constraints"). ESM (`export`, not `module.exports`) because
// packages/server/package.json declares `"type": "module"`, and
// node-pg-migrate loads migration files as ES modules under that setting.

export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE users (
        id             UUID        PRIMARY KEY,
        email          TEXT        NOT NULL,
        display_name   TEXT        NOT NULL,
        password_hash  TEXT        NOT NULL,      -- argon2id
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT users_email_lower_uq UNIQUE (email)
    );
    CREATE UNIQUE INDEX users_email_ci_idx ON users (lower(email));
  `);
};

export const down = (pgm) => {
  // DROP TABLE also drops users_email_lower_uq (a table constraint) and
  // users_email_ci_idx (an index owned by the table) — no separate DROP
  // INDEX/DROP CONSTRAINT needed.
  pgm.sql(`DROP TABLE users;`);
};
