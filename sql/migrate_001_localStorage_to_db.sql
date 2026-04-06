-- Migration: Move localStorage-only data to Supabase
-- Run this in Supabase SQL Editor before deploying the updated backend/frontend

-- 1. Purchases table (was: localStorage key "of_p3")
create table if not exists purchases (
  id          bigint generated always as identity primary key,
  date        date not null,
  material    text not null default '',
  qty         numeric(10,3) not null default 0,
  price_per_kg numeric(10,2) not null default 0,
  notes       text default '',
  created_at  timestamptz default now()
);

-- 2. Flour batches table (was: localStorage key "flour_batches")
create table if not exists flour_batches (
  id                text primary key,
  date              date not null,
  commodity         text not null default '',
  commodity_id      text default '',
  input_kg          numeric(10,3) default 0,
  raw_packing_kg    numeric(10,3) default 0,
  cleaned_kg        numeric(10,3) default 0,
  sprouted_kg       numeric(10,3) default 0,
  sent_to_mill_kg   numeric(10,3) default 0,
  flour_received_kg numeric(10,3) default 0,
  raw_rate_per_kg   numeric(10,2) default 0,
  grinding_charge   numeric(10,2) default 0,
  logistics         numeric(10,2) default 0,
  label_cost        numeric(10,2) default 2,
  local_profit      numeric(10,2) default 25,
  web_profit        numeric(10,2) default 20,
  intl_profit       numeric(10,2) default 15,
  courier           numeric(10,2) default 80,
  notes             text default '',
  created_by        text default '',
  created_at        timestamptz default now()
);

-- 3. Webstore orders table (was: localStorage key "sw_orders")
create table if not exists webstore_orders (
  id         text primary key,
  order_no   text not null default '',
  date       date not null,
  customer   jsonb default '{}',
  items      jsonb default '[]',
  subtotal   numeric(10,2) default 0,
  gst        numeric(10,2) default 0,
  shipping   numeric(10,2) default 0,
  total      numeric(10,2) default 0,
  status     text default 'confirmed',
  channel    text default 'website',
  notes      text default '',
  created_at timestamptz default now()
);

-- 4. Verify settings table exists (should already exist)
-- The following keys will be stored as JSON in the settings table:
--   pkg_settings     (was: localStorage "of_pkg")
--   intl_settings    (was: localStorage "of_intl")
--   web_settings     (was: localStorage "of_web_pricing")
--   retail_settings  (was: localStorage "of_retail_pricing")
--   prod_settings    (was: localStorage "of_prod_settings")
--   prod_packed      (was: localStorage "of_prod_packed")
--   price_history    (was: localStorage "of_price_hist")
--   b2b_products     (was: localStorage "of_b2b_products")
-- No schema changes needed for settings table.
