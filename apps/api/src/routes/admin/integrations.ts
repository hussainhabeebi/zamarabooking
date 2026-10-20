// GET  /api/admin/integrations/:supplier — get saved integration config (credentials masked)
// POST /api/admin/integrations/:supplier — save / update integration config
//
// Suppliers: riya | tripjack | duffel | serp
// Keys saved to TENANT_CACHE_KV as admin_settings:<tenantId>:integration:<supplier>
// The search route reads these as a fallback when env secrets are not set.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env, Variables } from "../../types.js";

export const integrationsAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const KV_TTL = 60 * 60 * 24 * 365;  // 1 year

function kvKey(tenantId: string, supplier: string) {
  return `admin_settings:${tenantId}:integration:${supplier}`;
}

function maskSecret(value: string | undefined | null): string {
  if (!value) return "";
  const v = String(value);
  return v.length > 8 ? `${v.slice(0, 4)}${"•".repeat(Math.min(v.length - 8, 12))}${v.slice(-4)}` : "•".repeat(v.length);
}

async function load(env: Env, tenantId: string, supplier: string) {
  const raw = await env.TENANT_CACHE_KV.get(kvKey(tenantId, supplier));
  return raw ? JSON.parse(raw) as Record<string, unknown> : null;
}

async function save(env: Env, tenantId: string, supplier: string, data: Record<string, unknown>) {
  await env.TENANT_CACHE_KV.put(kvKey(tenantId, supplier), JSON.stringify(data), { expirationTtl: KV_TTL });
}

// ── Riya ─────────────────────────────────────────────────────────────────────

const riyaSchema = z.object({
  enabled:    z.boolean(),
  apiKey:     z.string().optional(),
  apiSecret:  z.string().optional(),
  baseUrl:    z.string().url().optional(),
});

integrationsAdminRoutes.get("/riya", async (c) => {
  const tenantId = c.get("tenantId");
  const saved    = await load(c.env, tenantId, "riya");
  if (!saved) return c.json({ enabled: false, apiKey: "", apiSecret: "", baseUrl: "https://api.riya.travel/api/v4" });
  return c.json({
    enabled:   saved.enabled ?? false,
    apiKey:    maskSecret(saved.apiKey as string),
    apiSecret: maskSecret(saved.apiSecret as string),
    baseUrl:   saved.baseUrl ?? "https://api.riya.travel/api/v4",
  });
});

integrationsAdminRoutes.post("/riya", zValidator("json", riyaSchema), async (c) => {
  const tenantId = c.get("tenantId");
  const body     = c.req.valid("json");
  const existing = await load(c.env, tenantId, "riya") ?? {};
  const merged   = {
    enabled:   body.enabled,
    apiKey:    body.apiKey    || existing.apiKey,
    apiSecret: body.apiSecret || existing.apiSecret,
    baseUrl:   body.baseUrl   || existing.baseUrl || "https://api.riya.travel/api/v4",
  };
  await save(c.env, tenantId, "riya", merged);
  // Invalidate tenant cache so next search picks up new credentials
  const tenant = c.get("tenant");
  c.executionCtx.waitUntil(c.env.TENANT_CACHE_KV.delete(`tenant:host:${tenant.slug}.flypoomas.com`));
  return c.json({ ok: true });
});

// ── TripJack ─────────────────────────────────────────────────────────────────

const tripjackSchema = z.object({
  enabled:          z.boolean(),
  apiKey:           z.string().optional(),
  environment:      z.enum(["UAT", "PRODUCTION"]).default("UAT"),
  tripsafeEnabled:  z.boolean().default(false),
  cabsEnabled:      z.boolean().default(false),
  // TripJack user ID whose wallet pays for TripSafe policies (paymentOptions.payUserId).
  tripsafePayUserId: z.string().trim().regex(/^[0-9]*$/, "Numeric TripJack user ID").optional(),
});

integrationsAdminRoutes.get("/tripjack", async (c) => {
  const tenantId = c.get("tenantId");
  const saved    = await load(c.env, tenantId, "tripjack");
  if (!saved) return c.json({ enabled: false, apiKey: "", environment: "UAT", tripsafeEnabled: false, cabsEnabled: false });
  return c.json({
    enabled:         saved.enabled ?? false,
    apiKey:          maskSecret(saved.apiKey as string),
    environment:     saved.environment ?? "UAT",
    tripsafeEnabled: saved.tripsafeEnabled ?? false,
    cabsEnabled:     saved.cabsEnabled ?? false,
    tripsafePayUserId: saved.tripsafePayUserId ?? "",
  });
});

