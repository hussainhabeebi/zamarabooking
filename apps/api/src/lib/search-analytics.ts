// Phase 1 customer search tracking (docs/search-analytics.md, migration 0015_search_analytics.sql).
//
// What counts as ONE search: one visitor, one exact itinerary (route, dates, passengers, cabin,
// fare type), one day in India time. Refreshes, back-navigation, currency changes and repeated or
// cached requests that day only raise repeat_count. Supplier polling / retries happen inside one
// API request and are never seen here. Agency, Partner API, bot, prefetch and background
// (fare-alert sweep) searches are not customer searches and are not recorded.
//
// Privacy: no IP address, user agent, name, email or phone is stored. The visitor cookie (zb_vid,
// a random UUID) is stored only as an HMAC with a server secret. Browsers that send Global Privacy
// Control / Do Not Track get no visitor cookie (the website skips it); their searches are counted
// without a visitor.
//
// Everything here is best effort: it runs after the customer's answer, never changes it, and every
// failure (KV, database, tables not migrated yet) is swallowed and logged.

import { jwtVerify } from "jose";
import { and, eq, lt, sql } from "drizzle-orm";
import { searchEvents, siteVisits } from "@zamrabooking/db/schema";
import type { Env } from "../types.js";
import { cheapestPerAdult } from "./fare-insights.js";

type Db = any;

// Kept 13 months, then deleted by the cron (purgeAnalytics).
export const ANALYTICS_RETENTION_DAYS = 396;
// A search with results is "abandoned" when nothing was booked within this window.
export const ABANDON_WINDOW_HOURS = 24;

// ── Admin switch (off until an admin turns it on) ───────────────────────────────

export interface AnalyticsSettings { searchTracking: boolean; updatedAt?: string; updatedBy?: string | null }
const settingsKey = (tenantId: string) => `admin_settings:${tenantId}:analytics`;

export async function getAnalyticsSettings(env: Pick<Env, "TENANT_CACHE_KV">, tenantId: string): Promise<AnalyticsSettings> {
  try {
    const saved = await env.TENANT_CACHE_KV.get(settingsKey(tenantId), "json") as Partial<AnalyticsSettings> | null;
    return { searchTracking: saved?.searchTracking === true, ...(saved?.updatedAt ? { updatedAt: saved.updatedAt } : {}), ...(saved?.updatedBy !== undefined ? { updatedBy: saved.updatedBy ?? null } : {}) };
  } catch {
    return { searchTracking: false };
  }
}

export async function saveAnalyticsSettings(env: Pick<Env, "TENANT_CACHE_KV">, tenantId: string, searchTracking: boolean, userId: string | null) {
  const value: AnalyticsSettings = { searchTracking, updatedAt: new Date().toISOString(), updatedBy: userId };
  await env.TENANT_CACHE_KV.put(settingsKey(tenantId), JSON.stringify(value));
  return value;
}

// ── Small pure helpers (unit tested) ─────────────────────────────────────────────

const IST_OFFSET_MS = 330 * 60_000;
/** Calendar day in India time, "YYYY-MM-DD". */
export const istDay = (at: Date = new Date()) => new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const BOT_RE = /bot\b|bot\/|crawl|spider|slurp|bingpreview|facebookexternalhit|facebot|whatsapp|telegrambot|skypeuripreview|embedly|preview|headless|lighthouse|pagespeed|python-|curl\/|wget|httpclient|go-http|java\/|okhttp|axios|node-fetch|uptime|monitor|pingdom|semrush|ahrefs|mj12/i;
export const isBot = (ua: string | null | undefined) => !ua || BOT_RE.test(ua);

