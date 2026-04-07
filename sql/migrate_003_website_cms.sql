-- Migration 003: Website CMS — product images & content management
-- Run in Supabase SQL Editor

-- 1. Add image_url column to products table
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT NULL;

-- 2. Add hsn_code and description if not already present (used by website product pages)
ALTER TABLE products ADD COLUMN IF NOT EXISTS hsn_code TEXT DEFAULT NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT DEFAULT NULL;
