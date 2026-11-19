// Admin → Analytics (Phase 1 customer search tracking, docs/search-analytics.md).
//
// Access: full admins, and STAFF with the "Customer analytics" section (admin-access.ts).
// Customer details (name / email / phone) — on screen and in CSV — only for full admins, or staff who
// also have the Bookings section. The search-tracking switch can be changed by full admins only.
// Every CSV export is written to the audit log.
//
// GET /api/admin/analytics/settings              { searchTracking }
// PUT /api/admin/analytics/settings              { searchTracking: boolean }         full admins
// GET /api/admin/analytics/overview              KPIs + website bookings (+ active fare alerts)
// GET /api/admin/analytics/trend?interval=day|week|month
// GET /api/admin/analytics/sectors               ?format=csv
// GET /api/admin/analytics/airports              ?format=csv&list=departures|destinations
// GET /api/admin/analytics/dates                 ?format=csv&list=dates|lead-time
// GET /api/admin/analytics/searches              ?status&origin&destination&page  ?format=csv
// GET /api/admin/analytics/abandoned-checkouts   ?page  ?format=csv
// GET /api/admin/analytics/revenue               ?interval  ?format=csv&list=period|sector
// Common filters: from, to (YYYY-MM-DD, India time, ≤ 366 days), device, country, audience=guest|customer.

import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditLogs } from "@zamrabooking/db/schema";
import type { Env, Variables } from "../../types.js";
import { loadAdminUser } from "../../lib/admin-access.js";
import { getAnalyticsSettings, istDay, saveAnalyticsSettings } from "../../lib/search-analytics.js";
import {
  MAX_EXPORT_ROWS, abandonedCheckouts, airports, overview, parseFilters, revenue, searchHistory, sectors, toCsv, travelDates, trend,
  type ReportFilters,
} from "../../lib/analytics-reports.js";

type C = Context<{ Bindings: Env; Variables: Variables }>;
export const analyticsAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const FULL_ADMINS = ["SUPER_ADMIN", "TENANT_ADMIN"];

/** Whether this admin may see customer names, emails and phone numbers. */
export async function canSeeCustomers(c: C): Promise<boolean> {
  const role = c.get("userRole") ?? "";
  if (FULL_ADMINS.includes(role)) return true;
  const userId = c.get("userId");
  if (role !== "STAFF" || !userId) return false;
  const u = await loadAdminUser(c.env, c.get("db"), userId);
  return !!u && u.isActive && u.permissions.includes("analytics") && u.permissions.includes("bookings");
}

function filters(c: C): ReportFilters {
  const f = parseFilters(c.get("tenantId"), c.req.query(), istDay());
  if (typeof f === "string") throw new HTTPException(400, { message: f });
  return f;
}
const interval = (c: C) => (["week", "month"].includes(c.req.query("interval") ?? "") ? c.req.query("interval") as "week" | "month" : "day");
const wantsCsv = (c: C) => c.req.query("format") === "csv";

