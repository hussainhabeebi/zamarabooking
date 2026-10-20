-- Apply before deploying the API that selects the new user columns.
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_provider text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_subject text;
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_social_idx
  ON users (tenant_id, social_provider, social_subject);
CREATE TABLE IF NOT EXISTS social_auth_challenges (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'apple')),
  nonce text NOT NULL,
  proof_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS social_auth_challenges_expiry_idx ON social_auth_challenges(expires_at);
