-- Migration 011: Single-session enforcement for admin users
-- Run in Supabase SQL Editor before deploying the backend update
--
-- Adds session_token column to users table.
-- On each login a new random token is generated and stored here + embedded in the JWT.
-- The auth middleware verifies the JWT token matches the DB value on every request.
-- When a user logs in on a second device, the DB token changes → old device gets 401.

ALTER TABLE users ADD COLUMN IF NOT EXISTS session_token TEXT DEFAULT NULL;

-- Index for fast lookup (auth middleware runs on every request)
CREATE INDEX IF NOT EXISTS idx_users_session_token ON users(id, session_token);
