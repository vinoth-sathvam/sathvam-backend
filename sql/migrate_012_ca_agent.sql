-- CA Agent findings table
-- Stores issues raised by the automated Chartered Accountant agent

CREATE TABLE IF NOT EXISTS ca_agent_findings (
  id            BIGSERIAL PRIMARY KEY,
  run_id        TEXT        NOT NULL,          -- e.g. "2026-04-20T09:00:00"
  category      TEXT        NOT NULL,          -- AR | AP | Bank | GST | Payroll | Expenses | Revenue | Compliance
  severity      TEXT        NOT NULL,          -- critical | high | medium | low | info
  title         TEXT        NOT NULL,
  detail        TEXT        NOT NULL,
  amount        NUMERIC(14,2),                 -- monetary amount if relevant
  resolved      BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_by   TEXT,
  resolved_at   TIMESTAMPTZ,
  ai_analysis   TEXT,                          -- Claude's narrative for this run
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ca_agent_findings_run_id_idx ON ca_agent_findings(run_id);
CREATE INDEX IF NOT EXISTS ca_agent_findings_severity_idx ON ca_agent_findings(severity);
CREATE INDEX IF NOT EXISTS ca_agent_findings_resolved_idx ON ca_agent_findings(resolved);
CREATE INDEX IF NOT EXISTS ca_agent_findings_created_at_idx ON ca_agent_findings(created_at DESC);
