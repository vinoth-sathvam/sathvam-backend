-- Push notification subscriber tokens
create table if not exists push_tokens (
  id           bigint generated always as identity primary key,
  platform     text not null check (platform in ('web', 'android')),
  endpoint     text,
  p256dh       text,
  auth_key     text,
  fcm_token    text,
  customer_id  bigint,
  user_agent   text,
  created_at   timestamptz default now(),
  last_seen_at timestamptz default now(),
  active       boolean default true,
  constraint push_tokens_endpoint_unique unique nulls not distinct (endpoint),
  constraint push_tokens_fcm_unique unique nulls not distinct (fcm_token)
);

create index if not exists push_tokens_platform_idx on push_tokens(platform);
create index if not exists push_tokens_active_idx on push_tokens(active);

-- Push notification campaigns
create table if not exists push_campaigns (
  id           bigint generated always as identity primary key,
  title        text not null,
  body         text not null,
  icon         text default '/icon-192.png',
  image        text,
  url          text default '/',
  template     text not null check (template in ('new_product','offer','health_tip','flash_sale','custom')),
  platform     text not null default 'all' check (platform in ('all','web','android')),
  status       text not null default 'draft' check (status in ('draft','sending','sent','failed')),
  sent_web     int  default 0,
  sent_android int  default 0,
  failed_count int  default 0,
  created_by   text,
  created_at   timestamptz default now(),
  sent_at      timestamptz
);
