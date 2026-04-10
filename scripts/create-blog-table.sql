-- Run this in your Supabase SQL Editor
-- Go to: supabase.com → your project → SQL Editor → New Query → paste this → Run

CREATE TABLE IF NOT EXISTS blog_posts (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title        TEXT NOT NULL,
  slug         TEXT UNIQUE NOT NULL,
  excerpt      TEXT,
  content      TEXT,
  keywords     TEXT[] DEFAULT '{}',
  category     TEXT DEFAULT 'health',
  author       TEXT DEFAULT 'Sathvam Team',
  read_time    INT DEFAULT 5,
  cover_image  TEXT,
  published    BOOLEAN DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS blog_posts_slug_idx        ON blog_posts(slug);
CREATE INDEX IF NOT EXISTS blog_posts_published_idx   ON blog_posts(published, published_at DESC);
CREATE INDEX IF NOT EXISTS blog_posts_category_idx    ON blog_posts(category);

-- Allow public read access (no auth needed for website)
ALTER TABLE blog_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read published posts"
  ON blog_posts FOR SELECT
  USING (published = true);

CREATE POLICY "Service role full access"
  ON blog_posts FOR ALL
  USING (true)
  WITH CHECK (true);
