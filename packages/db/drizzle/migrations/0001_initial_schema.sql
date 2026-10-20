-- POOMAS Platform — initial schema migration
-- Generated from Drizzle schema

-- ── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Enums ───────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "region" AS ENUM ('INDIA', 'GCC');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "currency" AS ENUM ('INR', 'AED', 'USD');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "tenant_plan" AS ENUM ('TRIAL', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "tenant_status" AS ENUM ('ONBOARDING', 'ACTIVE', 'SUSPENDED', 'TRIAL_EXPIRED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "user_role" AS ENUM ('SUPER_ADMIN', 'TENANT_ADMIN', 'AGENT_ADMIN', 'AGENT_STAFF', 'AGENT_ACCOUNTANT', 'CUSTOMER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "agent_status" AS ENUM ('PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "booking_status" AS ENUM ('SEARCHED', 'HELD', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'CONFIRMED', 'TICKETED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED', 'REISSUED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "booking_channel" AS ENUM ('B2C_WEB', 'B2B_PORTAL', 'WHATSAPP_BOT', 'OFFLINE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "supplier_name" AS ENUM ('RIYA', 'TRIPJACK', 'GOOGLE_SERP', 'DUFFEL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "payment_gateway" AS ENUM ('RAZORPAY', 'NOMOD', 'WALLET', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "payment_status" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'REFUNDED', 'PARTIAL_REFUND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "wallet_tx_type" AS ENUM ('TOPUP', 'BOOKING_DEBIT', 'REFUND_CREDIT', 'ADJUSTMENT', 'COMMISSION_CREDIT', 'SUBSCRIPTION_DEBIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "cabin_class" AS ENUM ('ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "trip_type" AS ENUM ('ONEWAY', 'ROUNDTRIP', 'MULTICITY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Tenants ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tenants" (
  "id"                   TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"                 TEXT NOT NULL,
  "slug"                 TEXT NOT NULL,
  "custom_domain"        TEXT,
  "parent_tenant_id"     TEXT,
  "status"               "tenant_status" NOT NULL DEFAULT 'ONBOARDING',
  "plan"                 "tenant_plan"   NOT NULL DEFAULT 'TRIAL',
  "region"               "region"        NOT NULL DEFAULT 'INDIA',
  "default_currency"     "currency"      NOT NULL DEFAULT 'INR',
  "default_language"     TEXT            NOT NULL DEFAULT 'en',
  "logo_url"             TEXT,
  "favicon_url"          TEXT,
  "primary_color"        TEXT            NOT NULL DEFAULT '#E31E24',
  "secondary_color"      TEXT            NOT NULL DEFAULT '#F7941D',
  "accent_color"         TEXT            NOT NULL DEFAULT '#F5C518',
  "font_family"          TEXT            NOT NULL DEFAULT 'Inter',
  "company_name"         TEXT,
  "tagline"              TEXT,
  "show_powered_by"      BOOLEAN         NOT NULL DEFAULT TRUE,
  "support_email"        TEXT,
  "support_phone"        TEXT,
  "support_whatsapp"     TEXT,
  "email_sender_name"    TEXT,
  "whatsapp_sender_id"   TEXT,
  "home_banner_config"   JSONB,
  "footer_config"        JSONB,
  "homepage_routes"      JSONB,
  "gst_number"           TEXT,
  "vat_number"           TEXT,
  "iata_code"            TEXT,
  "address"              TEXT,
  "terms_url"            TEXT,
  "privacy_url"          TEXT,
  "allow_b2c"            BOOLEAN         NOT NULL DEFAULT TRUE,
  "allow_b2b"            BOOLEAN         NOT NULL DEFAULT TRUE,
  "allow_whatsapp"       BOOLEAN         NOT NULL DEFAULT FALSE,
  "allow_group_booking"  BOOLEAN         NOT NULL DEFAULT FALSE,
  "allow_seat_selection" BOOLEAN         NOT NULL DEFAULT FALSE,
  "search_rpm_limit"     INTEGER         NOT NULL DEFAULT 60,
  "booking_rpm_limit"    INTEGER         NOT NULL DEFAULT 20,
  "payment_config"       JSONB,
  "subscription_fee"     DECIMAL(14,2)   NOT NULL DEFAULT 0,
  "per_booking_fee"      DECIMAL(14,4)   NOT NULL DEFAULT 0,
  "per_booking_fee_type" TEXT            NOT NULL DEFAULT 'PERCENTAGE',
  "billing_cycle_day"    INTEGER         NOT NULL DEFAULT 1,
  "trial_ends_at"        TIMESTAMPTZ,
  "subscription_ends_at" TIMESTAMPTZ,
  "usage_current_month"  JSONB,
  "usage_reset_at"       TIMESTAMPTZ,
  "onboarding_step"      INTEGER         NOT NULL DEFAULT 0,
  "is_setup_complete"    BOOLEAN         NOT NULL DEFAULT FALSE,
  "created_at"           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_idx" ON "tenants" ("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_custom_domain_idx" ON "tenants" ("custom_domain");

-- ── Tenant API keys ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tenant_api_keys" (
  "id"           TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"    TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name"         TEXT NOT NULL,
  "key_hash"     TEXT NOT NULL,
  "key_prefix"   TEXT NOT NULL,
  "scopes"       TEXT[] NOT NULL DEFAULT '{}',
  "is_active"    BOOLEAN NOT NULL DEFAULT TRUE,
  "last_used_at" TIMESTAMPTZ,
  "expires_at"   TIMESTAMPTZ,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "revoked_at"   TIMESTAMPTZ,
  "revoked_by_id" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_api_keys_hash_idx" ON "tenant_api_keys" ("key_hash");

-- ── Announcements ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "announcements" (
  "id"          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "title"       TEXT NOT NULL,
  "content"     TEXT NOT NULL,
  "type"        TEXT NOT NULL DEFAULT 'INFO',
  "target_role" "user_role",
  "is_active"   BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "expires_at"  TIMESTAMPTZ
);

-- ── Subscription invoices ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "subscription_invoices" (
  "id"               TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"        TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "period_start"     TIMESTAMPTZ NOT NULL,
  "period_end"       TIMESTAMPTZ NOT NULL,
  "subscription_fee" DECIMAL(14,2) NOT NULL,
  "transaction_fees" DECIMAL(14,2) NOT NULL,
  "total_amount"     DECIMAL(14,2) NOT NULL,
  "currency"         "currency"    NOT NULL,
  "status"           TEXT          NOT NULL DEFAULT 'DRAFT',
  "paid_at"          TIMESTAMPTZ,
  "payment_ref"      TEXT,
  "line_items"       JSONB NOT NULL,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Webhook configs ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "webhook_configs" (
  "id"         TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"  TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name"       TEXT NOT NULL,
  "url"        TEXT NOT NULL,
  "secret"     TEXT,
  "events"     TEXT[] NOT NULL,
  "is_active"  BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "users" (
  "id"                  TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "email"               TEXT,
  "phone"               TEXT,
  "name"                TEXT,
  "password_hash"       TEXT,
  "role"                "user_role" NOT NULL DEFAULT 'CUSTOMER',
  "is_active"           BOOLEAN     NOT NULL DEFAULT TRUE,
  "agent_id"            TEXT,
  "email_verified"      BOOLEAN     NOT NULL DEFAULT FALSE,
  "phone_verified"      BOOLEAN     NOT NULL DEFAULT FALSE,
  "two_factor_enabled"  BOOLEAN     NOT NULL DEFAULT FALSE,
  "two_factor_secret"   TEXT,
  "preferred_currency"  "currency",
  "preferred_language"  TEXT,
  "whatsapp_opt_in"     BOOLEAN     NOT NULL DEFAULT FALSE,
  "last_login_at"       TIMESTAMPTZ,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_tenant_email_idx" ON "users" ("tenant_id", "email");
CREATE UNIQUE INDEX IF NOT EXISTS "users_tenant_phone_idx" ON "users" ("tenant_id", "phone");

-- ── User sessions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id"         TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token"      TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "ip_address" TEXT,
  "user_agent" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_sessions_token_idx" ON "user_sessions" ("token");

-- ── Saved passengers ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "saved_passengers" (
  "id"               TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "first_name"       TEXT NOT NULL,
  "last_name"        TEXT NOT NULL,
  "dob"              TIMESTAMPTZ,
  "gender"           TEXT,
  "nationality"      TEXT,
  "passport_number"  TEXT,
  "passport_expiry"  TIMESTAMPTZ,
  "passport_country" TEXT,
  "is_default"       BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Agents ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "agents" (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"       TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "business_name"   TEXT NOT NULL,
  "owner_name"      TEXT NOT NULL,
  "email"           TEXT NOT NULL,
  "phone"           TEXT NOT NULL,
  "whatsapp"        TEXT,
  "region"          "region"       NOT NULL,
  "currency"        "currency"     NOT NULL,
  "status"          "agent_status" NOT NULL DEFAULT 'PENDING',
  "iata_code"       TEXT,
  "parent_agent_id" TEXT,
  "credit_limit"    DECIMAL(14,2) NOT NULL DEFAULT 0,
  "minimum_deposit" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "approved_at"     TIMESTAMPTZ,
  "approved_by_id"  TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "agents_tenant_email_idx" ON "agents" ("tenant_id", "email");
CREATE INDEX IF NOT EXISTS "agents_tenant_status_idx" ON "agents" ("tenant_id", "status");

-- ── Agent documents ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "agent_documents" (
  "id"             TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"       TEXT NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "doc_type"       TEXT NOT NULL,
  "file_url"       TEXT NOT NULL,
  "file_name"      TEXT NOT NULL,
  "mime_type"      TEXT,
  "uploaded_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "verified_at"    TIMESTAMPTZ,
  "verified_by_id" TEXT
);

-- ── Supplier configs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tenant_supplier_configs" (
  "id"               TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"        TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "supplier"         "supplier_name" NOT NULL,
  "is_enabled"       BOOLEAN  NOT NULL DEFAULT TRUE,
  "priority"         INTEGER  NOT NULL DEFAULT 1,
  "credentials"      JSONB,
  "timeout_ms"       INTEGER  NOT NULL DEFAULT 15000,
  "max_retries"      INTEGER  NOT NULL DEFAULT 2,
  "calls_this_month" INTEGER  NOT NULL DEFAULT 0,
  "calls_limit"      INTEGER,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_supplier_configs_idx" ON "tenant_supplier_configs" ("tenant_id", "supplier");

-- ── Markup rules ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "markup_rules" (
  "id"           TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"    TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "agent_id"     TEXT REFERENCES "agents"("id"),
  "name"         TEXT NOT NULL,
  "is_default"   BOOLEAN NOT NULL DEFAULT FALSE,
  "airline"      TEXT,
  "origin"       TEXT,
  "destination"  TEXT,
  "cabin_class"  "cabin_class",
  "supplier"     "supplier_name",
  "trip_type"    "trip_type",
  "markup_type"  TEXT NOT NULL,
  "markup_value" DECIMAL(14,4) NOT NULL,
  "valid_from"   TIMESTAMPTZ,
  "valid_to"     TIMESTAMPTZ,
  "is_active"    BOOLEAN NOT NULL DEFAULT TRUE,
  "priority"     INTEGER NOT NULL DEFAULT 0,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Promo codes ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "promo_codes" (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"       TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "code"            TEXT NOT NULL,
  "description"     TEXT,
  "discount_type"   TEXT NOT NULL,
  "discount_value"  DECIMAL(14,4) NOT NULL,
  "max_discount"    DECIMAL(14,2),
  "min_fare_amount" DECIMAL(14,2),
  "usage_limit"     INTEGER,
  "usage_count"     INTEGER NOT NULL DEFAULT 0,
  "per_user_limit"  INTEGER NOT NULL DEFAULT 1,
  "applicable_on"   TEXT[]  NOT NULL DEFAULT '{}',
  "airlines"        TEXT[]  NOT NULL DEFAULT '{}',
  "routes"          TEXT[]  NOT NULL DEFAULT '{}',
  "valid_from"      TIMESTAMPTZ NOT NULL,
  "valid_to"        TIMESTAMPTZ NOT NULL,
  "is_active"       BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "promo_codes_tenant_code_idx" ON "promo_codes" ("tenant_id", "code");

-- ── Leadvyne configs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "leadvyne_configs" (
  "id"                   TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"            TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "environment"          TEXT NOT NULL DEFAULT 'production',
  "chatwoot_base_url"    TEXT,
  "chatwoot_inbox_id"    INTEGER,
  "chatwoot_api_token"   TEXT,
  "whatsapp_number"      TEXT,
  "endpoint_mappings"    JSONB NOT NULL,
  "timeout_ms"           INTEGER NOT NULL DEFAULT 15000,
  "retry_count"          INTEGER NOT NULL DEFAULT 2,
  "webhook_url"          TEXT,
  "webhook_secret"       TEXT,
  "template_mappings"    JSONB,
  "show_serp_disclaimer" BOOLEAN NOT NULL DEFAULT TRUE,
  "is_active"            BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "leadvyne_configs_tenant_env_idx" ON "leadvyne_configs" ("tenant_id", "environment");

-- ── Bookings ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bookings" (
  "id"                   TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"            TEXT NOT NULL REFERENCES "tenants"("id"),
  "user_id"              TEXT REFERENCES "users"("id"),
  "agent_id"             TEXT REFERENCES "agents"("id"),
  "channel"              "booking_channel" NOT NULL,
  "status"               "booking_status"  NOT NULL DEFAULT 'SEARCHED',
  "trip_type"            "trip_type"       NOT NULL,
  "cabin_class"          "cabin_class"     NOT NULL DEFAULT 'ECONOMY',
  "origin"               TEXT NOT NULL,
  "destination"          TEXT NOT NULL,
  "departure_date"       TIMESTAMPTZ NOT NULL,
  "return_date"          TIMESTAMPTZ,
  "flight_data"          JSONB NOT NULL,
  "adult_count"          INTEGER NOT NULL DEFAULT 1,
  "child_count"          INTEGER NOT NULL DEFAULT 0,
  "infant_count"         INTEGER NOT NULL DEFAULT 0,
  "base_fare"            DECIMAL(14,2) NOT NULL,
  "taxes"                DECIMAL(14,2) NOT NULL,
  "markup"               DECIMAL(14,2) NOT NULL DEFAULT 0,
  "convenience_fee"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "promo_discount"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  "platform_fee"         DECIMAL(14,2) NOT NULL DEFAULT 0,
  "total_amount"         DECIMAL(14,2) NOT NULL,
  "currency"             "currency"    NOT NULL,
  "supplier"             "supplier_name" NOT NULL,
  "supplier_booking_ref" TEXT,
  "supplier_session_id"  TEXT,
  "pnr"                  TEXT,
  "ticket_numbers"       TEXT[] NOT NULL DEFAULT '{}',
  "gst_applicable"       BOOLEAN NOT NULL DEFAULT FALSE,
  "gst_number"           TEXT,
  "gst_details"          JSONB,
  "add_ons"              JSONB,
  "promo_code_id"        TEXT,
  "held_until"           TIMESTAMPTZ,
  "group_ref"            TEXT,
  "contact_email"        TEXT,
  "contact_phone"        TEXT,
  "ip_address"           TEXT,
  "user_agent"           TEXT,
  "whatsapp_phone"       TEXT,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "bookings_tenant_status_idx" ON "bookings" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "bookings_tenant_agent_idx"  ON "bookings" ("tenant_id", "agent_id");
CREATE INDEX IF NOT EXISTS "bookings_pnr_idx"           ON "bookings" ("pnr");
CREATE INDEX IF NOT EXISTS "bookings_group_ref_idx"     ON "bookings" ("group_ref");

-- ── Booking passengers ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "booking_passengers" (
  "id"               TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "booking_id"       TEXT NOT NULL REFERENCES "bookings"("id") ON DELETE CASCADE,
  "passenger_type"   TEXT NOT NULL,
  "title"            TEXT,
  "first_name"       TEXT NOT NULL,
  "last_name"        TEXT NOT NULL,
  "dob"              TIMESTAMPTZ,
  "gender"           TEXT,
  "nationality"      TEXT,
  "passport_number"  TEXT,
  "passport_expiry"  TIMESTAMPTZ,
  "passport_country" TEXT,
  "ticket_number"    TEXT,
  "seat_number"      TEXT,
  "meal_code"        TEXT,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Cancellation requests ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "cancellation_requests" (
  "id"               TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "booking_id"       TEXT NOT NULL REFERENCES "bookings"("id"),
  "reason"           TEXT,
  "requested_by_id"  TEXT,
  "status"           TEXT NOT NULL DEFAULT 'PENDING',
  "supplier_penalty" DECIMAL(14,2),
  "tenant_penalty"   DECIMAL(14,2),
  "refund_amount"    DECIMAL(14,2),
  "requested_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "processed_at"     TIMESTAMPTZ,
  "processed_by_id"  TEXT,
  "notes"            TEXT
);

-- ── Reissue requests ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "reissue_requests" (
  "id"                 TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "booking_id"         TEXT NOT NULL REFERENCES "bookings"("id"),
  "new_departure_date" TIMESTAMPTZ,
  "new_return_date"    TIMESTAMPTZ,
  "new_origin"         TEXT,
  "new_destination"    TEXT,
  "reason"             TEXT,
  "requested_by_id"    TEXT,
  "status"             TEXT NOT NULL DEFAULT 'PENDING',
  "date_diff_fare"     DECIMAL(14,2),
  "supplier_penalty"   DECIMAL(14,2),
  "tenant_penalty"     DECIMAL(14,2),
  "total_due"          DECIMAL(14,2),
  "requested_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "processed_at"       TIMESTAMPTZ,
  "processed_by_id"    TEXT
);

-- ── Payments ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payments" (
  "id"                    TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "booking_id"            TEXT NOT NULL REFERENCES "bookings"("id"),
  "gateway"               "payment_gateway" NOT NULL,
  "gateway_order_id"      TEXT,
  "gateway_payment_id"    TEXT,
  "amount"                DECIMAL(14,2) NOT NULL,
  "currency"              "currency"    NOT NULL,
  "status"                "payment_status" NOT NULL DEFAULT 'PENDING',
  "payment_method"        TEXT,
  "gateway_response"      JSONB,
  "refunded_amount"       DECIMAL(14,2),
  "refund_initiated_at"   TIMESTAMPTZ,
  "refund_completed_at"   TIMESTAMPTZ,
  "refund_gateway_ref"    TEXT,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "payments_gateway_payment_id_idx" ON "payments" ("gateway_payment_id");

-- ── Wallet accounts ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "wallet_accounts" (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"       TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "agent_id"        TEXT REFERENCES "agents"("id"),
  "currency"        "currency"    NOT NULL,
  "balance"         DECIMAL(14,2) NOT NULL DEFAULT 0,
  "credit_limit"    DECIMAL(14,2) NOT NULL DEFAULT 0,
  "alert_threshold" DECIMAL(14,2),
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_accounts_agent_id_idx" ON "wallet_accounts" ("agent_id");

-- ── Wallet transactions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "wallet_transactions" (
  "id"                TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_account_id" TEXT NOT NULL REFERENCES "wallet_accounts"("id"),
  "type"              "wallet_tx_type" NOT NULL,
  "amount"            DECIMAL(14,2) NOT NULL,
  "balance_before"    DECIMAL(14,2) NOT NULL,
  "balance_after"     DECIMAL(14,2) NOT NULL,
  "booking_id"        TEXT,
  "payment_id"        TEXT,
  "note"              TEXT,
  "performed_by_id"   TEXT,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Commissions ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "commissions" (
  "id"           TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "booking_id"   TEXT NOT NULL REFERENCES "bookings"("id"),
  "agent_id"     TEXT NOT NULL REFERENCES "agents"("id"),
  "base_amount"  DECIMAL(14,2) NOT NULL,
  "rate_percent" DECIMAL(8,4)  NOT NULL,
  "amount"       DECIMAL(14,2) NOT NULL,
  "currency"     "currency"    NOT NULL,
  "paid_at"      TIMESTAMPTZ,
  "paid_via"     TEXT,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "commissions_booking_id_idx" ON "commissions" ("booking_id");

-- ── Audit logs ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"         TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"  TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id"    TEXT REFERENCES "users"("id"),
  "action"     TEXT NOT NULL,
  "entity"     TEXT NOT NULL,
  "entity_id"  TEXT,
  "before"     JSONB,
  "after"      JSONB,
  "ip_address" TEXT,
  "user_agent" TEXT,
  "metadata"   JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "audit_logs_entity_idx" ON "audit_logs" ("tenant_id", "entity", "entity_id");
CREATE INDEX IF NOT EXISTS "audit_logs_user_idx"   ON "audit_logs" ("tenant_id", "user_id");
CREATE INDEX IF NOT EXISTS "audit_logs_time_idx"   ON "audit_logs" ("tenant_id", "created_at");
