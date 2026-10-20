-- B2B agency portal: agency settings, service requests (visa / packages / groups /
-- deposits / support / leads …) with message threads, quotes and saved travellers.
-- Idempotent (applied on every deploy).

ALTER TABLE agents ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS agent_requests (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id    text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id     text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id      text REFERENCES users(id),
  booking_id   text REFERENCES bookings(id) ON DELETE SET NULL,
  type         text NOT NULL,      -- DEPOSIT | VISA | PACKAGE | UMRAH | HOTEL | INSURANCE | BUS | GROUP | CHARTER | AMENDMENT | OFFLINE_BOOKING | SUPPORT | LEAD
  status       text NOT NULL DEFAULT 'OPEN',   -- OPEN | IN_PROGRESS | QUOTED | APPROVED | REJECTED | DONE | CLOSED
  title        text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  attachments  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ key, name, type, size }]
  amount       numeric(14,2),
  currency     text,
  admin_note   text,
  due_at       timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_requests_agent_idx ON agent_requests (agent_id, created_at);
CREATE INDEX IF NOT EXISTS agent_requests_tenant_status_idx ON agent_requests (tenant_id, status, type, created_at);

CREATE TABLE IF NOT EXISTS agent_request_messages (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  request_id  text NOT NULL REFERENCES agent_requests(id) ON DELETE CASCADE,
  user_id     text REFERENCES users(id),
  from_staff  boolean NOT NULL DEFAULT false,
  message     text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_request_messages_request_idx ON agent_request_messages (request_id, created_at);

CREATE TABLE IF NOT EXISTS agent_quotes (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id   text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id    text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id     text REFERENCES users(id),
  token       text NOT NULL UNIQUE,
  customer_name  text,
  customer_phone text,
  options     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ fare snapshot, sellingPrice, note }]
  note        text,
  currency    text NOT NULL DEFAULT 'INR',
  expires_at  timestamptz NOT NULL,
  viewed_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_quotes_agent_idx ON agent_quotes (agent_id, created_at);

CREATE TABLE IF NOT EXISTS agent_travellers (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id        text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type            text NOT NULL DEFAULT 'ADULT',
  first_name      text NOT NULL,
  last_name       text NOT NULL,
  dob             date,
  gender          text,
  nationality     text,
  passport_number text,
  passport_expiry date,
  phone           text,
  email           text,
  group_name      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_travellers_agent_idx ON agent_travellers (agent_id, last_name);
