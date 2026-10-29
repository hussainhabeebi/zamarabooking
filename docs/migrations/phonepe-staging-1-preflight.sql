-- PhonePe Neon STAGING preflight. READ-ONLY. Run in the Neon SQL Editor with the
-- branch selector set to `phonepe-staging`. Changes nothing.

-- 1. Where am I, and as whom (this role runs the migration and must own payment_gateway).
SELECT current_database() AS database, current_user AS editor_role, current_setting('server_version') AS postgres;

-- 2. Schema-only branch: every row count must be 0 (production has data).
SELECT (SELECT count(*) FROM tenants) AS tenants, (SELECT count(*) FROM users) AS users,
       (SELECT count(*) FROM bookings) AS bookings, (SELECT count(*) FROM payments) AS payments;

-- 3. Dependencies of the migration exist with the expected shapes.
SELECT enum_range(NULL::payment_gateway) AS gateways,
       pg_get_userbyid(t.typowner) AS gateway_type_owner
FROM pg_type t WHERE t.typname = 'payment_gateway';
SELECT table_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'id' AND table_name IN ('tenants', 'bookings', 'payments')
ORDER BY table_name;

-- 4. Not applied yet: all three must be NULL.
SELECT to_regclass('public.phonepe_orders') AS phonepe_orders, to_regclass('public.phonepe_refunds') AS phonepe_refunds,
       to_regclass('public.payment_checkout_claims') AS payment_checkout_claims;

-- 5. The phonepe_staging role (used by the staging API later).
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = 'phonepe_staging';
SELECT r.rolname AS member_of FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'phonepe_staging') ORDER BY 1;
SELECT has_table_privilege('phonepe_staging', 'public.bookings', 'SELECT') AS bookings_select,
       has_table_privilege('phonepe_staging', 'public.payments', 'INSERT') AS payments_insert,
       has_table_privilege('phonepe_staging', 'public.payments', 'UPDATE') AS payments_update;

-- 6. Fingerprint of the EXISTING schema (compare with the same query after the migration).
SELECT count(DISTINCT table_name) AS tables, count(*) AS columns,
       md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' ORDER BY table_name, ordinal_position)) AS columns_md5
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name NOT IN ('phonepe_orders', 'phonepe_refunds', 'payment_checkout_claims');
SELECT count(*) AS indexes, md5(string_agg(indexdef, ',' ORDER BY indexname)) AS indexes_md5
FROM pg_indexes WHERE schemaname = 'public' AND tablename NOT IN ('phonepe_orders', 'phonepe_refunds', 'payment_checkout_claims');
