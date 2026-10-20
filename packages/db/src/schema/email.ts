import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenant.js";

// Emails sent through Resend (or skipped / failed) — Admin → Settings → Email.
export const emailLogs = pgTable("email_logs", {
  id:         text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId:   text("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  toEmail:    text("to_email").notNull(),
  subject:    text("subject").notNull(),
  category:   text("category").notNull(),
  status:     text("status").notNull(),
  providerId: text("provider_id"),
  error:      text("error"),
  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("email_logs_tenant_idx").on(t.tenantId, t.createdAt),
}));
