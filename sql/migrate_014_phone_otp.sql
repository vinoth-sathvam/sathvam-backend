-- Phone OTP 2FA for customers (WhatsApp-based, no app needed)
-- Run in Supabase Dashboard > SQL Editor

ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_otp_enabled BOOLEAN DEFAULT false;
