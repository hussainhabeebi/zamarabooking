// Admin → Integrations → Akbar → "Baggage from SSR" (lib/akbar-search-baggage.ts). Full admins only;
// changes are written to the audit log. OFF by default.
//
// GET /api/admin/akbar-search-baggage
// PUT /api/admin/akbar-search-baggage   { enabled?, perMinute?, maxPerRequest?, concurrency?, productCacheHours?, timeoutMs?, source? }

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditLogs } from "@zamrabooking/db/schema";
import type { Env, Variables } from "../../types.js";
import { getSearchBaggageSettings, saveSearchBaggageSettings } from "../../lib/akbar-search-baggage.js";

export const akbarSearchBaggageAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
const FULL_ADMINS = ["SUPER_ADMIN", "TENANT_ADMIN"];
akbarSearchBaggageAdminRoutes.use("*", async (c, next) => {
  if (!FULL_ADMINS.includes(c.get("userRole") ?? "")) throw new HTTPException(403, { message: "Only admins can change Akbar settings." });
  return next();
});

akbarSearchBaggageAdminRoutes.get("/", async (c) => c.json(await getSearchBaggageSettings(c.env, c.get("tenantId"))));

const input = z.object({
  enabled: z.boolean().optional(), perMinute: z.number().optional(), maxPerRequest: z.number().optional(), concurrency: z.number().optional(),
  productCacheHours: z.number().optional(), timeoutMs: z.number().optional(), source: z.enum(["LV", "CF"]).optional(),
}).strict();

akbarSearchBaggageAdminRoutes.put("/", async (c) => {
  const parsed = input.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid settings" });
  const before = await getSearchBaggageSettings(c.env, c.get("tenantId"));
  const after = await saveSearchBaggageSettings(c.env, c.get("tenantId"), parsed.data, c.get("userId") ?? null);
  await c.get("db").insert(auditLogs).values({
    tenantId: c.get("tenantId"), userId: c.get("userId") ?? null, action: "AKBAR_SEARCH_BAGGAGE_UPDATED", entity: "Integration", entityId: "akbar-search-baggage", before, after,
  }).catch((err: unknown) => console.error("[akbar-search-baggage] audit", err));
  return c.json(after);
});
