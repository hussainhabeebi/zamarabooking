import {
  pgTable, text, jsonb, timestamp, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenant.js";
import { users } from "./user.js";
import { userRoleEnum } from "./enums.js";

// Audit logs are tenant-isolated — no cross-tenant leakage, enforced at query layer
export const auditLogs = pgTable("audit_logs", {
  id:       text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId:   text("user_id").references(() => users.id),

  action:   text("action").notNull(),    // BOOKING_CREATED | AGENT_APPROVED | WALLET_ADJUSTED | ...
  entity:   text("entity").notNull(),    // Booking | Agent | WalletAccount | Tenant | ...
  entityId: text("entity_id"),

  before:    jsonb("before"),   // State snapshot before action (for PII access logs too)
  after:     jsonb("after"),    // State snapshot after action

  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  metadata:  jsonb("metadata"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  entityIdx: index("audit_logs_entity_idx").on(t.tenantId, t.entity, t.entityId),
  userIdx:   index("audit_logs_user_idx").on(t.tenantId, t.userId),
  timeIdx:   index("audit_logs_time_idx").on(t.tenantId, t.createdAt),
}));
