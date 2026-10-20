-- Every email sent through Resend (or skipped / failed), for Admin → Settings →
-- Email. Idempotent (applied on every deploy).
CREATE TABLE IF NOT EXISTS email_logs (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id    text REFERENCES tenants(id) ON DELETE CASCADE,
  to_email     text NOT NULL,
  subject      text NOT NULL,
  category     text NOT NULL,              -- auth | booking | refund | agency | wallet | alert | admin | test | general
  status       text NOT NULL,              -- SENT | FAILED | SKIPPED
  provider_id  text,                       -- Resend email id
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_logs_tenant_idx ON email_logs (tenant_id, created_at DESC);
