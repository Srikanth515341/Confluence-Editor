// Local-dev seed data (Phase 15 scope: "Seed script for local
// development"). Idempotent — safe to run repeatedly against the same
// database (ON CONFLICT DO NOTHING keyed on the fixed seed UUIDs below).
//
// password_hash is now (Phase 26) a REAL Argon2id hash of a fixed, published dev-only password
// — this is the ONE user this project's own seed data is meant to be able to log in as, via the
// new POST /v1/auth/login (API Spec §4.1). Never used before this phase, since password hashing
// didn't exist until now; `operationStore.ts`'s own SEPARATE `SYSTEM_USER_PASSWORD_HASH_PLACEHOLDER`
// (auto-provisioned WS-connection users, unrelated to real login) is untouched by this change —
// that remains exactly the disclosed, non-loggable-in placeholder it always was.

import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { hashPassword } from "../src/passwordHash.js";

const SEED_USER_ID = "00000000-0000-4000-8000-000000000001";
const SEED_DOCUMENT_ID = "00000000-0000-4000-8000-000000000002";
/** Dev-only, published in this very file — never use this account/password outside local development. */
export const SEED_USER_EMAIL = "dev@example.com";
export const SEED_USER_PASSWORD = "dev-password-not-for-production";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    const passwordHash = await hashPassword(SEED_USER_PASSWORD);
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [SEED_USER_ID, SEED_USER_EMAIL, "Dev User", passwordHash],
    );

    await pool.query(
      `INSERT INTO documents (id, title, owner_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [SEED_DOCUMENT_ID, "Seed Document", SEED_USER_ID],
    );

    // docperm_single_owner_idx (0003_create-document-permissions.js) means
    // this INSERT is the only legal way this document ever gets an owner
    // row — a second one for the same document_id is rejected by the DB.
    await pool.query(
      `INSERT INTO document_permissions (document_id, user_id, role, granted_by)
       VALUES ($1, $2, 'owner', $3)
       ON CONFLICT (document_id, user_id) DO NOTHING`,
      [SEED_DOCUMENT_ID, SEED_USER_ID, SEED_USER_ID],
    );

    console.log(
      JSON.stringify({
        message: "seed.complete",
        userId: SEED_USER_ID,
        documentId: SEED_DOCUMENT_ID,
        loginEmail: SEED_USER_EMAIL,
        loginPassword: SEED_USER_PASSWORD, // dev-only, fixed, published above — never a real secret
      }),
    );
  } finally {
    await pool.end();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
