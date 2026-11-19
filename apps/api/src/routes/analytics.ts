// Phase 1 customer search tracking — the request hooks and the website's two small calls.
// Rules and privacy: lib/search-analytics.ts, docs/search-analytics.md.
//
//   trackSearch   middleware in front of POST /api/search: after the search has answered, records
//                 the search (background) and adds the header X-Search-Event-Id. The search route,
//                 its results, prices, cache and timing are not touched.
//   trackBooking  middleware in front of POST /api/book: after a booking was created, links it to
//                 the search it came from (searchEventId in the request body; the booking schema
//                 ignores the field). Never changes the booking or its answer.
//   POST /api/analytics/visit     { path, tracking }            once a day per visitor (website middleware)
//   POST /api/analytics/selected  { searchEventId, tracking }   the booking page was opened from a search
//
// Nothing is recorded unless Admin → Analytics → "Search tracking" is ON, and only for requests the
// website marks as its own (body field tracking.client "web", lib/search-analytics.ts). Every failure is
// logged and ignored.

import { Hono, type Context, type Next } from "hono";
import type { Env, Variables } from "../types.js";
import { optionalAgentId } from "../lib/agent-markup.js";
import {
  getAnalyticsSettings, isUuid, itineraryOf, linkSearchToBooking, markFareSelected, recordSearchEvent, recordSiteVisit,
  searchEventFor, summarizeResponse, trackingContext, type ClientTracking,
} from "../lib/search-analytics.js";

type C = Context<{ Bindings: Env; Variables: Variables }>;

const background = (c: C, label: string, work: () => Promise<unknown>) => {
  try {
    c.executionCtx.waitUntil(work().catch((err) => console.error(`[search-analytics] ${label}`, err)));
  } catch (err) {
    console.error(`[search-analytics] ${label}`, err);
  }
};

export async function trackSearch(c: C, next: Next) {
  if (c.req.method !== "POST") return next();
  let prep: Awaited<ReturnType<typeof prepareSearch>> = null;
  try {
    prep = await prepareSearch(c);
  } catch (err) {
    console.error("[search-analytics] prepare", err);
  }
  await next();
  if (!prep) return;
  try {
    const res = c.res;
    if (res.status === 400) return;   // not a valid search request: not counted
    const copy = res.clone();
    const out = new Response(res.body, res);
    out.headers.set("X-Search-Event-Id", prep.ev.id);
    c.res = out;
    const p = prep;
    background(c, "record search", async () => {
      const data = await copy.json().catch(() => null);
      await recordSearchEvent(c.get("db"), p.ctx, p.it, p.ev, summarizeResponse(copy.status, data, p.it.adults), p.currency);
    });
  } catch (err) {
    console.error("[search-analytics] after search", err);
  }
}

async function prepareSearch(c: C) {
  const body = await c.req.raw.clone().json().catch(() => null) as Record<string, unknown> | null;
  const tracking = body?.tracking as ClientTracking | undefined;
  if (!tracking || tracking.client !== "web") return null;
  const it = itineraryOf(body);
  if (!it) return null;
  const agencyCaller = Boolean(body?.agentNumber) || Boolean(await optionalAgentId(c));
  const ctx = await trackingContext(c.env, c.get("tenantId"), tracking, (n) => c.req.header(n), { agencyCaller });
  if (!ctx) return null;
  return { ctx, it, ev: await searchEventFor(ctx, it), currency: typeof body?.currency === "string" ? body.currency : null };
}

export async function trackBooking(c: C, next: Next) {
  if (c.req.method !== "POST") return next();
  let searchEventId: string | null = null;
  try {
    const body = await c.req.raw.clone().json().catch(() => null) as { searchEventId?: unknown } | null;
    if (isUuid(body?.searchEventId)) searchEventId = body!.searchEventId as string;
  } catch { /* never blocks the booking */ }
  await next();
  if (!searchEventId || !c.res.ok) return;
  try {
    const copy = c.res.clone();
    const se = searchEventId;
    background(c, "link booking", async () => {
      const d = await copy.json().catch(() => null) as { bookingId?: unknown } | null;
      if (typeof d?.bookingId === "string") await linkSearchToBooking(c.get("db"), c.get("tenantId"), se, d.bookingId);
    });
  } catch (err) {
    console.error("[search-analytics] after booking", err);
  }
}

export const analyticsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

analyticsRoutes.post("/visit", async (c) => {
  try {
    const body = await c.req.json().catch(() => null) as { path?: unknown; tracking?: ClientTracking } | null;
    const ctx = await trackingContext(c.env, c.get("tenantId"), body?.tracking, (n) => c.req.header(n));
    if (ctx) background(c, "record visit", () => recordSiteVisit(c.get("db"), ctx, typeof body?.path === "string" ? body.path : null));
  } catch (err) {
    console.error("[search-analytics] visit", err);
  }
  return c.body(null, 204);
});

analyticsRoutes.post("/selected", async (c) => {
  try {
    const body = await c.req.json().catch(() => null) as { searchEventId?: unknown; tracking?: ClientTracking } | null;
    const id = body?.searchEventId;
    if (body?.tracking?.client === "web" && isUuid(id) && (await getAnalyticsSettings(c.env, c.get("tenantId"))).searchTracking) {
      background(c, "fare selected", () => markFareSelected(c.get("db"), c.get("tenantId"), id));
    }
  } catch (err) {
    console.error("[search-analytics] selected", err);
  }
  return c.body(null, 204);
});
