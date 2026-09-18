-- Migration 034: WebAuthn credentials for fingerprint/passkey login
-- Run in PostgreSQL (Supabase SQL Editor or psql)

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  credential_id   TEXT PRIMARY KEY,                           -- base64url credential ID
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key      TEXT NOT NULL,                              -- base64url encoded public key
  counter         BIGINT NOT NULL DEFAULT 0,                  -- signature counter (replay protection)
  transports      TEXT[],                                     -- e.g. {'internal','hybrid'}
  device_name     TEXT DEFAULT 'Fingerprint',                 -- user-friendly label
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webauthn_user_id ON webauthn_credentials(user_id);

-- Challenge store (short-lived, cleaned up periodically)
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE, -- NULL for login challenges
  challenge       TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('registration', 'authentication')),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
