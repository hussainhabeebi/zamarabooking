import { Hono } from "hono";
import { tenantSupplierConfigs, tenants } from "@poomas/db/schema";
import { eq, and, sql } from "drizzle-orm";
import type { Env, Variables } from "../../types.js";
import { requireRole } from "../../middleware/auth.js";

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
  await c.env.TENANT_CACHE_KV.delete(`tenant:host:${tenant.slug}.flypoomas.com`);

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
