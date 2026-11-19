-- Rollback of 0015_search_analytics.sql. NOT a migration: it lives outside drizzle/migrations so
-- no workflow ever applies it automatically. Run only with separate written approval, after the
-- API / Admin code that writes these tables has been rolled back.
--
-- Removes customer search analytics data ONLY. No booking, payment, user or other table is touched.
DROP TABLE IF EXISTS search_events;
DROP TABLE IF EXISTS site_visits;
