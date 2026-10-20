-- supplier_api_logs: captures every outbound TripJack / Riya API call
-- for error analysis in the admin portal.

CREATE TABLE IF NOT EXISTS supplier_api_logs (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id       text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier        supplier_name NOT NULL,
  endpoint        text NOT NULL,
  http_status     integer,
  level           text NOT NULL DEFAULT 'INFO',
  request_id      text,
  request_summary jsonb,
  response_snippet text,
  error_code      text,
  error_message   text,
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supplier_api_logs_tenant_time_idx
  ON supplier_api_logs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS supplier_api_logs_level_idx
  ON supplier_api_logs (tenant_id, level, created_at DESC);
