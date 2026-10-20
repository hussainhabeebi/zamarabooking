import { pgEnum } from "drizzle-orm/pg-core";

export const regionEnum = pgEnum("region", ["INDIA", "GCC"]);
export const currencyEnum = pgEnum("currency", ["INR", "AED", "USD"]);

export const tenantPlanEnum = pgEnum("tenant_plan", [
  "TRIAL",
  "STARTER",
  "PROFESSIONAL",
  "ENTERPRISE",
]);

export const tenantStatusEnum = pgEnum("tenant_status", [
  "ONBOARDING",
  "ACTIVE",
  "SUSPENDED",
  "TRIAL_EXPIRED",
  "CLOSED",
]);

export const userRoleEnum = pgEnum("user_role", [
  "SUPER_ADMIN",
  "TENANT_ADMIN",
  "AGENT_ADMIN",
  "AGENT_STAFF",
  "AGENT_ACCOUNTANT",
  "CUSTOMER",
  "STAFF",          // admin-panel staff: only the sections in users.admin_permissions
]);

export const agentStatusEnum = pgEnum("agent_status", [
  "PENDING",
  "APPROVED",
  "SUSPENDED",
  "REJECTED",
]);

export const bookingStatusEnum = pgEnum("booking_status", [
  "SEARCHED",
  "HELD",
  "PAYMENT_PENDING",
  "PAYMENT_FAILED",
  "CONFIRMED",
  "TICKETED",
  "CANCELLED",
  "REFUND_PENDING",
  "REFUNDED",
  "REISSUED",
]);

export const bookingChannelEnum = pgEnum("booking_channel", [
  "B2C_WEB",
  "B2B_PORTAL",
  "WHATSAPP_BOT",
  "OFFLINE",
]);

export const supplierNameEnum = pgEnum("supplier_name", [
  "RIYA",
  "TRIPJACK",
  "GOOGLE_SERP",
  "DUFFEL",
]);

export const paymentGatewayEnum = pgEnum("payment_gateway", [
  "RAZORPAY",
  "NOMOD",
  "WALLET",
  "MANUAL",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "PENDING",
  "SUCCESS",
  "FAILED",
  "REFUNDED",
  "PARTIAL_REFUND",
]);

export const walletTxTypeEnum = pgEnum("wallet_tx_type", [
  "TOPUP",
  "BOOKING_DEBIT",
  "REFUND_CREDIT",
  "ADJUSTMENT",
  "COMMISSION_CREDIT",
  "SUBSCRIPTION_DEBIT",
  "BOOKING_BONUS",
  "ADMIN_CREDIT",
  "COUPON_DEBIT",
  "COUPON_CREDIT",
  "COUPON_REFUND",
]);

export const cabinClassEnum = pgEnum("cabin_class", [
  "ECONOMY",
  "PREMIUM_ECONOMY",
  "BUSINESS",
  "FIRST",
]);

export const tripTypeEnum = pgEnum("trip_type", [
  "ONEWAY",
  "ROUNDTRIP",
  "MULTICITY",
]);
