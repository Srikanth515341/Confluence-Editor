// Phase 27 — REST document lifecycle (API Spec §9.2: "Idempotency-Key honoured for 24 hours.
// Same key + same body -> return the stored response with the original status. Same key +
// DIFFERENT body -> 409 idempotency_key_reused"). UNLIKE Phase 15's own eight verbatim-DDL
// tables, no literal DDL was supplied for this table — §9.2's text describes REQUIRED BEHAVIOR,
// not a schema. This is this phase's own reasonable, disclosed design:
//
//   - Scoped by (user_id, endpoint, key), not by key alone — an Idempotency-Key header is only
//     ever meaningful relative to a specific caller and a specific endpoint (this phase's own
//     POST /v1/documents is the only endpoint that currently uses one, but the schema doesn't
//     hardcode that assumption, so a later phase adding idempotency to another endpoint needs no
//     schema change).
//   - `request_body_hash` (not the raw body) is what "same body" is checked against — a SHA-256
//     of a canonicalized (key-sorted) JSON serialization (documentService.ts's own
//     `canonicalJsonStringify`), so key ORDER in the original request can never spuriously
//     trigger a false 409.
//   - `response_status`/`response_body` are the FULL captured response — a replayed request
//     must return something byte-identical to the original 201, not merely "the same status."
//   - 24-hour expiry (API Spec §9.2's literal number) is enforced at QUERY time
//     (`created_at > now() - interval '24 hours'`, db/documentStore.ts), not by a scheduled
//     deletion job — a row past that window is simply treated as if it never existed (a fresh
//     create with the same key is then allowed), matching this project's own established
//     "disclosed, not the biggest scope creep" precedent for unbounded-but-slow-growing state
//     (rateLimiter.ts's own in-memory map, the `snapshots` table's own lack of a retention
//     policy).

export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE idempotency_keys (
        user_id            UUID        NOT NULL REFERENCES users(id),
        endpoint           TEXT        NOT NULL,
        key                TEXT        NOT NULL,
        request_body_hash  TEXT        NOT NULL,
        response_status    INTEGER     NOT NULL,
        response_body      JSONB       NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, endpoint, key)
    );
  `);
};

export const down = (pgm) => {
  pgm.sql(`DROP TABLE idempotency_keys;`);
};
