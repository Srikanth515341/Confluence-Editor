// Local-dev seed data (Phase 15 scope: "Seed script for local
// development"). Idempotent — safe to run repeatedly against the same
// database (ON CONFLICT DO NOTHING keyed on the fixed seed UUIDs below).
//
// password_hash is a literal placeholder string, NOT a real argon2id hash
// — password hashing doesn't exist until auth (Phases 26-29). The column
// is NOT NULL per API Spec §2.2, so seeding needs *some* value; this one
// is deliberately unusable as a real hash so it can never be mistaken for
// one.

import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";

const SEED_USER_ID = "00000000-0000-4000-8000-000000000001";
const SEED_DOCUMENT_ID = "00000000-0000-4000-8000-000000000002";
const PLACEHOLDER_PASSWORD_HASH = "unset:not-a-real-hash:phase-26-29";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [SEED_USER_ID, "dev@example.com", "Dev User", PLACEHOLDER_PASSWORD_HASH],
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
