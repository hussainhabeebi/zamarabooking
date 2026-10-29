-- OPTIONAL, STAGING ONLY. Run on `phonepe-staging` only if verification step 6 shows
-- `false`, and BEFORE seeding any data. Gives the staging API role the same table access an application role
-- needs (the API reads/writes many tables, not only PhonePe). Never run on production.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenants) OR EXISTS (SELECT 1 FROM bookings) OR EXISTS (SELECT 1 FROM payments) THEN
    RAISE EXCEPTION 'Refusing: this branch contains data. Run only on the empty schema-only phonepe-staging branch, before seeding.';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO phonepe_staging;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO phonepe_staging;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO phonepe_staging;
COMMIT;