integrationsAdminRoutes.post("/tripjack", zValidator("json", tripjackSchema), async (c) => {
  const tenantId = c.get("tenantId");
  const body     = c.req.valid("json");
  const existing = await load(c.env, tenantId, "tripjack") ?? {};
  const baseUrl  = body.environment === "PRODUCTION"
    ? "https://api.tripjack.com"
    : "https://uat.tripjack.com";
  const merged   = {
    enabled:         body.enabled,
    apiKey:          body.apiKey || existing.apiKey,
    environment:     body.environment,
    baseUrl,
    tripsafeEnabled: body.tripsafeEnabled,
    cabsEnabled:     body.cabsEnabled,
    tripsafePayUserId: body.tripsafePayUserId ?? existing.tripsafePayUserId,
  };
  await save(c.env, tenantId, "tripjack", merged);
  const tenant = c.get("tenant");
  c.executionCtx.waitUntil(c.env.TENANT_CACHE_KV.delete(`tenant:host:${tenant.slug}.flypoomas.com`));
  return c.json({ ok: true });
});

// ── Duffel ───────────────────────────────────────────────────────────────────

const duffelSchema = z.object({
  enabled:     z.boolean(),
  apiKey:      z.string().optional(),
  environment: z.enum(["test", "live"]).default("test"),
});

integrationsAdminRoutes.get("/duffel", async (c) => {
  const tenantId = c.get("tenantId");
  const saved    = await load(c.env, tenantId, "duffel");
  if (!saved) return c.json({ enabled: false, apiKey: "", environment: "test" });
  return c.json({
    enabled:     saved.enabled ?? false,
    apiKey:      maskSecret(saved.apiKey as string),
    environment: saved.environment ?? "test",
  });
});

integrationsAdminRoutes.post("/duffel", zValidator("json", duffelSchema), async (c) => {
  const tenantId = c.get("tenantId");
  const body     = c.req.valid("json");
  const existing = await load(c.env, tenantId, "duffel") ?? {};
  const merged   = {
    enabled:     body.enabled,
    apiKey:      body.apiKey || existing.apiKey,
    environment: body.environment,
    baseUrl:     "https://api.duffel.com",
  };
  await save(c.env, tenantId, "duffel", merged);
  const tenant = c.get("tenant");
  c.executionCtx.waitUntil(c.env.TENANT_CACHE_KV.delete(`tenant:host:${tenant.slug}.flypoomas.com`));
  return c.json({ ok: true });
});

// ── Google Flights SERP ───────────────────────────────────────────────────────

const serpSchema = z.object({
  enabled: z.boolean(),
  apiKey:  z.string().optional(),
});

integrationsAdminRoutes.get("/serp", async (c) => {
  const tenantId = c.get("tenantId");
  const saved    = await load(c.env, tenantId, "serp");
  if (!saved) return c.json({ enabled: false, apiKey: "" });
  return c.json({ enabled: saved.enabled ?? false, apiKey: maskSecret(saved.apiKey as string) });
});

integrationsAdminRoutes.post("/serp", zValidator("json", serpSchema), async (c) => {
  const tenantId = c.get("tenantId");
  const body     = c.req.valid("json");
  const existing = await load(c.env, tenantId, "serp") ?? {};
  await save(c.env, tenantId, "serp", {
    enabled: body.enabled,
    apiKey:  body.apiKey || existing.apiKey,
    baseUrl: "https://serpapi.com",
  });
  return c.json({ ok: true });
});

// ── Status — list all integration health at a glance ─────────────────────────

integrationsAdminRoutes.get("/", async (c) => {
  const tenantId  = c.get("tenantId");
  const suppliers = ["riya", "tripjack", "duffel", "serp"];
  const results   = await Promise.all(
    suppliers.map(async (s) => {
      const saved = await load(c.env, tenantId, s);
      return { supplier: s, configured: !!saved?.apiKey, enabled: saved?.enabled ?? false };
    }),
  );
  return c.json(results);
});
