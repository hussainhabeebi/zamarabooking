import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env, Variables } from "../types.js";

// Per-tenant rate limiting via Durable Objects (stateful, accurate across Workers).
// Important: rate limiting is protective infrastructure, not part of the flight-search
// business path. If the Durable Object is temporarily unavailable, searches must still
// reach the suppliers instead of turning an infrastructure issue into a 500 response.
export const rateLimitMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const tenant    = c.get("tenant");
  const isSearch  = c.req.path.startsWith("/api/search");
  const isBooking = c.req.path.startsWith("/api/bookings");

  const limit = isSearch  ? tenant.searchRpmLimit
              : isBooking ? tenant.bookingRpmLimit
              : 200;

  try {
    if (!c.env.TENANT_RATE_LIMITER) {
      console.warn("[ratelimit] Durable Object binding missing; allowing request");
      return next();
    }

    const id  = c.env.TENANT_RATE_LIMITER.idFromName(tenant.id);
    const obj = c.env.TENANT_RATE_LIMITER.get(id);

    const res = await obj.fetch(new Request("https://internal/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenant.id, action: isSearch ? "search" : isBooking ? "booking" : "other", limit }),
    }));

    if (!res.ok) {
      console.warn(`[ratelimit] Durable Object returned ${res.status}; allowing request`);
      return next();
    }

    const { allowed } = await res.json() as { allowed: boolean; remaining: number };
    if (!allowed) {
      throw new HTTPException(429, { message: "Rate limit exceeded. Please slow down." });
    }
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    console.error("[ratelimit] check failed; allowing request", err);
  }

  return next();
};
