-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008: WhatsApp Business API — message store
-- Run once in Supabase SQL editor
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id             BIGSERIAL PRIMARY KEY,
  wa_message_id  TEXT,                          -- Meta message ID (nullable for legacy)
  phone          TEXT NOT NULL,                 -- E.164 digits, e.g. "919876543210"
  contact_name   TEXT,                          -- Display name from WhatsApp profile
  direction      TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  type           TEXT DEFAULT 'text',           -- text | template | image | document | audio | etc.
  content        TEXT,                          -- Text body or description like "[Image]"
  status         TEXT DEFAULT 'sent',           -- sent | delivered | read | received | failed
  sent_by        TEXT,                          -- admin username or "system" for auto-sends
  read_at        TIMESTAMPTZ,                   -- when admin opened this conversation
  timestamp      TIMESTAMPTZ DEFAULT NOW(),     -- time of the message
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_wa_phone       ON whatsapp_messages(phone);
CREATE INDEX IF NOT EXISTS idx_wa_timestamp   ON whatsapp_messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_wa_unread      ON whatsapp_messages(direction, read_at) WHERE direction = 'inbound';
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_msg_id ON whatsapp_messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
