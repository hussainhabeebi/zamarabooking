// Phase 1 customer search tracking + Admin analytics (docs/search-analytics.md).
// Real PostgreSQL engine (PGlite, in memory) with the repository's own migrations 0001–0015.
// No network, no supplier calls, no payments: the search and booking routes are stand-ins that
// answer like the real ones, so the tracking middleware is tested around them unchanged.
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { SignJWT } from "jose";
import * as schema from "@zamrabooking/db/schema";
import {
  ABANDON_WINDOW_HOURS, cleanCountry, dedupeKey, deviceClass, eventIdFromKey, isBot, isUuid, istDay, itineraryOf,
  purgeAnalytics, summarizeResponse, visitorHash,
} from "../src/lib/search-analytics.js";
import { analyticsRoutes, trackBooking, trackSearch } from "../src/routes/analytics.js";
import { adminRoutes } from "../src/routes/admin/index.js";
import { parseFilters, toCsv } from "../src/lib/analytics-reports.js";

const MIGRATIONS = new URL("../../../packages/db/drizzle/migrations/", import.meta.url);
const ROLLBACK = new URL("../../../packages/db/drizzle/rollback/0015_search_analytics_down.sql", import.meta.url);
const migrationSql = (f: string) => readFileSync(new URL(f, MIGRATIONS), "utf8").replace(/CREATE EXTENSION[^;]*;/gi, "");

const T = "tenant-analytics-test";
const SECRET = "test-secret-for-search-analytics-only";
let pg: PGlite;
let db: any;
let env: any;
let pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} } as any;
const settle = async () => { while (pending.length) { const p = pending; pending = []; await Promise.allSettled(p); } };

