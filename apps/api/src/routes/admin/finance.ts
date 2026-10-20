import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bookings, payments, cancellationRequests } from "@poomas/db/schema";
import { sum, count, eq, and, gte, sql } from "drizzle-orm";
import type { Env, Variables } from "../../types.js";
import { requireRole } from "../../middleware/auth.js";

export const financeAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /api/admin/finance/summary — platform revenue summary
financeAdminRoutes.get("/summary", async (c) => {
  requireRole("SUPER_ADMIN", "STAFF")(c.get("userRole"));

  const db = c.get("db");

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // Total revenue from all TICKETED/CONFIRMED bookings
  const [revRow] = await db
    .select({ total: sql<string>`COALESCE(SUM(total_amount::numeric), 0)` })
    .from(bookings)
    .where(sql`status IN ('TICKETED', 'CONFIRMED')`);

  // Markup collected
  const [markupRow] = await db
    .select({ total: sql<string>`COALESCE(SUM(markup::numeric), 0)` })
    .from(bookings)
    .where(sql`status IN ('TICKETED', 'CONFIRMED')`);

  // Platform fees
  const [pfRow] = await db
    .select({ total: sql<string>`COALESCE(SUM(platform_fee::numeric), 0)` })
    .from(bookings)
    .where(sql`status IN ('TICKETED', 'CONFIRMED')`);

  // Refunds issued
  const [refRow] = await db
    .select({ total: sql<string>`COALESCE(SUM(refund_amount::numeric), 0)` })
    .from(cancellationRequests)
    .where(eq(cancellationRequests.status, "PROCESSED"));

  // Pending refunds
  const [pendRow] = await db
    .select({ total: sql<string>`COALESCE(SUM(refund_amount::numeric), 0)` })
    .from(cancellationRequests)
    .where(eq(cancellationRequests.status, "APPROVED"));

  // Bookings this month
  const [monthRow] = await db
    .select({ cnt: count() })
    .from(bookings)
    .where(and(
      sql`status IN ('TICKETED', 'CONFIRMED')`,
      gte(bookings.createdAt, monthStart),
    ));

  // Avg booking value
  const [avgRow] = await db
    .select({ avg: sql<string>`COALESCE(AVG(total_amount::numeric), 0)` })
    .from(bookings)
    .where(sql`status IN ('TICKETED', 'CONFIRMED')`);

  return c.json({
    totalRevenue:      Number(revRow?.total    ?? 0),
    totalMarkup:       Number(markupRow?.total ?? 0),
    totalPlatformFees: Number(pfRow?.total     ?? 0),
    totalRefunds:      Number(refRow?.total    ?? 0),
    pendingRefunds:    Number(pendRow?.total   ?? 0),
    bookingsThisMonth: monthRow?.cnt ?? 0,
    avgBookingValue:   Math.round(Number(avgRow?.avg ?? 0)),
    currency:          "INR",
  });
});
