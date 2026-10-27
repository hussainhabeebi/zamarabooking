import { Hono } from "hono";
import { supplierApiLogs, tenantSupplierConfigs, tenants } from "@zamrabooking/db/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import type { Env, Variables } from "../../types.js";
import { requireRole } from "../../middleware/auth.js";
import { resolveFlightSuppliers } from "../search.js";
import { getAkbarSettings, getManualSettings, getPoomasSettings } from "../../lib/flight-sources.js";

export const suppliersAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// View supplier configs — SUPER_ADMIN sees all tenants (or filter by ?tenantId=)
suppliersAdminRoutes.get("/", async (c) => {
  const db             = c.get("db");
  const role           = c.get("userRole");
  const filterTenantId = role === "SUPER_ADMIN"
    ? c.req.query("tenantId")
    : c.get("tenantId");

  const query = db
    .select({
      id:             tenantSupplierConfigs.id,
      supplier:       tenantSupplierConfigs.supplier,
      isEnabled:      tenantSupplierConfigs.isEnabled,
      priority:       tenantSupplierConfigs.priority,
      timeoutMs:      tenantSupplierConfigs.timeoutMs,
      maxRetries:     tenantSupplierConfigs.maxRetries,
      callsThisMonth: tenantSupplierConfigs.callsThisMonth,
      callsLimit:     tenantSupplierConfigs.callsLimit,
    })
    .from(tenantSupplierConfigs);

  const rows = filterTenantId
    ? await query.where(eq(tenantSupplierConfigs.tenantId, filterTenantId))
    : await query;

  return c.json({ suppliers: rows });
});

// Which flight sources customer search uses right now, worked out exactly as search does,
// with this month's errors from the API logs. Each source is switched on where `configure` says.
suppliersAdminRoutes.get("/status", async (c) => {
  const tenantId = c.get("tenantId");
  const db = c.get("db");
  const [{ supplierConfigs }, akbar, poomas, manual] = await Promise.all([
    resolveFlightSuppliers(c.env, c.get("tenant"), tenantId),
    getAkbarSettings(c.env, tenantId), getPoomasSettings(c.env, tenantId), getManualSettings(c.env, tenantId),
  ]);
  const inSearch = (name: string) => supplierConfigs.some((s) => s.name === name && s.isEnabled);

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const errors = await db.select({
    supplier:  supplierApiLogs.supplier,
    count:     sql<number>`count(*)::int`,
    lastError: sql<string>`max(${supplierApiLogs.createdAt})`,
  }).from(supplierApiLogs)
    .where(and(eq(supplierApiLogs.tenantId, tenantId), eq(supplierApiLogs.level, "ERROR"), gte(supplierApiLogs.createdAt, monthStart)))
    .groupBy(supplierApiLogs.supplier)
    .catch(() => []);
  const errorsOf = (name: string) => errors.find((e) => e.supplier === name);

  const sources = [
    {
      supplier: "TRIPJACK", live: inSearch("TRIPJACK"), configure: "/integrations", booking: "Booked and ticketed through the API",
      note: inSearch("TRIPJACK") ? "" : "Off — switch on flight search in Integrations → TripJack (and check the TripJack secrets).",
    },
    {
      supplier: "AKBAR", live: inSearch("AKBAR"), configure: "/flight-sources", booking: "Paid on Zamra, ticketed by staff on the Akbar portal",
      note: inSearch("AKBAR") ? "" : akbar.enabled ? "Switched on, but its credentials are incomplete." : "Off.",
    },
    {
      supplier: "POOMAS", live: inSearch("POOMAS"), configure: "/flight-sources", booking: "Paid on Zamra, ticketed by staff on Poomas",
      note: inSearch("POOMAS") ? "" : poomas.enabled ? "Switched on, but the API key is missing." : "Off.",
    },
    {
      supplier: "MANUAL", live: manual.enabled, configure: "/manual-fares", booking: "Paid on Zamra, ticketed by staff",
      note: manual.enabled ? "" : "Off.",
    },
    ...(["RIYA", "DUFFEL", "GOOGLE_SERP"] as const).map((supplier) => ({
      supplier, live: inSearch(supplier), configure: null, booking: "",
      note: inSearch(supplier) ? "" : "Not in use — turned off in the code.",
    })),
  ];
  return c.json({
    sources: sources.map((s) => ({ ...s, errorsThisMonth: errorsOf(s.supplier)?.count ?? 0, lastError: errorsOf(s.supplier)?.lastError ?? null })),
  });
});

// Enable/disable a supplier or update priority
suppliersAdminRoutes.patch("/:supplier", async (c) => {
  requireRole("TENANT_ADMIN", "SUPER_ADMIN")(c.get("userRole"));

  const body = await c.req.json() as {
    isEnabled?: boolean;
    priority?:  number;
    timeoutMs?: number;
    callsLimit?: number;
  };
  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  await db.update(tenantSupplierConfigs)
    .set({ ...body, updatedAt: new Date() })
    .where(
      and(
        eq(tenantSupplierConfigs.tenantId, tenantId),
        eq(tenantSupplierConfigs.supplier, c.req.param("supplier") as "RIYA"),
      ),
    );

  // Invalidate tenant cache so next request picks up new supplier config
  const tenant = c.get("tenant");
  await c.env.TENANT_CACHE_KV.delete(`tenant:host:${tenant.slug}.zamrabooking.com`);

  return c.json({ ok: true });
});

// Seed default TRIPJACK + RIYA entries for all tenants that don't have them yet
suppliersAdminRoutes.post("/seed", async (c) => {
  requireRole("SUPER_ADMIN")(c.get("userRole"));
  const db = c.get("db");

  const allTenants = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants);
  let seeded = 0;
  for (const t of allTenants) {
    for (const [supplier, priority] of [["TRIPJACK", 2], ["RIYA", 1]] as const) {
      await db.insert(tenantSupplierConfigs).values({
        tenantId: t.id, supplier, priority, isEnabled: true,
        timeoutMs: 20000, maxRetries: 1,
      }).onConflictDoNothing();
      seeded++;
    }
  }
  return c.json({ ok: true, seeded, tenants: allTenants.length });
});
