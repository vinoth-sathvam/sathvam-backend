-- Migration 005: Add cake_type_key to products table
-- cake_type_key links a cake product to its oil batch stock source
-- Values: 'Groundnut' | 'Sesame' | 'Coconut' | NULL

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS cake_type_key TEXT DEFAULT NULL;
