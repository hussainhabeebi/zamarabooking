import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env, Variables } from "../types.js";
import { DISPLAY_CURRENCIES } from "../lib/fx.js";

const SESSION_PREFS_TTL = 60 * 60 * 24 * 30; // 30 days
const ACCOUNT_PREFS_TTL = 60 * 60 * 24 * 365; // signed-in customers: kept with the login

const prefsSchema = z.object({
  currency: z.enum(DISPLAY_CURRENCIES),
});

export const sessionRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

function prefKey(tenantId: string, sessionId: string) {
  return `session_prefs:${tenantId}:${sessionId}`;
}

// GET /api/session/preferences — returns current session preferences
sessionRoutes.get("/preferences", async (c) => {
  const tenantId  = c.get("tenantId");
  const tenant    = c.get("tenant");
  const sessionId = c.get("userId") ?? c.req.header("X-Session-ID") ?? null;

  if (!sessionId) {
    return c.json({ currency: tenant.defaultCurrency, saved: false });
  }

  const saved = await c.env.SESSIONS_KV.get(prefKey(tenantId, sessionId), "json") as { currency?: string } | null;
  return c.json({ currency: saved?.currency ?? tenant.defaultCurrency, saved: Boolean(saved?.currency) });
});

// PUT /api/session/preferences — sets session-level preferences (persists 30 days)
sessionRoutes.put("/preferences", zValidator("json", prefsSchema), async (c) => {
  const { currency } = c.req.valid("json");
  const tenantId  = c.get("tenantId");
  const sessionId = c.get("userId") ?? c.req.header("X-Session-ID") ?? null;

  if (sessionId) {
    const key      = prefKey(tenantId, sessionId);
    const existing = await c.env.SESSIONS_KV.get(key, "json") as Record<string, unknown> | null;
    c.executionCtx.waitUntil(
      c.env.SESSIONS_KV.put(
        key,
        JSON.stringify({ ...(existing ?? {}), currency }),
        { expirationTtl: c.get("userId") ? ACCOUNT_PREFS_TTL : SESSION_PREFS_TTL },
      ),
    );
  }

  return c.json({ currency });
});
