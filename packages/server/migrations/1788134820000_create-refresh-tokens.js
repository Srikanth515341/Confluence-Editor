// Phase 26 — Authentication and sessions (API Spec §4.2, PRD/Test Plan's refresh-token-rotation
// theft-detection requirement: "reusing a rotated refresh token revokes the whole family").
//
// UNLIKE Phases 15's own seven migrations, this table's DDL is NOT verbatim from an approved
// spec document — no such DDL was supplied for this phase (the API/Protocol/Data Spec text
// pasted in for Phase 26 describes the REQUIRED BEHAVIOR of refresh rotation/family revocation
// in prose, not a literal CREATE TABLE statement, unlike §2.2-§2.8's own verbatim-DDL phases).
// This schema is this phase's own reasonable, disclosed design to satisfy that behavior:
//
//   - `family_id` groups every token ever issued from one login through all of its subsequent
//     rotations. Revoking a family (setting `revoked_at` on every row sharing that family_id)
//     is what "reusing a rotated token revokes the WHOLE family" (not just the reused row)
//     requires.
//   - `token_hash`, never a raw token — same principle as `users.password_hash` (Phase 26's own
//     brief, quoting that exact analogy). The raw, high-entropy refresh token only ever exists
//     in the HttpOnly cookie and in server memory for the instant it's generated/compared; only
//     an HMAC-SHA256 digest (keyed by JWT_REFRESH_SECRET, src/tokens.ts) is ever persisted, so a
//     database dump alone can never be replayed as a working refresh token.
//   - `used_at` (set the instant a token is presented to /refresh and successfully rotated) is
//     what distinguishes "a token being redeemed for the first, legitimate time" from "someone
//     is replaying an already-rotated token" — the theft-detection signal itself.
//   - `revoked_at` is set on every row in a family the instant reuse is detected (or on an
//     explicit /logout) — checked FIRST on every /refresh attempt, before `used_at`, so a
//     revoked family can never be revived by presenting some other still-technically-unused
//     token from the same (already compromised) family.
//
// `refresh_tokens_family_idx` exists because family revocation is a bulk
// `UPDATE ... WHERE family_id = $1` touching every row in a family — the exact query the
// theft-detection path runs, and the one query in this table's whole lifecycle that is NOT a
// single-row lookup by `token_hash` (already unique, and therefore already indexed).

export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE refresh_tokens (
        id           UUID        PRIMARY KEY,
        family_id    UUID        NOT NULL,
        user_id      UUID        NOT NULL REFERENCES users(id),
        token_hash   TEXT        NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at   TIMESTAMPTZ NOT NULL,
        used_at      TIMESTAMPTZ,
        revoked_at   TIMESTAMPTZ,
        CONSTRAINT refresh_tokens_token_hash_uq UNIQUE (token_hash)
    );
    CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`DROP TABLE refresh_tokens;`);
};
