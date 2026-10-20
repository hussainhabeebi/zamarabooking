-- Agent numbers (FPA10001, FPA10002 … per tenant) for every agency, used by
-- Leadvyne Live Agency to tag searches / checkout links, plus a daily activity
-- tally for agency analytics. Idempotent (applied on every deploy).

ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_number text;

-- Number existing agencies in sign-up order, after any numbers already given.
WITH base AS (
  SELECT tenant_id, coalesce(max(substring(agent_number from 4)::int), 10000) AS top
  FROM agents WHERE agent_number ~ '^FPA[0-9]+$' GROUP BY tenant_id
), numbered AS (
  SELECT a.id, 'FPA' || (coalesce(b.top, 10000) + row_number() OVER (PARTITION BY a.tenant_id ORDER BY a.created_at, a.id))::text AS n
  FROM agents a LEFT JOIN base b ON b.tenant_id = a.tenant_id
  WHERE a.agent_number IS NULL
)
UPDATE agents a SET agent_number = numbered.n FROM numbered WHERE a.id = numbered.id;

CREATE UNIQUE INDEX IF NOT EXISTS agents_tenant_number_idx ON agents (tenant_id, agent_number);

CREATE TABLE IF NOT EXISTS agent_activity_daily (
  agent_id   text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  day        date NOT NULL,
  tenant_id  text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  searches   integer NOT NULL DEFAULT 0,
  checkouts  integer NOT NULL DEFAULT 0,   -- checkout links created (Leadvyne hand-offs)
  PRIMARY KEY (agent_id, day)
);
CREATE INDEX IF NOT EXISTS agent_activity_daily_tenant_idx ON agent_activity_daily (tenant_id, day);
