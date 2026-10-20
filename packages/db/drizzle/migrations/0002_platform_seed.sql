-- POOMAS Platform — initial seed data
-- Creates the platform tenant + admin user + default supplier configs + markup rule

INSERT INTO "tenants" (
  "name", "slug", "status", "plan", "region", "default_currency", "default_language",
  "company_name", "tagline", "primary_color", "secondary_color", "accent_color",
  "show_powered_by", "support_email", "allow_b2c", "allow_b2b", "allow_whatsapp",
  "is_setup_complete", "onboarding_step"
) VALUES (
  'POOMAS Traveldays', 'poomas', 'ACTIVE', 'ENTERPRISE', 'INDIA', 'INR', 'en',
  'POOMAS Traveldays', 'Your Trusted Travel Partner', '#E31E24', '#F7941D', '#F5C518',
  FALSE, 'support@flypoomas.com', TRUE, TRUE, TRUE,
  TRUE, 5
) ON CONFLICT ("slug") DO NOTHING;

-- Super-admin user (no password — set via admin panel or update manually)
INSERT INTO "users" ("tenant_id", "email", "name", "role", "is_active", "email_verified")
SELECT id, 'admin@flypoomas.com', 'POOMAS Admin', 'SUPER_ADMIN', TRUE, TRUE
FROM "tenants" WHERE "slug" = 'poomas'
ON CONFLICT ("tenant_id", "email") DO NOTHING;

-- Default supplier configs for platform tenant
INSERT INTO "tenant_supplier_configs" ("tenant_id", "supplier", "is_enabled", "priority", "timeout_ms", "max_retries")
SELECT id, 'RIYA',        TRUE, 1, 15000, 2 FROM "tenants" WHERE "slug" = 'poomas'
ON CONFLICT ("tenant_id", "supplier") DO NOTHING;

INSERT INTO "tenant_supplier_configs" ("tenant_id", "supplier", "is_enabled", "priority", "timeout_ms", "max_retries")
SELECT id, 'TRIPJACK',    TRUE, 2, 15000, 2 FROM "tenants" WHERE "slug" = 'poomas'
ON CONFLICT ("tenant_id", "supplier") DO NOTHING;

INSERT INTO "tenant_supplier_configs" ("tenant_id", "supplier", "is_enabled", "priority", "timeout_ms", "max_retries")
SELECT id, 'GOOGLE_SERP', TRUE, 3, 10000, 1 FROM "tenants" WHERE "slug" = 'poomas'
ON CONFLICT ("tenant_id", "supplier") DO NOTHING;

INSERT INTO "tenant_supplier_configs" ("tenant_id", "supplier", "is_enabled", "priority", "timeout_ms", "max_retries")
SELECT id, 'DUFFEL',      FALSE, 4, 15000, 2 FROM "tenants" WHERE "slug" = 'poomas'
ON CONFLICT ("tenant_id", "supplier") DO NOTHING;

-- Default markup rule (₹250 flat, all routes)
INSERT INTO "markup_rules" ("tenant_id", "name", "is_default", "markup_type", "markup_value", "is_active", "priority")
SELECT id, 'Platform Default Markup', TRUE, 'FLAT', 250, TRUE, 0
FROM "tenants" WHERE "slug" = 'poomas'
ON CONFLICT DO NOTHING;
