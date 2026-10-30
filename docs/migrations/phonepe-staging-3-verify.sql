-- PhonePe Neon STAGING verification. READ-ONLY. Run on `phonepe-staging` after the apply step.

-- 1. PHONEPE gateway value added (existing values unchanged, in order).
SELECT enum_range(NULL::payment_gateway) AS gateways;

-- 2. The three tables exist and are empty.
SELECT (SELECT count(*) FROM phonepe_orders) AS phonepe_orders, (SELECT count(*) FROM phonepe_refunds) AS phonepe_refunds,
       (SELECT count(*) FROM payment_checkout_claims) AS payment_checkout_claims;

-- 3. Their constraints and indexes.
SELECT conrelid::regclass AS table_name, conname, contype FROM pg_constraint
WHERE conrelid IN ('phonepe_orders'::regclass, 'phonepe_refunds'::regclass, 'payment_checkout_claims'::regclass)
ORDER BY 1, 2;
SELECT tablename, indexname FROM pg_indexes
WHERE tablename IN ('phonepe_orders', 'phonepe_refunds', 'payment_checkout_claims') ORDER BY 1, 2;

-- 4. Existing schema unchanged: these two rows must equal preflight step 6 exactly.
SELECT count(DISTINCT table_name) AS tables, count(*) AS columns,
       md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' ORDER BY table_name, ordinal_position)) AS columns_md5
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name NOT IN ('phonepe_orders', 'phonepe_refunds', 'payment_checkout_claims');
SELECT count(*) AS indexes, md5(string_agg(indexdef, ',' ORDER BY indexname)) AS indexes_md5
FROM pg_indexes WHERE schemaname = 'public' AND tablename NOT IN ('phonepe_orders', 'phonepe_refunds', 'payment_checkout_claims');

-- 5. Still no data anywhere.
SELECT (SELECT count(*) FROM tenants) AS tenants, (SELECT count(*) FROM bookings) AS bookings, (SELECT count(*) FROM payments) AS payments;

-- 6. What the staging API role can do on the new tables (needs SELECT, INSERT, UPDATE; DELETE is never used).
SELECT t AS table_name,
       has_table_privilege('phonepe_staging', t, 'SELECT') AS can_select,
       has_table_privilege('phonepe_staging', t, 'INSERT') AS can_insert,
       has_table_privilege('phonepe_staging', t, 'UPDATE') AS can_update,
       has_table_privilege('phonepe_staging', t, 'DELETE') AS can_delete
FROM unnest(ARRAY['public.phonepe_orders', 'public.phonepe_refunds', 'public.payment_checkout_claims', 'public.payments']) AS t;
