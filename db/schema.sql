-- Generated from expo-hermes; edit the private source, not this mirror.
-- Users. Minted per claim, no real auth behind them (see claim+api.ts).
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Laptops. One row per paired machine running a Hermes Agent. Called
-- `profiles` on the wire for historical reasons and kept that way on purpose --
-- `profile_id` is the WebSocket route, the Redis channel key, the api_keys
-- scope, the durable-queue partition key, and the AEAD associated data on
-- every sealed frame (see issue 60 and lib/crypto.ts buildAad).
--
-- `self_serve` marks a Laptop provisioned through the open, unauthenticated
-- POST /api/pair/provision. It is an AUTHORIZATION BOUNDARY, not a label:
-- that endpoint re-mints invites without ADMIN_SECRET and must never touch a
-- Laptop it did not create. It replaces the old tenant_id = 'tenant_selfserve'
-- check, which was the only thing tenants were ever used for.
CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    self_serve BOOLEAN NOT NULL DEFAULT FALSE,
    expo_push_token TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- API keys (device ↔ profile)
CREATE TABLE IF NOT EXISTS api_keys (
    key TEXT PRIMARY KEY,                   -- hb_<32 random bytes hex>
    user_id TEXT NOT NULL REFERENCES users(id),
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    device_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP
);

-- Invites. Strictly single-use: claim+api.ts sets status to 'claimed'
-- unconditionally, and the status guard is what prevents reuse. The
-- max_uses/used_count pair that used to express team links is gone -- no route
-- ever minted one (issue 60). 'revoked' is not a reachable status either: the
-- revoke endpoint was specified but never built.
CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,                    -- inv_<hex>
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    token TEXT UNIQUE NOT NULL,             -- short public token
    secret_hash TEXT NOT NULL,
    status TEXT CHECK(status IN ('active', 'claimed', 'expired')) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    claimed_at TIMESTAMP,
    claimed_by_user_id TEXT,
    claimed_by_device_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token, status);
CREATE INDEX IF NOT EXISTS idx_invites_profile ON invites(profile_id, status);
CREATE INDEX IF NOT EXISTS idx_api_keys_profile ON api_keys(profile_id);

