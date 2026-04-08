-- Internal messaging between admin and managers
CREATE TABLE IF NOT EXISTS internal_messages (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  thread_id  UUID NOT NULL,
  from_user  VARCHAR(100) NOT NULL,
  from_role  VARCHAR(50)  NOT NULL,
  to_user    VARCHAR(100),          -- null = broadcast to all of that role
  to_role    VARCHAR(50)  NOT NULL,
  message    TEXT         NOT NULL,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_internal_messages_thread   ON internal_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_internal_messages_to_role  ON internal_messages(to_role, read_at);
CREATE INDEX IF NOT EXISTS idx_internal_messages_from_role ON internal_messages(from_role, created_at);
