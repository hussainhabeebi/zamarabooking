-- Raw supplier API exchanges for certification / audit. Each row points at two
-- R2 files: the exact request sent (URL, headers incl. apikey, body) and the
-- exact response text received (unmodified). Idempotent.
CREATE TABLE IF NOT EXISTS supplier_exchanges (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id     text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id    text REFERENCES bookings(id) ON DELETE SET NULL,
  search_id     text,
  request_id    text,
  supplier      text NOT NULL,
  endpoint      text NOT NULL,
  url           text NOT NULL,
  http_status   integer,
  duration_ms   integer,
  error         text,
  request_key   text NOT NULL,
  response_key  text,
  started_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_exchanges_booking_idx ON supplier_exchanges (booking_id, started_at);
CREATE INDEX IF NOT EXISTS supplier_exchanges_search_idx ON supplier_exchanges (search_id, started_at);
CREATE INDEX IF NOT EXISTS supplier_exchanges_tenant_time_idx ON supplier_exchanges (tenant_id, started_at);