-- Durable delivery buffer for gateway->phone messages (E2E-sealed, relay never
-- decrypts). Store-and-forward so a message survives the phone being offline.
-- Not the source of truth (client SQLite is) — pruned periodically, see server/push.ts.
-- NOTE: db/migrate.ts splits this file on the literal statement-terminator
-- character — comments anywhere in this file must never contain that
-- character, or the migration breaks (see docs/LESSONS.md).
CREATE TABLE IF NOT EXISTS messages (
    profile_id   TEXT NOT NULL REFERENCES profiles(id),
    seq          BIGINT NOT NULL,        -- per-profile monotonic cursor
    msg_id       TEXT NOT NULL,          -- gateway-minted uuid (dedup key)
    sealed_frame TEXT NOT NULL,          -- opaque base64, relay never decrypts
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (profile_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_profile_msgid ON messages(profile_id, msg_id);
CREATE INDEX IF NOT EXISTS idx_messages_profile_seq ON messages(profile_id, seq);

-- Multi-device push support: one profile can have several paired phones, each
-- with its own Expo token. Replaces the old single expo_push_token column
-- (left in place, unused, per additive-only migration policy — never dropped).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS expo_push_tokens TEXT[] NOT NULL DEFAULT '{}';

-- One-time backfill from the old singular column — idempotent (no-op once
-- the token is already present in the array), safe to leave in schema.sql
-- permanently like the rest of this file.
UPDATE profiles SET expo_push_tokens = array_append(expo_push_tokens, expo_push_token)
    WHERE expo_push_token IS NOT NULL AND NOT (expo_push_token = ANY(expo_push_tokens));

-- Sealed attachment blobs (images/files/audio), PRD_Features.md §2.3. Kept
-- separate from `messages` so large binary content never bloats the
-- Redis-pubsub-backed durable-message row. Content is the AEAD-sealed blob
-- (see lib/crypto.ts sealBlob / crypto.py seal_blob) — relay never decrypts.
-- Same no-semicolons-in-comments constraint as the messages table above.
CREATE TABLE IF NOT EXISTS blobs (
    blob_id      TEXT PRIMARY KEY,       -- blob_<hex>
    profile_id   TEXT NOT NULL REFERENCES profiles(id),
    mime         TEXT NOT NULL,
    sealed_blob  BYTEA NOT NULL,         -- opaque ciphertext, relay never decrypts
    bytes        INTEGER NOT NULL,       -- size of sealed_blob, for prune/quota accounting
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_blobs_profile ON blobs(profile_id);
CREATE INDEX IF NOT EXISTS idx_blobs_created ON blobs(created_at);

-- Durable delivery buffer for phone->gateway messages (#41) — the mirror of
-- `messages` above for the opposite direction. Kept as a SEPARATE table
-- rather than a `direction` column on `messages`: that table's PK is
-- (profile_id, seq) with live production data, and adding a direction column
-- would mean a compound-PK migration or sharing one seq space across two
-- independent producers (relay-enqueue vs relay-message) — both riskier than
-- a new additive table. Same E2E-sealed, relay-never-decrypts property.
-- Same no-semicolons-in-comments constraint as the messages table above.
CREATE TABLE IF NOT EXISTS inbound_messages (
    profile_id   TEXT NOT NULL REFERENCES profiles(id),
    seq          BIGINT NOT NULL,        -- per-profile monotonic cursor, own space
    msg_id       TEXT NOT NULL,          -- phone-minted uuid (dedup key)
    sealed_frame TEXT NOT NULL,          -- opaque base64, relay never decrypts
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (profile_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_messages_profile_msgid ON inbound_messages(profile_id, msg_id);
CREATE INDEX IF NOT EXISTS idx_inbound_messages_profile_seq ON inbound_messages(profile_id, seq);

-- Highest `messages.seq` ever evicted (count-cap or age-prune) for this
-- profile's gateway->phone direction (#41). /api/relay/pending compares its
-- caller's `since` cursor against this floor to detect "some messages were
-- pruned before you could fetch them" and return a `gap` flag. Gateway->phone
-- only — the phone is the only side with a chat UI to render a gap notice in.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS messages_floor_seq BIGINT NOT NULL DEFAULT 0;

-- ── Teardown of the multi-user apparatus (issue 60) ────────────────────────
-- This file was additive-only by policy. That policy is deliberately broken
-- here, once: team invites, tenants and the admin/member split were specified
-- but never shipped, and the dead columns read as an unfinished feature.
--
-- Every statement is IF EXISTS, so re-running on each deploy is a no-op after
-- the first. It is still ONE-WAY -- back up before the first deploy that
-- carries this.
--
-- No DO blocks or functions: db/migrate.ts splits this file on the literal
-- statement-terminator character, so a body containing one would break.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS self_serve BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill keyed on the id prefix that POST /api/pair/provision mints, NOT on
-- tenant_id -- that column is dropped further down, and referencing it here
-- would make every later deploy fail on a missing column.
UPDATE profiles SET self_serve = TRUE WHERE id LIKE 'profile_ss_%' AND self_serve = FALSE;

DROP INDEX IF EXISTS idx_invites_email;
ALTER TABLE invites DROP COLUMN IF EXISTS email;
ALTER TABLE invites DROP COLUMN IF EXISTS phone;
ALTER TABLE invites DROP COLUMN IF EXISTS max_uses;
ALTER TABLE invites DROP COLUMN IF EXISTS used_count;
ALTER TABLE invites DROP COLUMN IF EXISTS created_by_user_id;
ALTER TABLE invites DROP COLUMN IF EXISTS revoked_at;
ALTER TABLE invites DROP COLUMN IF EXISTS revoked_by_user_id;
ALTER TABLE invites DROP COLUMN IF EXISTS revoke_reason;
ALTER TABLE users DROP COLUMN IF EXISTS is_admin;

-- tenant_id last: dropping these removes the foreign keys that would
-- otherwise block DROP TABLE tenants.
ALTER TABLE invites DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE users DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE profiles DROP COLUMN IF EXISTS tenant_id;
DROP TABLE IF EXISTS tenants;

-- The status CHECK needs an explicit ALTER. Editing the CREATE TABLE above is
-- not enough: CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so
-- the original 4-state constraint survived the issue-60 deploy on an already
-- provisioned database while a fresh one got 3 states -- exactly the local
-- versus prod drift this file exists to prevent.
--
-- DROP then ADD is the idempotent shape available here. Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS, but DROP ... IF EXISTS followed immediately by
-- ADD is safe to re-run, and both statements run in this order on every deploy.
ALTER TABLE invites DROP CONSTRAINT IF EXISTS invites_status_check;
ALTER TABLE invites ADD CONSTRAINT invites_status_check CHECK (status IN ('active', 'claimed', 'expired'));
