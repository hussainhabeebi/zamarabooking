import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { tenants, tenantSupplierConfigs, bookings, agents } from "@poomas/db/schema";
import { eq, sql } from "drizzle-orm";
import type { Env, Variables } from "../../types.js";
import { requireRole } from "../../middleware/auth.js";

export const tenantsAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// All tenant management is SUPER_ADMIN only
tenantsAdminRoutes.use("*", (c, next) => {
  requireRole("SUPER_ADMIN")(c.get("userRole"));
  return next();
});

tenantsAdminRoutes.get("/", async (c) => {
  const db = c.get("db");
  const rows = await db.select().from(tenants);
  return c.json(rows);
});

tenantsAdminRoutes.get("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
  if (!tenant) throw new HTTPException(404, { message: "Tenant not found" });
  const [[bookingStats], [agentStats], suppliers] = await Promise.all([
    db.select({ total: sql<number>`count(*)::int`, ticketed: sql<number>`count(*) filter (where ${bookings.status} = 'TICKETED')::int` })
      .from(bookings).where(eq(bookings.tenantId, id)),
    db.select({ total: sql<number>`count(*)::int` }).from(agents).where(eq(agents.tenantId, id)),
    db.select({ supplier: tenantSupplierConfigs.supplier, isEnabled: tenantSupplierConfigs.isEnabled, priority: tenantSupplierConfigs.priority })
      .from(tenantSupplierConfigs).where(eq(tenantSupplierConfigs.tenantId, id)),
  ]);
  return c.json({ tenant, stats: { bookings: bookingStats?.total ?? 0, ticketed: bookingStats?.ticketed ?? 0, agents: agentStats?.total ?? 0 }, suppliers });
});

const createTenantSchema = z.object({
  name:            z.string().min(2),
  slug:            z.string().min(2).regex(/^[a-z0-9-]+$/),
  customDomain:    z.string().optional(),
  plan:            z.enum(["TRIAL", "STARTER", "PROFESSIONAL", "ENTERPRISE"]).default("TRIAL"),
  region:          z.enum(["INDIA", "GCC"]).default("INDIA"),
  defaultCurrency: z.enum(["INR", "AED", "USD"]).default("INR"),
  primaryColor:    z.string().optional(),
  secondaryColor:  z.string().optional(),
  logoUrl:         z.string().url().optional(),
  supportEmail:    z.string().email().optional(),
});

// Tenant onboarding wizard step 1: create tenant record
tenantsAdminRoutes.post("/", zValidator("json", createTenantSchema), async (c) => {
  const body = c.req.valid("json");
  const db   = c.get("db");

  const [tenant] = await db.insert(tenants).values({
    ...body,
    status:         "ONBOARDING",
    showPoweredBy:  body.plan === "TRIAL" || body.plan === "STARTER",
    onboardingStep: 1,
  }).returning();

  // Auto-provision default supplier configs (inheriting platform credentials)
  await db.insert(tenantSupplierConfigs).values([
    { tenantId: tenant.id, supplier: "RIYA",        priority: 1, isEnabled: true },
    { tenantId: tenant.id, supplier: "TRIPJACK",    priority: 2, isEnabled: true },
    { tenantId: tenant.id, supplier: "GOOGLE_SERP", priority: 3, isEnabled: false },
  ]);

  // Invalidate tenant cache for this slug/domain
  await c.env.TENANT_CACHE_KV.delete(`tenant:host:${tenant.slug}.flypoomas.com`);

  return c.json({ tenantId: tenant.id }, 201);
});

// Tenant status update (activate, suspend, close)
tenantsAdminRoutes.patch("/:id/status", async (c) => {
  const { status } = await c.req.json() as { status: string };
  if (!["ONBOARDING", "ACTIVE", "SUSPENDED", "CLOSED"].includes(status)) {
    throw new HTTPException(400, { message: "Invalid status" });
  }
  const db = c.get("db");

  await db.update(tenants)
    .set({ status: status as "ONBOARDING" | "ACTIVE" | "SUSPENDED" | "CLOSED", updatedAt: new Date() })
    .where(eq(tenants.id, c.req.param("id")));

  // Evict from KV cache so next request reloads from DB
  const [row] = await db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, c.req.param("id")));
  if (row) {
    await c.env.TENANT_CACHE_KV.delete(`tenant:host:${row.slug}.flypoomas.com`);
  }

  return c.json({ ok: true });
});

// Branding update
tenantsAdminRoutes.patch("/:id/branding", async (c) => {
  const body = await c.req.json() as Partial<{
    logoUrl: string; primaryColor: string; secondaryColor: string; accentColor: string;
    fontFamily: string; companyName: string; tagline: string; showPoweredBy: boolean;
  }>;
  const db = c.get("db");

  await db.update(tenants).set({ ...body, updatedAt: new Date() }).where(eq(tenants.id, c.req.param("id")));

  return c.json({ ok: true });
});
