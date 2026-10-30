-- STAGING ONLY. Run on `phonepe-staging` after steps 2-4. Seeds only what the
-- PhonePe sandbox needs: the platform tenant (same insert as migration
-- 0002_platform_seed.sql) and three Rs 2 test bookings with no customer, contact
-- details or supplier booking (MANUAL), so nothing can email anyone or book a flight.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenants WHERE slug <> 'zamra') OR EXISTS (SELECT 1 FROM bookings WHERE id NOT LIKE 'phonepe-sbx-%')
     OR EXISTS (SELECT 1 FROM payments WHERE booking_id NOT LIKE 'phonepe-sbx-%') OR EXISTS (SELECT 1 FROM users) THEN
    RAISE EXCEPTION 'Refusing: this branch contains non-sandbox data. Staging only.';
  END IF;
END $$;

INSERT INTO "tenants" (
  "name", "slug", "status", "plan", "region", "default_currency", "default_language",
  "company_name", "tagline", "primary_color", "secondary_color", "accent_color",
  "show_powered_by", "support_email", "allow_b2c", "allow_b2b", "allow_whatsapp",
  "is_setup_complete", "onboarding_step"
) VALUES (
  'Zamra Travels', 'zamra', 'ACTIVE', 'ENTERPRISE', 'INDIA', 'INR', 'en',
  'Zamra Travels', 'Your Trusted Travel Partner', '#0D4B96', '#1E88D9', '#66B8E8',
  FALSE, 'support@zamrabooking.com', TRUE, TRUE, TRUE,
  TRUE, 5
) ON CONFLICT ("slug") DO NOTHING;

INSERT INTO bookings (id, tenant_id, channel, status, trip_type, origin, destination, departure_date,
  flight_data, base_fare, taxes, total_amount, currency, supplier)
SELECT 'phonepe-sbx-000' || n, t.id, 'B2C_WEB', 'PAYMENT_PENDING', 'ONEWAY', 'COK', 'DXB',
  now() + interval '30 days', '{"phonepeSandboxTest": true}', 2.00, 0, 2.00, 'INR', 'MANUAL'
FROM tenants t, generate_series(1, 3) AS n WHERE t.slug = 'zamra'
ON CONFLICT (id) DO NOTHING;
COMMIT;

-- Check: one tenant (note its id for PHONEPE_TENANT_ID) and three test bookings.
SELECT id AS tenant_id, slug FROM tenants;
SELECT id, status, total_amount, currency, supplier FROM bookings ORDER BY id;