export function deviceClass(ua: string | null | undefined): "mobile" | "tablet" | "desktop" | null {
  if (!ua) return null;
  if (/iPad|Tablet|Kindle|Silk|PlayBook|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Opera Mini|IEMobile/i.test(ua)) return "mobile";
  return "desktop";
}
const DEVICES = new Set(["mobile", "tablet", "desktop"]);
export const cleanDevice = (v: string | null | undefined) => (v && DEVICES.has(v) ? v as "mobile" | "tablet" | "desktop" : null);
export const cleanCountry = (v: string | null | undefined) => {
  const cc = (v ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(cc) && cc !== "XX" && cc !== "T1" ? cc : null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
export async function sha256Hex(text: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
/** HMAC of the visitor cookie value — the database never sees the cookie itself. */
export async function visitorHash(secret: string, visitorId: string | null | undefined): Promise<string | null> {
  if (!secret || !isUuid(visitorId)) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`zb-search-analytics-v1:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(visitorId!.toLowerCase())));
}

/** A uuid-shaped id derived from the dedupe key: the same search always gets the same id. */
export function eventIdFromKey(dedupeKeyHex: string) {
  const h = dedupeKeyHex.padEnd(32, "0");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// The itinerary of a /api/search request body, normalized. Currency is NOT part of it.
export interface Itinerary {
  tripType: "ONEWAY" | "ROUNDTRIP" | "MULTICITY";
  origin: string; destination: string; departureDate: string; returnDate: string | null;
  legs: { origin: string; destination: string; departureDate: string }[] | null;
  adults: number; children: number; infants: number;
  cabinClass: string; fareType: string | null;
}
const IATA = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CABINS = new Set(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]);
const int = (v: unknown, d: number) => (Number.isInteger(v) ? Number(v) : d);

/** null when the body is not a complete flight search (those get a 400 and are not counted). */
export function itineraryOf(body: unknown): Itinerary | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const up = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : "");
  const tripType = up(b.tripType) === "ROUNDTRIP" ? "ROUNDTRIP" : up(b.tripType) === "MULTICITY" ? "MULTICITY" : "ONEWAY";
  const legs = Array.isArray(b.legs)
    ? (b.legs as Record<string, unknown>[]).map((l) => ({ origin: up(l?.origin), destination: up(l?.destination), departureDate: String(l?.departureDate ?? "") }))
    : null;
  if (legs && !legs.every((l) => IATA.test(l.origin) && IATA.test(l.destination) && DAY.test(l.departureDate))) return null;
  const origin = up(b.origin), destination = up(b.destination), departureDate = String(b.departureDate ?? "");
  if (!IATA.test(origin) || !IATA.test(destination) || !DAY.test(departureDate)) return null;
  const returnDate = tripType === "ROUNDTRIP" && typeof b.returnDate === "string" && DAY.test(b.returnDate) ? b.returnDate : null;
  const fareType = up(b.fareType);
  const cabin = up(b.cabinClass);
  return {
    tripType, origin, destination, departureDate, returnDate,
    legs: tripType === "MULTICITY" ? legs : null,
    adults: int(b.adults, 1), children: int(b.children, 0), infants: int(b.infants, 0),
    cabinClass: CABINS.has(cabin) ? cabin : "ECONOMY",
    fareType: fareType === "STUDENT" || fareType === "SENIOR_CITIZEN" ? fareType : null,
  };
}

/** sha256 of tenant | visitor | itinerary | India day. */
export function dedupeKey(tenantId: string, who: string, it: Itinerary, day: string) {
  const legs = (it.legs ?? []).map((l) => `${l.origin}-${l.destination}-${l.departureDate}`).join(",");
  return sha256Hex([
    tenantId, who, day, it.tripType, it.origin, it.destination, it.departureDate, it.returnDate ?? "", legs,
    it.adults, it.children, it.infants, it.cabinClass, it.fareType ?? "",
  ].join("|"));
}

/** The search answer (as the API returned it) → what we keep about it. */
export function summarizeResponse(status: number, data: unknown, adults: number) {
  const d = (data && typeof data === "object" ? data : {}) as { fares?: unknown; fromCache?: unknown; searchId?: unknown; supplierErrors?: unknown; currency?: unknown };
  const fares = Array.isArray(d.fares) ? d.fares as { totalFare: number; displayPrice?: number; perAdultFare?: number; currency?: string }[] : [];
  const outcome: "RESULTS" | "NO_RESULTS" | "ERROR" = status >= 400 ? "ERROR"
    : fares.length ? "RESULTS"
    : d.supplierErrors && typeof d.supplierErrors === "object" && Object.keys(d.supplierErrors).length ? "ERROR" : "NO_RESULTS";
  const lowest = fares.length ? cheapestPerAdult(fares as never, adults) : null;
  return {
    outcome,
    resultCount: fares.length,
    lowestFare: lowest,
    fareCurrency: typeof fares[0]?.currency === "string" ? fares[0].currency : null,
    cacheHit: d.fromCache === true,
    supplierSearchId: typeof d.searchId === "string" ? d.searchId : null,
  };
}

// ── Who is searching (website requests only) ─────────────────────────────────────

export interface TrackingContext {
  tenantId: string;
  visitorHash: string | null;
  userId: string | null;
  device: string | null;
  country: string | null;
}

/** A signed-in customer from the website's tracking field (never the Authorization header). */
export async function customerFromToken(env: Pick<Env, "JWT_SECRET" | "SESSIONS_KV">, tenantId: string, token: string | null | undefined): Promise<string | null> {
  if (typeof token !== "string" || !token || token.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env.JWT_SECRET)) as { payload: { userId?: string; tenantId?: string; role?: string; sessionId?: string } };
    if (payload.role !== "CUSTOMER" || payload.tenantId !== tenantId || !payload.userId || !payload.sessionId) return null;
    const session = await env.SESSIONS_KV.get(`session:${payload.userId}`, "json") as { sessionId?: string } | null;
    return session?.sessionId === payload.sessionId ? payload.userId : null;
  } catch {
    return null;
  }
}

/**
 * What the website adds to its requests, in the JSON body as `tracking` (not headers: a browser
 * request with new headers would need the API's CORS change first, and the website may go live
 * before the API). Routes that don't know it ignore it (their schemas drop unknown fields).
 *   client    "web" — only website requests are ever recorded
 *   visitor   the zb_vid cookie (stored only as a keyed hash); absent when the browser opted out
 *   customer  the customer's login token, read only here
 *   device / country / bot / prefetch   forwarded by the website's server for the visitor's page
 */
export interface ClientTracking {
  client?: unknown; visitor?: unknown; customer?: unknown; device?: unknown; country?: unknown; bot?: unknown; prefetch?: unknown;
}
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

type HeaderReader = (name: string) => string | undefined;

/**
 * The tracking context of a request, or null when it must not be recorded: tracking switched off,
 * not marked by the website (tracking.client "web"), an agency or Partner API caller, a bot, a prefetch.
 */
export async function trackingContext(env: Env, tenantId: string, t: ClientTracking | null | undefined, header: HeaderReader, opts: { agencyCaller?: boolean } = {}): Promise<TrackingContext | null> {
  if (!t || typeof t !== "object" || t.client !== "web") return null;
  if (opts.agencyCaller || header("X-FP-Agent") || header("X-API-Key") || header("X-ZAMRA-INTEGRATION-KEY")) return null;
  if (t.prefetch === true || t.bot === true) return null;
  // The website's server forwards the visitor's own device; a browser call is read from its user agent.
  const ua = header("User-Agent");
  const forwarded = cleanDevice(str(t.device));
  if (!forwarded && isBot(ua)) return null;
  if (!(await getAnalyticsSettings(env, tenantId)).searchTracking) return null;
  return {
    tenantId,
    visitorHash: await visitorHash(env.JWT_SECRET, str(t.visitor)),
    userId: await customerFromToken(env, tenantId, str(t.customer)),
    device: forwarded ?? deviceClass(ua),
    country: cleanCountry(str(t.country)),
  };
}

export async function searchEventFor(ctx: TrackingContext, it: Itinerary, at = new Date()) {
  const who = ctx.visitorHash ?? (ctx.userId ? `u:${ctx.userId}` : "anon");
  const key = await dedupeKey(ctx.tenantId, who, it, istDay(at));
  return { id: eventIdFromKey(key), dedupeKey: key };
}

// ── Writes ────────────────────────────────────────────────────────────────────────

export async function recordSearchEvent(db: Db, ctx: TrackingContext, it: Itinerary, ev: { id: string; dedupeKey: string },
  result: ReturnType<typeof summarizeResponse>, requestCurrency: string | null) {
  const currency = result.fareCurrency ?? requestCurrency ?? "INR";
  await db.insert(searchEvents).values({
    id: ev.id, tenantId: ctx.tenantId, dedupeKey: ev.dedupeKey, visitorHash: ctx.visitorHash, userId: ctx.userId,
    channel: "B2C_WEB", tripType: it.tripType, origin: it.origin, destination: it.destination,
    departureDate: it.departureDate, returnDate: it.returnDate, legs: it.legs,
    adults: it.adults, children: it.children, infants: it.infants, cabinClass: it.cabinClass, fareType: it.fareType,
    currency, outcome: result.outcome, resultCount: result.resultCount,
    lowestFare: result.lowestFare === null ? null : String(result.lowestFare),
    cacheHit: result.cacheHit, supplierSearchId: result.supplierSearchId, device: ctx.device, country: ctx.country,
  }).onConflictDoUpdate({
    target: [searchEvents.tenantId, searchEvents.dedupeKey],
    set: {
      repeatCount: sql`${searchEvents.repeatCount} + 1`,
      lastSeenAt: sql`now()`,
      // The latest answer the customer saw.
      outcome: sql`excluded.outcome`, resultCount: sql`excluded.result_count`, lowestFare: sql`excluded.lowest_fare`,
      currency: sql`excluded.currency`, cacheHit: sql`excluded.cache_hit`, supplierSearchId: sql`excluded.supplier_search_id`,
      userId: sql`COALESCE(excluded.user_id, ${searchEvents.userId})`,
      device: sql`COALESCE(${searchEvents.device}, excluded.device)`, country: sql`COALESCE(${searchEvents.country}, excluded.country)`,
    },
  });
}

export async function recordSiteVisit(db: Db, ctx: TrackingContext, path: string | null, at = new Date()) {
  if (!ctx.visitorHash) return;
  const landing = typeof path === "string" ? path.split(/[?#]/)[0].slice(0, 200) || "/" : null;
  await db.insert(siteVisits).values({
    tenantId: ctx.tenantId, day: istDay(at), visitorHash: ctx.visitorHash, userId: ctx.userId,
    device: ctx.device, country: ctx.country, landingPath: landing,
  }).onConflictDoNothing();
}

export async function markFareSelected(db: Db, tenantId: string, searchEventId: string) {
  if (!isUuid(searchEventId)) return;
  await db.update(searchEvents).set({ fareSelectedAt: sql`COALESCE(${searchEvents.fareSelectedAt}, now())` })
    .where(and(eq(searchEvents.tenantId, tenantId), eq(searchEvents.id, searchEventId)));
}

export const PAID_STATUSES = ["CONFIRMED", "TICKETED", "REISSUED"] as const;

/** Links a search to the booking made from it. A paid booking already linked is never replaced. */
export async function linkSearchToBooking(db: Db, tenantId: string, searchEventId: string, bookingId: string) {
  if (!isUuid(searchEventId) || typeof bookingId !== "string" || !bookingId) return;
  await db.execute(sql`
    UPDATE search_events se SET booking_id = ${bookingId}
    WHERE se.tenant_id = ${tenantId} AND se.id = ${searchEventId}
      AND (se.booking_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM bookings b WHERE b.id = se.booking_id AND b.status IN ('CONFIRMED', 'TICKETED', 'REISSUED')))`);
}

/** Retention: analytics rows older than 13 months. Touches only the two analytics tables. */
export async function purgeAnalytics(db: Db, now = new Date()) {
  const cutoff = new Date(now.getTime() - ANALYTICS_RETENTION_DAYS * 86_400_000);
  const a = await db.delete(searchEvents).where(lt(searchEvents.firstSeenAt, cutoff)).returning({ id: searchEvents.id });
  const b = await db.delete(siteVisits).where(lt(siteVisits.day, istDay(cutoff))).returning({ d: siteVisits.day });
  return { searchEvents: a.length, siteVisits: b.length };
}

