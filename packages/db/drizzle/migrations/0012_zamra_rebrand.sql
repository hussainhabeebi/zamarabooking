-- Rebrand the platform tenant from POOMAS / FlyPoomas to Zamra / ZamraBooking.
-- Idempotent (applied on every deploy): only rows still holding the old
-- defaults are touched, so values changed later in the admin panel are kept.
ALTER TABLE "tenants" ALTER COLUMN "primary_color"   SET DEFAULT '#0D4B96';
ALTER TABLE "tenants" ALTER COLUMN "secondary_color" SET DEFAULT '#1E88D9';
ALTER TABLE "tenants" ALTER COLUMN "accent_color"    SET DEFAULT '#66B8E8';

UPDATE "tenants" SET "name" = 'Zamra Travels'
WHERE "slug" = 'poomas' AND "name" = 'POOMAS Traveldays';
UPDATE "tenants" SET "company_name" = 'Zamra Travels'
WHERE "slug" = 'poomas' AND "company_name" = 'POOMAS Traveldays';
UPDATE "tenants" SET "primary_color" = '#0D4B96', "secondary_color" = '#1E88D9', "accent_color" = '#66B8E8'
WHERE "slug" = 'poomas' AND "primary_color" = '#E31E24';
UPDATE "tenants" SET "support_email" = 'support@zamrabooking.com'
WHERE "slug" = 'poomas' AND "support_email" = 'support@flypoomas.com';

UPDATE "users" SET "name" = 'ZamraBooking Admin'
WHERE "name" = 'POOMAS Admin' AND "role" = 'SUPER_ADMIN';