async function csv(c: C, report: string, f: ReportFilters, columns: { key: string; label: string }[], rows: Record<string, unknown>[], customers: boolean) {
  const body = toCsv(columns, rows);
  await c.get("db").insert(auditLogs).values({
    tenantId: f.tenantId, userId: c.get("userId") ?? null, action: "ANALYTICS_EXPORT", entity: "Analytics", entityId: report,
    metadata: { report, from: f.from, to: f.to, device: f.device ?? null, country: f.country ?? null, audience: f.audience ?? null, rows: rows.length, includesCustomerDetails: customers },
  }).catch((err: unknown) => console.error("[analytics] audit", err));
  const name = `zamra-${report}-${f.from}-to-${f.to}.csv`;
  return c.body(body, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
}

analyticsAdminRoutes.get("/settings", async (c) => c.json(await getAnalyticsSettings(c.env, c.get("tenantId"))));

analyticsAdminRoutes.put("/settings", async (c) => {
  if (!FULL_ADMINS.includes(c.get("userRole") ?? "")) throw new HTTPException(403, { message: "Only admins can switch search tracking on or off." });
  const parsed = z.object({ searchTracking: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: "searchTracking must be true or false" });
  const saved = await saveAnalyticsSettings(c.env, c.get("tenantId"), parsed.data.searchTracking, c.get("userId") ?? null);
  await c.get("db").insert(auditLogs).values({
    tenantId: c.get("tenantId"), userId: c.get("userId") ?? null, action: "ANALYTICS_SETTINGS_UPDATED", entity: "Analytics", entityId: "search-tracking",
    after: saved,
  }).catch((err: unknown) => console.error("[analytics] audit", err));
  return c.json(saved);
});

analyticsAdminRoutes.get("/overview", async (c) => {
  const f = filters(c);
  const [data, settings, alerts] = await Promise.all([overview(c.get("db") as never, f), getAnalyticsSettings(c.env, f.tenantId), activeFareAlerts(c.env, f.tenantId)]);
  return c.json({ filters: f, searchTracking: settings.searchTracking, ...data, activeFareAlerts: alerts });
});

// Fare alerts live in KV (lib/fare-insights.ts); read-only count, capped.
async function activeFareAlerts(env: Env, tenantId: string) {
  try {
    const page = await env.FARE_CACHE_KV.list({ prefix: `falert:${tenantId}:`, limit: 1000 });
    return { count: page.keys.length, capped: !page.list_complete };
  } catch {
    return null;
  }
}

analyticsAdminRoutes.get("/trend", async (c) => {
  const f = filters(c);
  return c.json({ filters: f, interval: interval(c), rows: await trend(c.get("db") as never, f, interval(c)) });
});

analyticsAdminRoutes.get("/sectors", async (c) => {
  const f = filters(c);
  const rows = await sectors(c.get("db") as never, f);
  if (!wantsCsv(c)) return c.json({ filters: f, rows });
  return csv(c, "sectors", f, [
    { key: "origin", label: "From" }, { key: "destination", label: "To" }, { key: "searches", label: "Searches" },
    { key: "searchers", label: "Unique searchers" }, { key: "fareSelected", label: "Fares selected" },
    { key: "bookingsCreated", label: "Bookings created" }, { key: "paidBookings", label: "Paid bookings (from searches)" },
    { key: "conversionPct", label: "Conversion %" }, { key: "abandoned", label: "Abandoned searches" },
    { key: "noAvailability", label: "No availability" }, { key: "revenueInr", label: "Revenue INR" }, { key: "revenueAed", label: "Revenue AED" },
    { key: "avgLowestInr", label: "Avg lowest fare INR" }, { key: "websitePaidBookings", label: "All paid website bookings" },
  ], rows.map((r) => ({ ...r, revenueInr: r.revenue.INR ?? 0, revenueAed: r.revenue.AED ?? 0 })), false);
});

analyticsAdminRoutes.get("/airports", async (c) => {
  const f = filters(c);
  const data = await airports(c.get("db") as never, f);
  if (!wantsCsv(c)) return c.json({ filters: f, ...data });
  const list = c.req.query("list") === "destinations" ? "destinations" : "departures";
  return csv(c, `airports-${list}`, f, [
    { key: "airport", label: list === "destinations" ? "Destination" : "Departure airport" }, { key: "searches", label: "Searches" },
    { key: "searchers", label: "Unique searchers" }, { key: "paidBookings", label: "Paid bookings" },
  ], data[list], false);
});

analyticsAdminRoutes.get("/dates", async (c) => {
  const f = filters(c);
  const data = await travelDates(c.get("db") as never, f);
  if (!wantsCsv(c)) return c.json({ filters: f, ...data });
  if (c.req.query("list") === "lead-time") {
    return csv(c, "lead-time", f, [{ key: "bucket", label: "Searched ahead" }, { key: "searches", label: "Searches" }, { key: "paidBookings", label: "Paid bookings" }], data.leadTime, false);
  }
  return csv(c, "travel-dates", f, [
    { key: "departureDate", label: "Departure date" }, { key: "searches", label: "Searches" }, { key: "searchers", label: "Unique searchers" },
    { key: "paidBookings", label: "Paid bookings" }, { key: "avgLowestInr", label: "Avg lowest fare INR" },
  ], data.dates, false);
});

const pageOf = (c: C) => Math.max(1, Math.min(10_000, Number.parseInt(c.req.query("page") ?? "1", 10) || 1));

analyticsAdminRoutes.get("/searches", async (c) => {
  const f = filters(c);
  const customers = await canSeeCustomers(c);
  const opts = { status: c.req.query("status"), origin: c.req.query("origin")?.toUpperCase(), destination: c.req.query("destination")?.toUpperCase(), customers };
  if (!wantsCsv(c)) return c.json({ filters: f, customerDetails: customers, page: pageOf(c), ...(await searchHistory(c.get("db") as never, f, { ...opts, page: pageOf(c) })) });
  const { rows } = await searchHistory(c.get("db") as never, f, { ...opts, page: 1, limit: MAX_EXPORT_ROWS });
  return csv(c, "search-history", f, [
    { key: "first_seen_at", label: "Searched at" }, { key: "last_seen_at", label: "Last seen" }, { key: "repeat_count", label: "Times repeated" },
    { key: "trip_type", label: "Trip" }, { key: "origin", label: "From" }, { key: "destination", label: "To" },
    { key: "departure_date", label: "Departure" }, { key: "return_date", label: "Return" }, { key: "adults", label: "Adults" },
    { key: "children", label: "Children" }, { key: "infants", label: "Infants" }, { key: "cabin_class", label: "Cabin" },
    { key: "fare_type", label: "Fare type" }, { key: "result_count", label: "Results" }, { key: "lowest_fare", label: "Lowest fare (per adult)" },
    { key: "currency", label: "Currency" }, { key: "status", label: "Status" }, { key: "booking_id", label: "Booking" },
    { key: "device", label: "Device" }, { key: "country", label: "Country" }, { key: "signed_in", label: "Signed in" }, { key: "visitor", label: "Visitor" },
    ...(customers ? [{ key: "customer_name", label: "Customer" }, { key: "customer_email", label: "Email" }, { key: "customer_phone", label: "Phone" }] : []),
  ], rows, customers);
});

analyticsAdminRoutes.get("/abandoned-checkouts", async (c) => {
  const f = filters(c);
  const customers = await canSeeCustomers(c);
  if (!wantsCsv(c)) return c.json({ filters: f, customerDetails: customers, page: pageOf(c), ...(await abandonedCheckouts(c.get("db") as never, f, { customers, page: pageOf(c) }) as object) });
  const { rows } = await abandonedCheckouts(c.get("db") as never, f, { customers, page: 1, limit: MAX_EXPORT_ROWS }) as { rows: Record<string, unknown>[] };
  return csv(c, "abandoned-checkouts", f, [
    { key: "created_at", label: "Created" }, { key: "booking_id", label: "Booking" }, { key: "status", label: "Status" },
    { key: "trip_type", label: "Trip" }, { key: "origin", label: "From" }, { key: "destination", label: "To" },
    { key: "departure_date", label: "Departure" }, { key: "adult_count", label: "Adults" }, { key: "child_count", label: "Children" },
    { key: "infant_count", label: "Infants" }, { key: "total_amount", label: "Amount" }, { key: "currency", label: "Currency" },
    { key: "supplier", label: "Supplier" }, { key: "signed_in", label: "Signed in" }, { key: "search_event_id", label: "Search" },
    ...(customers ? [{ key: "customer_name", label: "Customer" }, { key: "contact_email", label: "Email" }, { key: "contact_phone", label: "Phone" }] : []),
  ], rows, customers);
});

analyticsAdminRoutes.get("/revenue", async (c) => {
  const f = filters(c);
  const data = await revenue(c.get("db") as never, f, interval(c));
  if (!wantsCsv(c)) return c.json({ filters: f, interval: interval(c), ...data });
  if (c.req.query("list") === "sector") {
    return csv(c, "revenue-by-sector", f, [
      { key: "origin", label: "From" }, { key: "destination", label: "To" }, { key: "currency", label: "Currency" },
      { key: "paidBookings", label: "Paid bookings" }, { key: "revenue", label: "Revenue" },
    ], data.bySector, false);
  }
  return csv(c, `revenue-by-${interval(c)}`, f, [
    { key: "period", label: "Period" }, { key: "currency", label: "Currency" }, { key: "paidBookings", label: "Paid bookings" },
    { key: "revenue", label: "Revenue" }, { key: "markup", label: "Markup" }, { key: "cancelledAfterPayment", label: "Cancelled after payment" },
    { key: "refunded", label: "Refunded" },
  ], data.byPeriod, false);
});
