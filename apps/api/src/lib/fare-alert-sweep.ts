// Cron: re-checks routes that have fare alerts but nobody searched recently.
// One live one-adult search per route + day; at most SWEEP_LIMIT per run,
// rotating through the list with a cursor so every route gets its turn.

import { createDb } from "@poomas/db";
import { markupRules, tenantSupplierConfigs } from "@poomas/db/schema";
import { eq } from "drizzle-orm";
import { searchFares } from "@poomas/suppliers";
import type { Env } from "../types.js";
import { resolveFlightSuppliers } from "../routes/search.js";
import { applyMarkup } from "./markup.js";
import { recordFareObservation, sendFareAlerts } from "./fare-insights.js";

const SWEEP_LIMIT = 15;
const CURSOR_KEY = "falert_sweep_cursor";

export async function sweepFareAlerts(env: Env) {
  const kv = env.FARE_CACHE_KV;
  const cursor = (await kv.get(CURSOR_KEY).catch(() => null)) ?? undefined;
  const page = await kv.list({ prefix: "falert_route:", limit: SWEEP_LIMIT, cursor });
  await kv.put(CURSOR_KEY, page.list_complete ? "" : page.cursor, { expirationTtl: 7 * 86_400 }).catch(() => {});
  if (!page.keys.length) return { checked: 0 };

  const db = createDb(env.DATABASE_URL);
  const today = new Date().toISOString().slice(0, 10);
  const tenantCache = new Map<string, Awaited<ReturnType<typeof tenantSearchSetup>>>();
  let checked = 0;

  for (const { name } of page.keys) {
    // falert_route:<tenant>:<ORG>-<DST>:<date>:<CUR>
    const m = /^falert_route:([^:]+):([A-Z]{3})-([A-Z]{3}):(\d{4}-\d{2}-\d{2}):([A-Z]{3})$/.exec(name);
    if (!m) continue;
    const [, tenantId, origin, destination, date, currency] = m;
    if (date < today) continue;
    // A customer searched this route in the last 3 hours: the calendar is fresh.
    const cal = await kv.get(`pcal:${tenantId}:${origin}-${destination}:${date.slice(0, 7)}:${currency}`, "json").catch(() => null) as Record<string, { at: number }> | null;
    if (cal?.[date.slice(8, 10)] && Date.now() - cal[date.slice(8, 10)].at < 3 * 3600_000) continue;

    try {
      if (!tenantCache.has(tenantId)) tenantCache.set(tenantId, await tenantSearchSetup(env, db, tenantId));
      const setup = tenantCache.get(tenantId)!;
      if (!setup.supplierConfigs.some((s) => s.isEnabled)) continue;
      const params = {
        origin, destination, departureDate: date, adults: 1, children: 0, infants: 0,
        cabinClass: "ECONOMY" as const, tripType: "ONEWAY" as const, currency: currency as "INR" | "AED" | "USD",
      };
      const result = await searchFares(params, setup.supplierConfigs, { platformCredentials: setup.platformCredentials });
      const priced = result.fares.map((f) => ({ ...f, displayPrice: applyMarkup(f, setup.rules) }));
      checked++;
      const due = await recordFareObservation(kv, tenantId, { ...params, fareType: "REGULAR" }, priced);
      if (due.length) await sendFareAlerts(env, db, due);
    } catch (err) {
      console.error(`[fare-alert-sweep] ${name} failed`, err);
    }
  }
  return { checked };
}

async function tenantSearchSetup(env: Env, db: ReturnType<typeof createDb>, tenantId: string) {
  const rows = await db.select().from(tenantSupplierConfigs).where(eq(tenantSupplierConfigs.tenantId, tenantId));
  const { platformCredentials, supplierConfigs } = await resolveFlightSuppliers(env, {
    supplierConfigs: rows.map((s) => ({
      supplier: s.supplier, isEnabled: s.isEnabled, priority: s.priority,
      credentials: s.credentials as Record<string, string> | null, timeoutMs: s.timeoutMs, maxRetries: s.maxRetries,
    })),
  } as unknown as Parameters<typeof resolveFlightSuppliers>[1], tenantId);
  // Same rules the search page applies, so alert prices match what customers see.
  const rules = await db.select().from(markupRules).where(eq(markupRules.tenantId, tenantId)).catch(() => []);
  return { platformCredentials, supplierConfigs, rules };
}
