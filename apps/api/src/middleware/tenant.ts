import type { MiddlewareHandler } from "hono";
import type { Env, Variables, TenantContext } from "../types.js";
import { createDb } from "@poomas/db";
import { tenants, tenantSupplierConfigs } from "@poomas/db/schema";
import { eq, and } from "drizzle-orm";

const TENANT_CACHE_TTL = 60;

// Derives tenant_id from the request hostname (subdomain or custom domain).
// Never trusts X-Tenant-ID header from clients — all tenant derivation is server-side.
export const resolveTenant: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  // @poomas/db currently uses drizzle-orm/neon-http. That driver must receive the
  // actual Neon DATABASE_URL. A Cloudflare Hyperdrive connectionString is a Postgres
  // proxy socket URL and is NOT compatible with neon-http; using it can result in
  // Cloudflare origin/DNS failures before the route handler executes.
  if (!c.env.DATABASE_URL) {
    console.error("[tenant] DATABASE_URL Worker secret is not configured");
    return c.json({ error: "Database connection is not configured" }, 503);
  }

  const db = createDb(c.env.DATABASE_URL);
  c.set("db", db);

  const host = new URL(c.req.url).hostname;

  // Check KV cache first (tenant config is read-hot). KV failure must not prevent a DB lookup.
  const cacheKey = `tenant:host:${host}`;
  let cached: TenantContext | null = null;
  try {
    cached = await c.env.TENANT_CACHE_KV.get(cacheKey, "json") as TenantContext | null;
  } catch (err) {
    console.error("[tenant] cache read failed", err);
  }

  if (cached) {
    c.set("tenantId", cached.id);
    c.set("tenant",   cached);
    return next();
  }

  const slug = extractSlug(host, c.env.PLATFORM_TENANT_SLUG);

  const rows = await db
    .select({
      id:              tenants.id,
      slug:            tenants.slug,
      name:            tenants.name,
      plan:            tenants.plan,
      region:          tenants.region,
      defaultCurrency: tenants.defaultCurrency,
      searchRpmLimit:  tenants.searchRpmLimit,
      bookingRpmLimit: tenants.bookingRpmLimit,
      status:          tenants.status,
      paymentConfig:   tenants.paymentConfig,
    })
    .from(tenants)
    .where(
      slug === "__custom__"
        ? eq(tenants.customDomain, host)
        : eq(tenants.slug, slug),
    )
    .limit(1);

  const tenant = rows[0];
  if (!tenant) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  if (tenant.status === "SUSPENDED" || tenant.status === "CLOSED") {
    return c.json({ error: "Account suspended" }, 403);
  }

  const supplierRows = await db
    .select()
    .from(tenantSupplierConfigs)
    .where(
      and(
        eq(tenantSupplierConfigs.tenantId, tenant.id),
        eq(tenantSupplierConfigs.isEnabled, true),
      ),
    );

  const tenantCtx: TenantContext = {
    id:              tenant.id,
    slug:            tenant.slug,
    name:            tenant.name,
    plan:            tenant.plan,
    region:          tenant.region,
    defaultCurrency: tenant.defaultCurrency,
    searchRpmLimit:  tenant.searchRpmLimit,
    bookingRpmLimit: tenant.bookingRpmLimit,
    paymentConfig:   tenant.paymentConfig as TenantContext["paymentConfig"],
    supplierConfigs: supplierRows.map((r) => ({
      supplier:    r.supplier,
      isEnabled:   r.isEnabled,
      priority:    r.priority,
      credentials: r.credentials as Record<string, string> | null,
      timeoutMs:   r.timeoutMs,
      maxRetries:  r.maxRetries,
    })),
  };

  try {
    await c.env.TENANT_CACHE_KV.put(cacheKey, JSON.stringify(tenantCtx), {
      expirationTtl: TENANT_CACHE_TTL,
    });
  } catch (err) {
    console.error("[tenant] cache write failed", err);
  }

  c.set("tenantId", tenant.id);
  c.set("tenant",   tenantCtx);

  return next();
};

function extractSlug(host: string, platformSlug: string): string {
  // workers.dev is a platform/debug hostname, so resolve it to the platform tenant.
  if (host.endsWith(".workers.dev")) {
    return platformSlug;
  }

  if (!host.endsWith(".flypoomas.com") && host !== "flypoomas.com" && host !== "api.flypoomas.com") {
    return "__custom__";
  }

  if (host === "api.flypoomas.com" || host === "flypoomas.com") {
    return platformSlug;
  }

  return host.split(".")[0];
}
