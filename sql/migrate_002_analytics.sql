-- Migration 002: Analytics & Abandoned Cart tracking
-- Run in Supabase SQL Editor before deploying the backend update

-- 1. store_analytics — generic key-value store for aggregated analytics data
--    Keys used: 'visits', 'page_views', 'product_views'
CREATE TABLE IF NOT EXISTS store_analytics (
  key         TEXT PRIMARY KEY,
  data        JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 2. abandoned_carts — tracks active shopping carts (not yet ordered)
CREATE TABLE IF NOT EXISTS abandoned_carts (
  session_id   TEXT PRIMARY KEY,
  items        JSONB NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),
  recovered    BOOLEAN DEFAULT FALSE,
  recovered_at TIMESTAMPTZ
);

-- Index for fast queries on recovered status and updated_at
CREATE INDEX IF NOT EXISTS abandoned_carts_recovered_idx ON abandoned_carts(recovered, updated_at DESC);
