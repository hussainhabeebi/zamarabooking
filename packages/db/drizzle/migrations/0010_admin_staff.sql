-- Admin panel user management: a STAFF role limited to chosen sections, and
-- the sections each staff user may open. Idempotent (applied on every deploy).
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'STAFF';
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_permissions jsonb NOT NULL DEFAULT '[]'::jsonb;
