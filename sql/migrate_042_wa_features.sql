-- WhatsApp feature enhancements
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS quoted_message_id TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS quoted_content TEXT;
