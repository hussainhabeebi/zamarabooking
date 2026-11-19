// POST /api/fare-baggage — confirmed included baggage for Akbar search results (lib/akbar-search-baggage.ts).
// Body: { fareIds: ["AK|<tui>|<index>", …] (at most 10), adults, children, infants }.
// Answer: { enabled, fares: { [fareId]: { status, baggage?, child?, infant?, segments? } } }.
// Off (Admin → Integrations → Akbar → "Baggage from SSR") → { enabled: false } and no Akbar call.
// Never fails the page: any problem answers 200 with the fares UNKNOWN.

import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables } from "../types.js";
import { getSearchBaggageSettings, liveSearchBaggage } from "../lib/akbar-search-baggage.js";

const body = z.object({
  fareIds:  z.array(z.string().min(4).max(600)).min(1).max(10),
  adults:   z.number().int().min(1).max(9).default(1),
  children: z.number().int().min(0).max(9).default(0),
  infants:  z.number().int().min(0).max(4).default(0),
});

export const fareBaggageRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

fareBaggageRoutes.post("/", async (c) => {
  const parsed = body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "fareIds (1–10) and passenger counts are required" }, 400);
  const tenantId = c.get("tenantId");
  const settings = await getSearchBaggageSettings(c.env, tenantId);
  if (!settings.enabled) return c.json({ enabled: false, fares: {} });
  const { fareIds, adults, children, infants } = parsed.data;
  try {
    const fares = await liveSearchBaggage(c, c.get("db"), tenantId, fareIds, { adults, children, infants }, settings);
    return c.json({ enabled: fares !== null, fares: fares ?? {} });
  } catch (err) {
    console.error("[fare-baggage]", err);
    return c.json({ enabled: true, fares: Object.fromEntries(fareIds.map((id) => [id, { status: "UNKNOWN" }])) });
  }
});