function memoryKv(init: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    async get(k: string, type?: string) { const v = store.get(k) ?? null; return v && type === "json" ? JSON.parse(v) : v; },
    async put(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
    async list({ prefix = "" }: { prefix?: string } = {}) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}
const trackingOn = (on = true) => env.TENANT_CACHE_KV.put(`admin_settings:${T}:analytics`, JSON.stringify({ searchTracking: on }));
const rows = async (q: string, p: unknown[] = []) => (await pg.query<any>(q, p)).rows;

before(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(migrationSql(f));
  db = drizzle(pg, { schema });
  await pg.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Analytics test', 'analytics-test')`, [T]);
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM search_events; DELETE FROM site_visits; DELETE FROM payments; DELETE FROM booking_passengers; DELETE FROM bookings; DELETE FROM audit_logs; DELETE FROM users;`);
  env = { TENANT_CACHE_KV: memoryKv(), FARE_CACHE_KV: memoryKv(), SESSIONS_KV: memoryKv(), JWT_SECRET: SECRET, ENVIRONMENT: "test" };
  pending = [];
});

// ── The app around the stand-in routes (wired exactly as apps/api/src/index.ts) ───────────────

const FARES = {
  searchId: "11111111-1111-4111-8111-111111111111",
  fares: [
    { id: "AK|t|1", supplier: "AKBAR", totalFare: 21000, displayPrice: 21000, currency: "INR" },
    { id: "AK|t|2", supplier: "AKBAR", totalFare: 19800, displayPrice: 20000, currency: "INR" },
  ],
};
let searchAnswer: { status: number; body: unknown } = { status: 200, body: FARES };
let bookingAnswer: { status: number; body: unknown } = { status: 200, body: { success: true, bookingId: "bk-1" } };

function app(vars: Record<string, unknown> = {}) {
  const a = new Hono<any>();
  a.use("*", async (c, next) => { c.set("tenantId", T); c.set("db", db); for (const [k, v] of Object.entries(vars)) c.set(k as never, v as never); await next(); });
  a.use("/api/search", trackSearch);
  a.use("/api/book", trackBooking);
  a.post("/api/search", (c) => c.json(searchAnswer.body as object, searchAnswer.status as 200));
  a.post("/api/book", (c) => c.json(bookingAnswer.body as object, bookingAnswer.status as 200));
  a.route("/api/analytics", analyticsRoutes);
  a.route("/api/admin", adminRoutes);
  return a;
}

const VISITOR = "6f9c1b2e-7a4d-4c3b-9e1f-2a3b4c5d6e7f";
// What the website's server adds to the request body (app/lib/visitor.ts serverTracking).
const TRACK: Record<string, unknown> = { client: "web", visitor: VISITOR, device: "mobile", country: "in" };
const WEB = { "Content-Type": "application/json", "User-Agent": "next-server" };
const SEARCH = { origin: "CCJ", destination: "DXB", departureDate: "2026-12-20", adults: 2, children: 0, infants: 0, cabinClass: "ECONOMY", tripType: "ONEWAY", currency: "INR" };

async function search(body: Record<string, unknown> = SEARCH, tracking: Record<string, unknown> | null = TRACK, headers: Record<string, string> = WEB, a = app()) {
  const res = await a.request("/api/search", { method: "POST", headers, body: JSON.stringify(tracking ? { ...body, tracking } : body) }, env, ctx);
  const text = await res.text();
  await settle();
  return { res, text, eventId: res.headers.get("X-Search-Event-Id") };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────────

test("India day, bots, devices, countries and ids", async () => {
  assert.equal(istDay(new Date("2026-11-19T18:29:00Z")), "2026-11-19");
  assert.equal(istDay(new Date("2026-11-19T18:31:00Z")), "2026-11-20");   // past midnight in India
  assert.equal(isBot("Mozilla/5.0 (compatible; Googlebot/2.1)"), true);
  assert.equal(isBot("facebookexternalhit/1.1"), true);
  assert.equal(isBot("WhatsApp/2.23"), true);
  assert.equal(isBot(""), true);
  assert.equal(isBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Mobile/15E148 Safari/604.1"), false);
  assert.equal(deviceClass("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile"), "mobile");
  assert.equal(deviceClass("Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit Safari"), "tablet");
  assert.equal(deviceClass("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130"), "desktop");
  assert.equal(cleanCountry("in"), "IN");
  assert.equal(cleanCountry("XX"), null);
  assert.equal(cleanCountry("IND"), null);
  const id = eventIdFromKey("a".repeat(64));
  assert.ok(isUuid(id), id);
  assert.equal(await visitorHash(SECRET, "not-a-uuid"), null);
  const h = await visitorHash(SECRET, VISITOR);
  assert.match(h!, /^[0-9a-f]{64}$/);
  assert.ok(!h!.includes(VISITOR.replaceAll("-", "")));
  assert.equal(await visitorHash(SECRET, VISITOR.toUpperCase()), h);   // stable
  assert.notEqual(await visitorHash("other-secret", VISITOR), h);       // keyed: useless without the server secret
});

test("one search = visitor + exact itinerary + India day; currency is not part of it", async () => {
  const it = itineraryOf(SEARCH)!;
  const k = (o: Record<string, unknown>, day = "2026-11-19", who = "v1") => dedupeKey(T, who, itineraryOf({ ...SEARCH, ...o })!, day);
  assert.equal(await k({ currency: "AED" }), await k({}));
  assert.notEqual(await k({ adults: 1 }), await k({}));
  assert.notEqual(await k({ departureDate: "2026-12-21" }), await k({}));
  assert.notEqual(await k({ fareType: "STUDENT" }), await k({}));
  assert.notEqual(await k({}, "2026-11-20"), await k({}));
  assert.notEqual(await k({}, "2026-11-19", "v2"), await k({}));
  assert.equal(it.fareType, null);
  assert.equal(itineraryOf({ ...SEARCH, origin: "CALICUT" }), null);
  assert.equal(itineraryOf({ ...SEARCH, departureDate: "20/12/2026" }), null);
  const multi = itineraryOf({ ...SEARCH, tripType: "MULTICITY", legs: [{ origin: "CCJ", destination: "DXB", departureDate: "2026-12-20" }, { origin: "DXB", destination: "JED", departureDate: "2026-12-24" }] })!;
  assert.equal(multi.legs!.length, 2);
  assert.equal(itineraryOf({ ...SEARCH, tripType: "ROUNDTRIP", returnDate: "2026-12-30" })!.returnDate, "2026-12-30");
});

test("response summary: results, no results, errors; lowest fare per adult as shown", () => {
  assert.deepEqual(summarizeResponse(200, FARES, 2), { outcome: "RESULTS", resultCount: 2, lowestFare: 10000, fareCurrency: "INR", cacheHit: false, supplierSearchId: FARES.searchId });
  assert.equal(summarizeResponse(200, { fares: [] }, 1).outcome, "NO_RESULTS");
  assert.equal(summarizeResponse(200, { fares: [], supplierErrors: { AKBAR: "timeout" } }, 1).outcome, "ERROR");
  assert.equal(summarizeResponse(500, { error: "x" }, 1).outcome, "ERROR");
  assert.equal(summarizeResponse(200, { ...FARES, fromCache: true }, 2).cacheHit, true);
});

// ── Migration ────────────────────────────────────────────────────────────────────

test("migration 0015 is additive and can be applied again; rollback drops only the analytics tables", async () => {
  await search();                                    // tracking off: nothing
  await trackingOn();
  await search();
  await pg.exec(migrationSql("0015_search_analytics.sql"));
  assert.equal((await rows(`SELECT count(*)::int AS n FROM search_events`))[0].n, 1);
  const cols = (await rows(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'bookings'`))[0].n;
  // A scratch copy of the engine for the rollback, so the other tests keep their tables.
  const scratch = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await scratch.exec(migrationSql(f));
  await scratch.exec(readFileSync(ROLLBACK, "utf8"));
  assert.equal((await scratch.query<any>(`SELECT to_regclass('public.search_events') AS t`)).rows[0].t, null);
  assert.equal((await scratch.query<any>(`SELECT to_regclass('public.site_visits') AS t`)).rows[0].t, null);
  assert.equal((await scratch.query<any>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'bookings'`)).rows[0].n, cols);
  await scratch.close();
});

// ── Search tracking around the search route ────────────────────────────────────────

test("tracking OFF (the default after release): nothing recorded, no header, search answer unchanged", async () => {
  const { res, text, eventId } = await search();
  assert.equal(res.status, 200);
  assert.equal(text, JSON.stringify(FARES));
  assert.equal(eventId, null);
  assert.equal((await rows(`SELECT * FROM search_events`)).length, 0);
});

test("tracking ON: the search is recorded in the background; the answer is byte for byte the same", async () => {
  await trackingOn();
  const { res, text, eventId } = await search();
  assert.equal(res.status, 200);
  assert.equal(text, JSON.stringify(FARES));
  assert.ok(isUuid(eventId));
  const [r] = await rows(`SELECT * FROM search_events`);
  assert.equal(r.id, eventId);
  assert.equal(r.origin, "CCJ");
  assert.equal(r.destination, "DXB");
  assert.equal(r.departure_date instanceof Date ? r.departure_date.toISOString().slice(0, 10) : r.departure_date, "2026-12-20");
  assert.equal(r.adults, 2);
  assert.equal(r.outcome, "RESULTS");
  assert.equal(r.result_count, 2);
  assert.equal(Number(r.lowest_fare), 10000);
  assert.equal(r.device, "mobile");
  assert.equal(r.country, "IN");
  assert.equal(r.user_id, null);
  assert.equal(r.visitor_hash, await visitorHash(SECRET, VISITOR));
  assert.equal(r.repeat_count, 1);
  assert.equal(r.supplier_search_id, FARES.searchId);
  // Nothing personal: no IP / user agent column exists, the cookie value is not stored anywhere.
  assert.ok(!JSON.stringify(r).includes(VISITOR));
});

test("refreshes, currency changes, cache hits and concurrent repeats count as ONE search", async () => {
  await trackingOn();
  const a = await search();
  const b = await search({ ...SEARCH, currency: "AED" });
  searchAnswer = { status: 200, body: { ...FARES, fromCache: true } };
  const c = await search();
  await Promise.all([search(), search(), search()]);   // at the same moment (prefetch + render + retry)
  searchAnswer = { status: 200, body: FARES };
  assert.equal(a.eventId, b.eventId);
  assert.equal(a.eventId, c.eventId);
  const all = await rows(`SELECT * FROM search_events`);
  assert.equal(all.length, 1);
  assert.equal(all[0].repeat_count, 6);
  // A different itinerary or visitor is a different search.
  await search({ ...SEARCH, adults: 1 });
  await search(SEARCH, { ...TRACK, visitor: "0d1c2b3a-4f5e-4a6b-8c7d-9e0f1a2b3c4d" });
  assert.equal((await rows(`SELECT * FROM search_events`)).length, 3);
});

test("not customer searches: bots, prefetches, agencies, partner API, non-website callers, invalid requests", async () => {
  await trackingOn();
  await search(SEARCH, { ...TRACK, bot: true });
  await search(SEARCH, { ...TRACK, prefetch: true });
  await search({ ...SEARCH, agentNumber: "ZB1025" });
  await search(SEARCH, TRACK, { ...WEB, "X-FP-Agent": "ZB1025" });
  await search(SEARCH, TRACK, { ...WEB, "X-API-Key": "pk_live_x" });
  await search(SEARCH, null, { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (iPhone) Mobile" });   // not marked by the website
  await search(SEARCH, { ...TRACK, client: "partner" });
  const { device: _d, ...browser } = TRACK;
  await search(SEARCH, browser, { ...WEB, "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" });
  await search({ ...SEARCH, origin: "CALICUT" });
  searchAnswer = { status: 400, body: { error: "invalid" } };
  await search();
  searchAnswer = { status: 200, body: FARES };
  const agentToken = await new SignJWT({ agentId: "agent-1", tenantId: T }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(SECRET));
  await search(SEARCH, TRACK, { ...WEB, Authorization: `Bearer ${agentToken}` });
  assert.equal((await rows(`SELECT * FROM search_events`)).length, 0);
});

test("a browser (journey page) search is read from its own user agent", async () => {
  await trackingOn();
  const { device: _d, ...browser } = TRACK;
  await search(SEARCH, browser, { ...WEB, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130" });
  assert.equal((await rows(`SELECT device FROM search_events`))[0].device, "desktop");
});

test("opted-out browsers (no visitor cookie) are counted without a visitor", async () => {
  await trackingOn();
  const { visitor: _v, ...noVisitor } = TRACK;
  const { eventId } = await search(SEARCH, noVisitor);
  assert.ok(isUuid(eventId));
  const [r] = await rows(`SELECT visitor_hash FROM search_events`);
  assert.equal(r.visitor_hash, null);
});

test("supplier errors are recorded as ERROR (no availability), never abandoned", async () => {
  await trackingOn();
  searchAnswer = { status: 500, body: { error: "Flight search failed" } };
  const { res } = await search();
  searchAnswer = { status: 200, body: FARES };
  assert.equal(res.status, 500);
  assert.equal((await rows(`SELECT outcome FROM search_events`))[0].outcome, "ERROR");
});

test("a database failure never affects the search", async () => {
  await trackingOn();
  const broken = app({ db: { insert() { throw new Error("database down"); }, execute() { throw new Error("database down"); } } });
  const { res, text } = await search(SEARCH, TRACK, WEB, broken);
  assert.equal(res.status, 200);
  assert.equal(text, JSON.stringify(FARES));
  // KV failure (switch unreadable) → treated as OFF.
  env.TENANT_CACHE_KV = { get: async () => { throw new Error("kv down"); } };
  const again = await search();
  assert.equal(again.res.status, 200);
  assert.equal(again.eventId, null);
});

async function customerToken(userId: string) {
  await pg.query(`INSERT INTO users (id, tenant_id, email, name, phone, role) VALUES ($1, $2, $3, 'Anand K', '+919999999999', 'CUSTOMER')`, [userId, T, `${userId}@example.com`]);
  await env.SESSIONS_KV.put(`session:${userId}`, JSON.stringify({ sessionId: "s-1" }));
  return new SignJWT({ userId, tenantId: T, role: "CUSTOMER", sessionId: "s-1" }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(SECRET));
}

test("signed-in customers are linked through the tracking field (never Authorization); ended sessions are guests", async () => {
  await trackingOn();
  const token = await customerToken("cust-1");
  await search(SEARCH, { ...TRACK, customer: token });
  assert.equal((await rows(`SELECT user_id FROM search_events`))[0].user_id, "cust-1");
  await env.SESSIONS_KV.put(`session:cust-1`, JSON.stringify({ sessionId: "other" }));
  await search({ ...SEARCH, adults: 3 }, { ...TRACK, customer: token });
  assert.equal((await rows(`SELECT user_id FROM search_events WHERE adults = 3`))[0].user_id, null);
});

// ── Visits, fare selected, booking link ────────────────────────────────────────────

test("daily visits: once per visitor per India day; bots and switched-off tracking are ignored", async () => {
  const visit = (tracking: Record<string, unknown> = TRACK, path = "/search?origin=CCJ&destination=DXB") =>
    app().request("/api/analytics/visit", { method: "POST", headers: WEB, body: JSON.stringify({ path, tracking }) }, env, ctx).then(async (r) => { await settle(); return r; });
  assert.equal((await visit()).status, 204);
  assert.equal((await rows(`SELECT * FROM site_visits`)).length, 0);   // off
  await trackingOn();
  await visit(); await visit();
  await visit({ ...TRACK, bot: true });
  const v = await rows(`SELECT * FROM site_visits`);
  assert.equal(v.length, 1);
  assert.equal(v[0].landing_path, "/search");                          // no query string
  assert.equal(v[0].day instanceof Date ? v[0].day.toISOString().slice(0, 10) : v[0].day, istDay());
});

async function addBooking(id: string, o: { status?: string; paid?: boolean; createdAt?: string; userId?: string | null; email?: string; phone?: string; currency?: string; total?: number; origin?: string; destination?: string; dep?: string } = {}) {
  await pg.query(`INSERT INTO bookings (id, tenant_id, user_id, channel, status, trip_type, cabin_class, origin, destination, departure_date, flight_data,
      adult_count, base_fare, taxes, markup, total_amount, currency, supplier, contact_email, contact_phone, created_at)
    VALUES ($1, $2, $3, 'B2C_WEB', $4, 'ONEWAY', 'ECONOMY', $5, $6, $7::timestamptz, '{}'::jsonb, 2, $8, 0, 500, $8, $9, 'AKBAR', $10, $12, $11::timestamptz)`,
    [id, T, o.userId ?? null, o.status ?? "PAYMENT_PENDING", o.origin ?? "CCJ", o.destination ?? "DXB", `${o.dep ?? "2026-12-20"}T00:00:00Z`, o.total ?? 40000, o.currency ?? "INR", o.email ?? `${id}@example.com`, o.createdAt ?? new Date().toISOString(), o.phone ?? `+91${id.length}${Math.floor(Math.random() * 1e9)}`]);
  if (o.paid) await pg.query(`INSERT INTO payments (booking_id, gateway, amount, currency, status) VALUES ($1, 'PHONEPE', $2, $3, 'SUCCESS')`, [id, o.total ?? 40000, o.currency ?? "INR"]);
}

test("fare selected and booking link; a paid booking already linked is never replaced", async () => {
  await trackingOn();
  const { eventId } = await search();
  await app().request("/api/analytics/selected", { method: "POST", headers: WEB, body: JSON.stringify({ searchEventId: eventId, tracking: { client: "web" } }) }, env, ctx);
  await settle();
  assert.ok((await rows(`SELECT fare_selected_at FROM search_events`))[0].fare_selected_at);

  const book = async (bookingId: string, se: unknown = eventId, status = 200) => {
    bookingAnswer = { status, body: status === 200 ? { success: true, bookingId } : { error: "x" } };
    const r = await app().request("/api/book", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fareId: "AK|t|1", searchEventId: se }) }, env, ctx);
    await settle();
    return r;
  };
  await addBooking("bk-1");
  const r = await book("bk-1");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { success: true, bookingId: "bk-1" });       // booking answer untouched
  assert.equal((await rows(`SELECT booking_id FROM search_events`))[0].booking_id, "bk-1");
  await addBooking("bk-2");
  await book("bk-2");                                                              // retry after an unpaid attempt → latest
  assert.equal((await rows(`SELECT booking_id FROM search_events`))[0].booking_id, "bk-2");
  await pg.query(`UPDATE bookings SET status = 'CONFIRMED' WHERE id = 'bk-2'`);
  await pg.query(`INSERT INTO payments (booking_id, gateway, amount, currency, status) VALUES ('bk-2', 'PHONEPE', 1, 'INR', 'SUCCESS')`);
  await addBooking("bk-3");
  await book("bk-3");                                                              // paid booking stays linked
  assert.equal((await rows(`SELECT booking_id FROM search_events`))[0].booking_id, "bk-2");
  await book("bk-4", "not-a-uuid");
  await book("bk-5", eventId, 409);                                               // failed booking: nothing linked
  assert.equal((await rows(`SELECT booking_id FROM search_events`))[0].booking_id, "bk-2");
});

// ── Reports ──────────────────────────────────────────────────────────────────────

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
async function seedSearch(id: string, o: Record<string, unknown> = {}) {
  const v = { visitor: "v-" + id, user: null, origin: "CCJ", destination: "DXB", dep: "2026-12-20", outcome: "RESULTS", firstSeen: hoursAgo(48), lastSeen: null, booking: null, lowest: 20000, currency: "INR", device: "mobile", ...o } as any;
  await pg.query(`INSERT INTO search_events (id, tenant_id, dedupe_key, visitor_hash, user_id, trip_type, origin, destination, departure_date, adults, cabin_class, currency, outcome, result_count, lowest_fare, device, first_seen_at, last_seen_at, booking_id)
    VALUES ($1, $2, $1, $3, $4, 'ONEWAY', $5, $6, $7, 1, 'ECONOMY', $8, $9, 3, $10, $11, $12::timestamptz, $13::timestamptz, $14)`,
    [id, T, v.visitor, v.user, v.origin, v.destination, v.dep, v.currency, v.outcome, v.lowest, v.device, v.firstSeen, v.lastSeen ?? v.firstSeen, v.booking]);
}

const admin = (role: string, userId?: string) => app({ userRole: role, ...(userId ? { userId } : {}) });
const get = async (path: string, a = admin("SUPER_ADMIN")) => {
  const r = await a.request(`/api/admin/analytics/${path}`, {}, env, ctx);
  return { status: r.status, body: r.headers.get("Content-Type")?.includes("csv") ? await r.text() : await r.json().catch(() => null), headers: r.headers };
};
const range = (() => { const to = istDay(); const from = istDay(new Date(Date.now() - 7 * 86_400_000)); return `from=${from}&to=${to}`; })();

test("search status: booked (own or another path), unpaid checkout, in progress, abandoned, no availability", async () => {
  await addBooking("paid-own", { status: "TICKETED", paid: true, createdAt: hoursAgo(47) });
  await seedSearch("s-booked", { booking: "paid-own" });
  await addBooking("unpaid", { createdAt: hoursAgo(47) });
  await seedSearch("s-unpaid", { booking: "unpaid" });
  await seedSearch("s-progress", { firstSeen: hoursAgo(2) });
  await seedSearch("s-abandoned");
  await seedSearch("s-none", { outcome: "NO_RESULTS" });
  await seedSearch("s-error", { outcome: "ERROR" });
  // Same visitor searched twice (different passengers); booked from the second search → the first is not abandoned.
  await addBooking("paid-other", { status: "CONFIRMED", paid: true, createdAt: hoursAgo(46), origin: "COK", destination: "JED", dep: "2027-01-05" });
  await seedSearch("s-first", { visitor: "same", origin: "COK", destination: "JED", dep: "2027-01-05", firstSeen: hoursAgo(47) });
  await seedSearch("s-second", { visitor: "same", origin: "COK", destination: "JED", dep: "2027-01-05", firstSeen: hoursAgo(46.5), booking: "paid-other" });
  // Signed-in customer booked the route directly (no search link) → not abandoned either.
  await addBooking("paid-user", { status: "TICKETED", paid: true, createdAt: hoursAgo(40), userId: null, origin: "CCJ", destination: "JED", dep: "2027-02-01" });
  await pg.query(`INSERT INTO users (id, tenant_id, email, role) VALUES ('cust-9', $1, 'c9@example.com', 'CUSTOMER')`, [T]);
  await pg.query(`UPDATE bookings SET user_id = 'cust-9' WHERE id = 'paid-user'`);
  await seedSearch("s-user", { user: "cust-9", origin: "CCJ", destination: "JED", dep: "2027-02-01" });
  // Booked a week later: outside the 24 h window → abandoned.
  await addBooking("late", { status: "TICKETED", paid: true, createdAt: hoursAgo(1), userId: "cust-9", origin: "CCJ", destination: "DMM", dep: "2027-03-01" });
  await seedSearch("s-late", { user: "cust-9", origin: "CCJ", destination: "DMM", dep: "2027-03-01", firstSeen: hoursAgo(24 * 6) });

  const { status, body } = await get(`searches?${range}`);
  assert.equal(status, 200);
  const st = Object.fromEntries(body.rows.map((r: any) => [r.id, r.status]));
  assert.deepEqual(st, {
    "s-booked": "BOOKED", "s-unpaid": "CHECKOUT_UNPAID", "s-progress": "IN_PROGRESS", "s-abandoned": "ABANDONED",
    "s-none": "NO_AVAILABILITY", "s-error": "NO_AVAILABILITY", "s-first": "BOOKED", "s-second": "BOOKED", "s-user": "BOOKED", "s-late": "ABANDONED",
  });
  assert.equal(ABANDON_WINDOW_HOURS, 24);
  const ov = await get(`overview?${range}`);
  assert.equal(ov.body.searches, 10);
  assert.equal(ov.body.abandonedSearches, 2);
  assert.equal(ov.body.noAvailability, 2);
  // Paid bookings are distinct bookings: two searches by one visitor that led to one booking count once.
  assert.equal(ov.body.paidBookings, 3);
  assert.equal(ov.body.searchTracking, false);
});

test("conversion uses actual paid bookings: an unpaid 'CONFIRMED' row or a failed payment is not a sale", async () => {
  await addBooking("no-payment-row", { status: "CONFIRMED", createdAt: hoursAgo(47) });          // status without a successful payment
  await seedSearch("s-a", { booking: "no-payment-row" });
  await addBooking("failed", { status: "PAYMENT_FAILED", createdAt: hoursAgo(47) });
  await pg.query(`INSERT INTO payments (booking_id, gateway, amount, currency, status) VALUES ('failed', 'PHONEPE', 1, 'INR', 'FAILED')`);
  await seedSearch("s-b", { booking: "failed" });
  await addBooking("refunded", { status: "REFUNDED", paid: true, createdAt: hoursAgo(47) });     // paid, then refunded: converted, no revenue
  await seedSearch("s-c", { booking: "refunded" });
  const ov = await get(`overview?${range}`);
  assert.equal(ov.body.paidBookings, 1);
  const inr = ov.body.website.byCurrency.find((r: any) => r.currency === "INR");
  assert.equal(inr.paid, 1);
  assert.equal(inr.revenue, 0);
  assert.equal(inr.cancelledAfterPayment, 1);
});

test("sectors, airports, dates and revenue (money per currency, never mixed)", async () => {
  await addBooking("b-inr", { status: "TICKETED", paid: true, createdAt: hoursAgo(47), total: 40000 });
  await addBooking("b-aed", { status: "TICKETED", paid: true, createdAt: hoursAgo(47), total: 1800, currency: "AED" });
  await seedSearch("x1", { booking: "b-inr", lowest: 20000 });
  await seedSearch("x2", { booking: "b-aed", lowest: 18000 });
  await seedSearch("x3", { lowest: 22000 });
  await seedSearch("x4", { origin: "COK", destination: "DXB" });
  const s = await get(`sectors?${range}`);
  const ccj = s.body.rows.find((r: any) => r.origin === "CCJ" && r.destination === "DXB");
  assert.equal(ccj.searches, 3);
  assert.equal(ccj.paidBookings, 2);
  assert.equal(ccj.conversionPct, 66.67);
  assert.deepEqual(ccj.revenue, { INR: 40000, AED: 1800 });
  assert.equal(ccj.avgLowestInr, 20000);
  assert.equal(ccj.websitePaidBookings, 2);
  assert.equal(s.body.rows[0].origin, "CCJ");                  // most searched first
  const a = await get(`airports?${range}`);
  assert.deepEqual(a.body.departures.map((r: any) => [r.airport, r.searches]), [["CCJ", 3], ["COK", 1]]);
  const d = await get(`dates?${range}`);
  assert.equal(d.body.dates[0].departureDate, "2026-12-20");
  const rev = await get(`revenue?${range}`);
  assert.deepEqual(rev.body.byPeriod.map((r: any) => [r.currency, r.revenue]).sort(), [["AED", 1800], ["INR", 40000]]);
});

test("abandoned checkouts: unpaid after 24 h, unless the same customer paid for the same trip later", async () => {
  await addBooking("left", { createdAt: hoursAgo(30), email: "left@example.com" });
  await addBooking("retried", { createdAt: hoursAgo(30), email: "retry@example.com" });
  await addBooking("retried-paid", { status: "TICKETED", paid: true, createdAt: hoursAgo(29), email: "RETRY@example.com" });   // same email, other case
  await addBooking("phone-1", { createdAt: hoursAgo(30), phone: "+919876500000" });
  await addBooking("phone-1-paid", { status: "CONFIRMED", paid: true, createdAt: hoursAgo(28), phone: "+919876500000" });           // same phone
  await addBooking("fresh", { createdAt: hoursAgo(2), email: "fresh@example.com" });          // still within 24 h
  const r = await get(`abandoned-checkouts?${range}`);
  assert.deepEqual(r.body.rows.map((x: any) => x.booking_id), ["left"]);
  assert.equal(r.body.rows[0].contact_email, "left@example.com");                            // full admin sees contact
  const ov = await get(`overview?${range}`);
  assert.equal(ov.body.website.abandonedCheckouts, 1);
});

test("trend by day / week / month", async () => {
  await seedSearch("t1", { firstSeen: hoursAgo(30) });
  await seedSearch("t2", { firstSeen: hoursAgo(3) });
  const day = await get(`trend?${range}&interval=day`);
  assert.equal(day.body.rows.reduce((n: number, r: any) => n + r.searches, 0), 2);
  const month = await get(`trend?${range}&interval=month`);
  assert.ok(month.body.rows.length >= 1 && month.body.rows.length <= 2);
});

// ── Permissions, customer details, CSV ───────────────────────────────────────────

async function staff(id: string, permissions: string[]) {
  await pg.query(`INSERT INTO users (id, tenant_id, email, role, admin_permissions) VALUES ($1, $2, $3, 'STAFF', $4::jsonb)`, [id, T, `${id}@zamra.test`, JSON.stringify(permissions)]);
  return admin("STAFF", id);
}

test("permissions: staff need the analytics section; customer details need bookings too; switch is admins-only", async () => {
  await pg.query(`INSERT INTO users (id, tenant_id, email, name, phone, role) VALUES ('cust-1', $1, 'anand@example.com', 'Anand K', '+919999999999', 'CUSTOMER')`, [T]);
  await seedSearch("p1", { user: "cust-1" });
  const none = await staff("st-none", ["finance"]);
  assert.equal((await get(`overview?${range}`, none)).status, 403);
  assert.equal((await get(`searches?${range}&format=csv`, none)).status, 403);

  const analyst = await staff("st-analytics", ["analytics"]);
  const list = await get(`searches?${range}`, analyst);
  assert.equal(list.status, 200);
  assert.equal(list.body.customerDetails, false);
  assert.ok(!("customer_email" in list.body.rows[0]));
  const csv = await get(`searches?${range}&format=csv`, analyst);
  assert.equal(csv.status, 200);
  assert.ok(!csv.body.includes("anand@example.com") && !csv.body.includes("Email"));

  const both = await staff("st-both", ["analytics", "bookings"]);
  const full = await get(`searches?${range}&format=csv`, both);
  assert.ok(full.body.includes("anand@example.com"));
  assert.match(full.headers.get("Content-Disposition")!, /attachment; filename="zamra-search-history-/);

  const put = (a: Hono) => a.request("/api/admin/analytics/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ searchTracking: true }) }, env, ctx);
  assert.equal((await put(both)).status, 403);
  assert.equal((await put(admin("TENANT_ADMIN"))).status, 200);
  assert.equal((await get("settings", analyst)).body.searchTracking, true);

  // Every export is in the audit log, with whether customer details were included.
  const audit = await rows(`SELECT user_id, action, metadata FROM audit_logs WHERE action = 'ANALYTICS_EXPORT' ORDER BY created_at`);
  assert.deepEqual(audit.map((a) => [a.user_id, a.metadata.report, a.metadata.includesCustomerDetails]), [["st-analytics", "search-history", false], ["st-both", "search-history", true]]);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'ANALYTICS_SETTINGS_UPDATED'`))[0].n, 1);
});

test("filters are validated: ranges over 366 days or reversed are refused", async () => {
  assert.equal(typeof parseFilters(T, { from: "2025-01-01", to: "2026-12-31" }, "2026-11-19"), "string");
  assert.equal(typeof parseFilters(T, { from: "2026-11-20", to: "2026-11-19" }, "2026-11-19"), "string");
  assert.equal(typeof parseFilters(T, { from: "19-11-2026" }, "2026-11-19"), "string");
  const ok = parseFilters(T, { from: "2026-11-01", to: "2026-11-19", device: "mobile", country: "ae", audience: "guest" }, "2026-11-19");
  assert.deepEqual(ok, { tenantId: T, from: "2026-11-01", to: "2026-11-19", device: "mobile", country: "AE", audience: "guest" });
  assert.equal((await get("overview?from=2025-01-01&to=2026-12-31")).status, 400);
});

test("CSV: quoted correctly and safe to open in a spreadsheet", () => {
  const out = toCsv([{ key: "a", label: "A" }, { key: "b", label: "B" }], [{ a: "=HYPERLINK(\"x\")", b: "x,y" }, { a: "+91 99", b: "line\nbreak" }]);
  assert.equal(out, `A,B\r\n"'=HYPERLINK(""x"")","x,y"\r\n'+91 99,"line\nbreak"\r\n`);
});

test("retention: rows older than 13 months are deleted; nothing else is touched", async () => {
  await addBooking("old-booking", { createdAt: new Date(Date.now() - 500 * 86_400_000).toISOString() });
  await seedSearch("old", { firstSeen: new Date(Date.now() - 400 * 86_400_000).toISOString() });
  await seedSearch("new");
  await pg.query(`INSERT INTO site_visits (tenant_id, day, visitor_hash) VALUES ($1, (now() - interval '400 days')::date, 'old'), ($1, now()::date, 'new')`, [T]);
  const r = await purgeAnalytics(db);
  assert.deepEqual(r, { searchEvents: 1, siteVisits: 1 });
  assert.deepEqual((await rows(`SELECT id FROM search_events`)).map((x) => x.id), ["new"]);
  assert.equal((await rows(`SELECT id FROM bookings`)).length, 1);
});
