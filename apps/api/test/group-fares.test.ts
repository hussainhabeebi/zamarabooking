// Group fares (lib/group-fares.ts, routes/group-fares.ts, the MANUAL checkout in routes/book.ts,
// Admin → Manual fares). Runs against a real PostgreSQL engine (PGlite, in memory) with the
// repository's own migrations 0001–0014 — no network, no supplier calls, no payments.
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import * as schema from "@zamrabooking/db/schema";
import {
  confirmGroupSeats, groupFareOnSale, groupFarePaxProblem, groupSeatStats, releaseGroupSeats, releaseUnsavedHold,
  reserveGroupSeats, validateGroupFareFields,
} from "../src/lib/group-fares.js";
import { lookupOfflineFare, searchManualFares } from "../src/lib/flight-sources.js";
import { groupFareRoutes } from "../src/routes/group-fares.js";
import { bookDirectRoutes } from "../src/routes/book.js";
import { flightSourcesAdminRoutes } from "../src/routes/admin/flight-sources.js";

const MIGRATIONS = new URL("../../../packages/db/drizzle/migrations/", import.meta.url);
const migrationSql = (f: string) => readFileSync(new URL(f, MIGRATIONS), "utf8").replace(/CREATE EXTENSION[^;]*;/gi, "");   // gen_random_uuid is built in

let pg: PGlite;
let db: any;
const T = "tenant-group-test";

function memoryKv(init: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    async get(k: string, type?: string) { const v = store.get(k) ?? null; return v && type === "json" ? JSON.parse(v) : v; },
    async put(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
  };
}

let env: any;
const settings = (s: Record<string, unknown>) => env.TENANT_CACHE_KV.put(`admin_settings:${T}:integration:manual`, JSON.stringify({ enabled: false, sheetUrl: "", autoSync: false, ...s }));

before(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(migrationSql(f));
  db = drizzle(pg, { schema });
  await pg.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Group test', 'group-test')`, [T]);
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM manual_fare_seat_holds; DELETE FROM payments; DELETE FROM booking_passengers; DELETE FROM bookings; DELETE FROM manual_fares; DELETE FROM audit_logs;`);
  env = { TENANT_CACHE_KV: memoryKv(), FARE_CACHE_KV: memoryKv(), SESSIONS_KV: memoryKv(), JWT_SECRET: "test-secret-for-group-fares-only", ENVIRONMENT: "test" };
  await settings({ groupFares: true });
});

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function addFare(over: Record<string, unknown> = {}) {
  const [row] = await db.insert(schema.manualFares).values({
    tenantId: T, source: "ADMIN", travelDate: future(30), origin: "COK", destination: "DXB", airline: "6E", airlineName: "IndiGo",
    flightNumber: "6E1403", departureTime: "21:30", arrivalTime: "00:15", arrivalDayOffset: 1, cabinClass: "ECONOMY",
    adultFare: "15000", childFare: "14000", infantFare: "2000", currency: "INR", seatsAvailable: 5,
    isGroupFare: true, isPublished: true, title: "Kochi – Dubai group", description: "Blocked seats for Christmas", minPax: 1, seatsTotal: 20,
    ...over,
  }).returning();
  return row as typeof schema.manualFares.$inferSelect;
}

const seatsOf = async (id: string) => Number((await pg.query<{ s: number }>(`SELECT seats_available AS s FROM manual_fares WHERE id = $1`, [id])).rows[0].s);
const holdOf = async (bookingId: string) => (await pg.query<{ status: string; seats: number; release_reason: string | null }>(`SELECT status, seats, release_reason FROM manual_fare_seat_holds WHERE booking_id = $1`, [bookingId])).rows[0];

async function addBooking(id: string, status: string) {
  await pg.query(`INSERT INTO bookings (id, tenant_id, channel, status, trip_type, cabin_class, origin, destination, departure_date, flight_data, adult_count, base_fare, taxes, markup, total_amount, currency, supplier, contact_email, contact_phone)
    VALUES ($1, $2, 'B2C_WEB', $3, 'ONEWAY', 'ECONOMY', 'COK', 'DXB', now(), '{}'::jsonb, 1, 1, 0, 0, 1, 'INR', 'MANUAL', 'a@example.com', '9999999999')`, [id, T, status]);
}

// ── Rules ────────────────────────────────────────────────────────────────────

test("only published, active group fares on sale and not departed are on sale", async () => {
  const row = await addFare();
  assert.equal(groupFareOnSale(row), true);
  assert.equal(groupFareOnSale({ ...row, isPublished: false }), false);
  assert.equal(groupFareOnSale({ ...row, isActive: false }), false);
  assert.equal(groupFareOnSale({ ...row, isGroupFare: false }), false);
  assert.equal(groupFareOnSale({ ...row, saleEndsAt: new Date(Date.now() - 1000) }), false);
  assert.equal(groupFareOnSale({ ...row, saleEndsAt: new Date(Date.now() + 3_600_000) }), true);
  assert.equal(groupFareOnSale({ ...row, travelDate: future(-1) }), false);
});

test("party size limits and seats left are explained", async () => {
  const row = await addFare({ minPax: 2, maxPax: 4, seatsAvailable: 3 });
  assert.match(groupFarePaxProblem(row, { adults: 1, children: 0 })!, /at least 2/);
  assert.match(groupFarePaxProblem(row, { adults: 4, children: 1 })!, /at most 4/);
  assert.match(groupFarePaxProblem(row, { adults: 4, children: 0 })!, /Only 3 seats left/);
  assert.equal(groupFarePaxProblem(row, { adults: 2, children: 1 }), null);
  assert.equal(groupFarePaxProblem(row, { adults: 4, children: 0 }, false), null);   // seats checked at reservation
});

test("Admin group fields are validated; a plain manual fare stays a plain manual fare", () => {
  const read = (v: Record<string, string>) => (c: string) => v[c] ?? "";
  assert.deepEqual(validateGroupFareFields(read({})), { isGroupFare: false, isPublished: false, title: null, description: null, saleEndsAt: null, minPax: 1, maxPax: null, seatsTotal: null });
  assert.match(validateGroupFareFields(read({ group_fare: "yes" })) as string, /title/);
  assert.match(validateGroupFareFields(read({ group_fare: "yes", title: "X", min_pax: "5", max_pax: "2" })) as string, /max_pax/);
  assert.match(validateGroupFareFields(read({ group_fare: "yes", title: "X", sale_ends_at: "soon" })) as string, /not a date/);
  const ok = validateGroupFareFields(read({ group_fare: "yes", published: "yes", title: "Hajj group", sale_ends_at: "2026-12-20T18:00", min_pax: "2", seats_total: "40" }));
  assert.ok(typeof ok !== "string");
  assert.equal(ok.isPublished, true);
  assert.equal(ok.saleEndsAt!.toISOString(), "2026-12-20T12:30:00.000Z");   // entered in India time
  assert.equal(ok.minPax, 2);
});

test("migration 0014 can be applied again without changing anything", async () => {
  await addFare();
  await pg.exec(migrationSql("0014_group_fares.sql"));
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM manual_fares`)).rows.length, 1);
});

// ── Seat inventory ───────────────────────────────────────────────────────────

test("a reservation takes the seats and records a hold; too many seats are refused", async () => {
  const fare = await addFare({ seatsAvailable: 5 });
  const r = await reserveGroupSeats(db, { tenantId: T, fareId: fare.id, bookingId: "b-1", seats: 3 });
  assert.equal(r.ok, true);
  assert.equal(await seatsOf(fare.id), 2);
  assert.deepEqual({ ...(await holdOf("b-1")) }, { status: "HELD", seats: 3, release_reason: null });
  const tooMany = await reserveGroupSeats(db, { tenantId: T, fareId: fare.id, bookingId: "b-2", seats: 3 });
  assert.deepEqual(tooMany, { ok: false, seatsLeft: 2 });
  assert.equal(await seatsOf(fare.id), 2);
  assert.equal(await holdOf("b-2"), undefined);
});

test("concurrent checkouts never oversell or allocate the same seats twice", async () => {
  const fare = await addFare({ seatsAvailable: 5 });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => reserveGroupSeats(db, { tenantId: T, fareId: fare.id, bookingId: `c-${i}`, seats: 2 })));
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.equal(await seatsOf(fare.id), 1);
  const held = (await pg.query<{ n: number }>(`SELECT COALESCE(SUM(seats), 0)::int AS n FROM manual_fare_seat_holds WHERE manual_fare_id = $1`, [fare.id])).rows[0].n;
  assert.equal(held, 4);   // seats held = seats taken off the fare, nothing double-counted

  const last = await addFare({ seatsAvailable: 1, flightNumber: "6E1404" });
  const one = await Promise.all(Array.from({ length: 8 }, (_, i) => reserveGroupSeats(db, { tenantId: T, fareId: last.id, bookingId: `l-${i}`, seats: 1 })));
  assert.equal(one.filter((r) => r.ok).length, 1);
  assert.equal(await seatsOf(last.id), 0);
});

test("the same booking can't hold seats twice", async () => {
  const fare = await addFare({ seatsAvailable: 5 });
  await reserveGroupSeats(db, { tenantId: T, fareId: fare.id, bookingId: "dup", seats: 1 });
  await assert.rejects(reserveGroupSeats(db, { tenantId: T, fareId: fare.id, bookingId: "dup", seats: 1 }));
  assert.equal(await seatsOf(fare.id), 4);   // the failed statement took nothing
});

test("unpublished, inactive, non-group and sale-ended fares accept no reservations", async () => {
  for (const over of [{ isPublished: false }, { isActive: false }, { isGroupFare: false }, { saleEndsAt: new Date(Date.now() - 60_000) }]) {
    const fare = await addFare(over);
    const r = await reserveGroupSeats(db, { tenantId: T, fareId: fare.id, bookingId: crypto.randomUUID(), seats: 1 });
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(await seatsOf(fare.id), 5);
  }
});

test("payment sells the held seats (once); expired unpaid holds and cancelled bookings give seats back", async () => {
  const fare = await addFare({ seatsAvailable: 6 });
  for (const id of ["paid", "unpaid", "cancelled", "paying"]) await reserveGroupSeats(db, { tenantId: T, fareId: fare.id, bookingId: id, seats: 1 });
  await addBooking("paid", "CONFIRMED");
  await addBooking("unpaid", "PAYMENT_PENDING");
  await addBooking("cancelled", "PAYMENT_PENDING");
  await addBooking("paying", "PAYMENT_PENDING");
  await pg.query(`INSERT INTO payments (booking_id, gateway, amount, currency, status) VALUES ('paying', 'PHONEPE', 1, 'INR', 'PENDING')`);
  assert.equal(await confirmGroupSeats(db, T, "paid"), "SOLD");
  assert.equal(await confirmGroupSeats(db, T, "paid"), "ALREADY_SOLD");   // a retried payment message
  assert.equal(await confirmGroupSeats(db, T, "cancelled"), "SOLD");
  await pg.query(`UPDATE bookings SET status = 'CANCELLED' WHERE id = 'cancelled'`);
  await pg.query(`UPDATE manual_fare_seat_holds SET expires_at = now() - interval '1 minute'`);   // every hold is past its time
  assert.equal(await seatsOf(fare.id), 2);

  const r = await releaseGroupSeats(db);
  assert.equal(r.holds, 2);
  assert.equal(await seatsOf(fare.id), 4);
  assert.equal((await holdOf("paid")).status, "SOLD");                       // paid: kept
  assert.equal((await holdOf("paying")).status, "HELD");                     // payment in progress: kept
  assert.deepEqual({ ...(await holdOf("unpaid")) }, { status: "RELEASED", seats: 1, release_reason: "EXPIRED" });
  assert.deepEqual({ ...(await holdOf("cancelled")) }, { status: "RELEASED", seats: 1, release_reason: "CANCELLED" });
  assert.deepEqual(await releaseGroupSeats(db), { holds: 0, fares: 0 });     // nothing released twice
  assert.equal(await seatsOf(fare.id), 4);
  assert.deepEqual(await groupSeatStats(db, T, [fare.id]), { [fare.id]: { held: 1, sold: 1, oversold: 0 } });
});

test("paid after the hold was released: seats taken again if free, otherwise OVERSOLD for staff", async () => {
  const fare = await addFare({ seatsAvailable: 2 });
  await reserveGroupSeats(db, { tenantId: T, fareId: fare.id, bookingId: "late-1", seats: 2 });
  await addBooking("late-1", "PAYMENT_PENDING");
  await pg.query(`UPDATE manual_fare_seat_holds SET expires_at = now() - interval '1 minute'`);
  await releaseGroupSeats(db);
  assert.equal(await seatsOf(fare.id), 2);
  assert.equal(await confirmGroupSeats(db, T, "late-1"), "RETAKEN");
  assert.equal(await seatsOf(fare.id), 0);
  assert.equal((await holdOf("late-1")).status, "SOLD");

  const other = await addFare({ seatsAvailable: 1, flightNumber: "6E1405" });
  await reserveGroupSeats(db, { tenantId: T, fareId: other.id, bookingId: "late-2", seats: 1 });
  await addBooking("late-2", "PAYMENT_PENDING");
  await pg.query(`UPDATE manual_fare_seat_holds SET expires_at = now() - interval '1 minute' WHERE booking_id = 'late-2'`);
  await releaseGroupSeats(db);
  assert.equal((await reserveGroupSeats(db, { tenantId: T, fareId: other.id, bookingId: "someone-else", seats: 1 })).ok, true);
  assert.equal(await confirmGroupSeats(db, T, "late-2"), "OVERSOLD");
  assert.equal(await seatsOf(other.id), 0);   // never negative
  assert.equal(await confirmGroupSeats(db, T, "no-such-booking"), "NO_HOLD");
});

test("a booking that could not be saved gives its seats back at once", async () => {
  const fare = await addFare({ seatsAvailable: 3 });
  await reserveGroupSeats(db, { tenantId: T, fareId: fare.id, bookingId: "never-saved", seats: 2 });
  await releaseUnsavedHold(db, T, "never-saved");
  assert.equal(await seatsOf(fare.id), 3);
  assert.equal((await holdOf("never-saved")).release_reason, "BOOKING_NOT_SAVED");
});

// ── Search and checkout quoting ──────────────────────────────────────────────

const search = (over: Record<string, unknown> = {}) => searchManualFares(env, db, T, {
  origin: "COK", destination: "DXB", departureDate: future(30), cabinClass: "ECONOMY", tripType: "ONEWAY", adults: 2, children: 0, infants: 0, ...over,
} as never);

test("live flight search (/api/search) never includes group fares; they are matched separately", async () => {
  await addFare();
  const plain = await addFare({ isGroupFare: false, isPublished: false, title: null, flightNumber: "6E1000" });
  await settings({ groupFares: true, enabled: true });
  assert.deepEqual((await search()).map((f) => f.id), [plain.id]);
  await settings({ groupFares: true, enabled: false });
  assert.deepEqual(await search(), []);
});

test("ordinary manual fares behave exactly as before", async () => {
  const plain = await addFare({ isGroupFare: false, isPublished: false, title: null, seatsAvailable: 9 });
  await settings({ enabled: true, groupFares: false });
  assert.deepEqual((await search()).map((f) => f.id), [plain.id]);
  const q = await lookupOfflineFare(env, db, T, "MANUAL", plain.id, { adults: 2, children: 0, infants: 0 });
  assert.ok("fare" in q && q.fare.totalFare === 30000);
  await settings({ enabled: false, groupFares: true });
  assert.deepEqual(await search(), []);                   // manual fares off: hidden as before
});

test("Admin price changes are what checkout quotes; deactivated and party-size problems are refused", async () => {
  const fare = await addFare({ minPax: 2 });
  const pax = { adults: 2, children: 0, infants: 0 };
  const q1 = await lookupOfflineFare(env, db, T, "MANUAL", fare.id, pax);
  assert.ok("fare" in q1 && q1.fare.totalFare === 30000);
  await pg.query(`UPDATE manual_fares SET adult_fare = 17000 WHERE id = $1`, [fare.id]);
  const q2 = await lookupOfflineFare(env, db, T, "MANUAL", fare.id, pax);
  assert.ok("fare" in q2 && q2.fare.totalFare === 34000);
  assert.deepEqual(await lookupOfflineFare(env, db, T, "MANUAL", fare.id, { adults: 1, children: 0, infants: 0 }),
    { reason: "GROUP_FARE_PARTY", message: "This group fare is for at least 2 travellers (adults and children)." });
  await pg.query(`UPDATE manual_fares SET is_active = false WHERE id = $1`, [fare.id]);
  assert.deepEqual(await lookupOfflineFare(env, db, T, "MANUAL", fare.id, pax), { reason: "NOT_FOUND" });
});

// ── Public website API ───────────────────────────────────────────────────────

function app(routes: Hono<any>, base: string, vars: Record<string, unknown> = {}) {
  const a = new Hono<any>();
  a.use("*", async (c, next) => { c.set("db", db); c.set("tenantId", T); for (const [k, v] of Object.entries(vars)) c.set(k, v); await next(); });
  a.route(base, routes);
  return (path: string, init?: RequestInit) => a.request(path, init, env, { waitUntil() {}, passThroughOnException() {} } as never);
}
const publicApi = () => app(groupFareRoutes, "/api/group-fares");

test("website list shows published fares with Admin's latest price; hidden ones aren't listed or opened", async () => {
  const pub = await addFare();
  const hidden = await addFare({ isPublished: false, flightNumber: "6E9000" });
  await addFare({ saleEndsAt: new Date(Date.now() - 1000), flightNumber: "6E9001" });
  const call = publicApi();
  let list = await (await call("/api/group-fares")).json() as any;
  assert.equal(list.enabled, true);
  assert.deepEqual(list.fares.map((f: any) => f.id), [pub.id]);
  assert.equal(list.fares[0].pricePerAdult, 15000);
  assert.equal(list.fares[0].notes, undefined);
  await pg.query(`UPDATE manual_fares SET adult_fare = 16500, title = 'Updated title' WHERE id = $1`, [pub.id]);
  list = await (await call("/api/group-fares")).json() as any;
  assert.equal(list.fares[0].pricePerAdult, 16500);
  assert.equal(list.fares[0].title, "Updated title");
  const detail = await (await call(`/api/group-fares/${pub.id}?adults=2&children=1&infants=1`)).json() as any;
  assert.equal(detail.quote.total, 2 * 16500 + 14000 + 2000);
  assert.equal(detail.quote.book.supplier, "MANUAL");
  assert.equal((await call(`/api/group-fares/${hidden.id}`)).status, 404);
  assert.equal((await call(`/api/group-fares/not-a-uuid`)).status, 404);
  await settings({ groupFares: false });
  assert.deepEqual(await (await call("/api/group-fares")).json(), { enabled: false, fares: [] });
  assert.equal((await call(`/api/group-fares/${pub.id}`)).status, 404);
  assert.deepEqual(await (await call("/api/group-fares/status")).json(), { enabled: false, count: 0 });
});

const match = (call: ReturnType<typeof publicApi>, q: Record<string, string | number>) =>
  call(`/api/group-fares/match?${new URLSearchParams(Object.entries({ origin: "COK", destination: "DXB", date: future(30), adults: 2, ...q }).map(([k, v]) => [k, String(v)]))}`);

test("search match: route + date (+ airline / flight number), only fares on sale with seats for the party", async () => {
  const call = publicApi();
  const a = await addFare({ seatsAvailable: 5 });
  const b = await addFare({ airline: "AI", airlineName: "Air India", flightNumber: "AI 933", seatsAvailable: 9, cabinClass: "BUSINESS" });
  await addFare({ isPublished: false, flightNumber: "6E9000" });                                  // unpublished
  await addFare({ isActive: false, flightNumber: "6E9001" });                                     // disabled
  await addFare({ saleEndsAt: new Date(Date.now() - 1000), flightNumber: "6E9002" });             // sale ended
  await addFare({ seatsAvailable: 0, flightNumber: "6E9003" });                                   // sold out
  await addFare({ seatsAvailable: 1, flightNumber: "6E9004" });                                   // fewer seats than the party
  await addFare({ travelDate: future(31), flightNumber: "6E9005" });                              // other date
  await addFare({ destination: "SHJ", flightNumber: "6E9006" });                                  // other route
  await addFare({ isGroupFare: false, isPublished: false, title: null, flightNumber: "6E9007" });  // ordinary manual fare

  const d = await (await match(call, {})).json() as any;
  assert.equal(d.enabled, true);
  assert.deepEqual(d.fares.map((f: any) => f.id).sort(), [a.id, b.id].sort());
  const fa = d.fares.find((f: any) => f.id === a.id);
  assert.equal(fa.quote.total, 30000);
  assert.equal(fa.pricePerAdult, 15000);
  assert.equal(fa.seatsLeft, 5);
  assert.equal(fa.quote.book.supplier, "MANUAL");
  assert.equal(fa.quote.problem, null);
  assert.equal(fa.notes, undefined);

  const byFlight = await (await match(call, { airline: "ai", flightNumber: "AI933" })).json() as any;
  assert.deepEqual(byFlight.fares.map((f: any) => f.id), [b.id]);
  assert.deepEqual(((await (await match(call, { airline: "6E", flightNumber: "6E1" })).json()) as any).fares, []);
});

test("search match: below the minimum party size the fare is shown with the reason; switch off → nothing", async () => {
  const call = publicApi();
  const fare = await addFare({ minPax: 3 });
  const d = await (await match(call, { adults: 1 })).json() as any;
  assert.equal(d.fares[0].id, fare.id);
  assert.match(d.fares[0].quote.problem, /at least 3/);
  assert.equal((await match(call, { origin: "XX" })).status, 400);
  await settings({ groupFares: false, enabled: true });
  assert.deepEqual(await (await match(call, {})).json(), { enabled: false, fares: [] });
});

test("search match reflects Admin changes at once (never cached)", async () => {
  const call = publicApi();
  const fare = await addFare();
  assert.equal(((await (await match(call, {})).json()) as any).fares[0].pricePerAdult, 15000);
  await pg.query(`UPDATE manual_fares SET adult_fare = 14000 WHERE id = $1`, [fare.id]);
  const r = await match(call, {});
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(((await r.json()) as any).fares[0].pricePerAdult, 14000);
  await pg.query(`UPDATE manual_fares SET seats_available = 0 WHERE id = $1`, [fare.id]);
  assert.deepEqual(((await (await match(call, {})).json()) as any).fares, []);
});

// ── Checkout (POST /api/book, MANUAL) ────────────────────────────────────────

const bookApi = () => app(bookDirectRoutes, "/api/book");
const traveller = (i: number) => ({ type: "ADULT", firstName: `Alex${"abcdefghij"[i]}`, lastName: "Traveller", gender: "M" });
const bookBody = (fareId: string, adults: number) => JSON.stringify({
  fareId, supplier: "MANUAL", passengers: Array.from({ length: adults }, (_, i) => traveller(i)),
  contactEmail: "guest@example.com", contactPhone: "+919999999999",
  origin: "COK", destination: "DXB", departureDate: future(30), totalFare: 1, currency: "INR",
});
const post = (call: ReturnType<typeof bookApi>, body: string) => call("/api/book", { method: "POST", headers: { "content-type": "application/json" }, body });

test("checkout creates the booking with the seats held, and keeps its price when Admin changes the fare", async () => {
  const fare = await addFare({ seatsAvailable: 4 });
  const call = bookApi();
  const res = await post(call, bookBody(fare.id, 2));
  const d = await res.json() as any;
  assert.equal(res.status, 201, JSON.stringify(d));
  assert.equal(d.amount, 30000);
  assert.equal(await seatsOf(fare.id), 2);
  assert.equal((await holdOf(d.bookingId)).status, "HELD");
  const [b] = (await pg.query<any>(`SELECT status, supplier, total_amount, flight_data FROM bookings WHERE id = $1`, [d.bookingId])).rows;
  assert.equal(b.status, "PAYMENT_PENDING");
  assert.equal(b.supplier, "MANUAL");
  assert.equal(b.flight_data.offline.groupFare.seats, 2);
  assert.equal(b.flight_data.offline.groupFare.title, "Kochi – Dubai group");

  await pg.query(`UPDATE manual_fares SET adult_fare = 99999 WHERE id = $1`, [fare.id]);
  const [after] = (await pg.query<any>(`SELECT total_amount, flight_data FROM bookings WHERE id = $1`, [d.bookingId])).rows;
  assert.equal(Number(after.total_amount), 30000);
  assert.equal(after.flight_data.offline.fare.totalFare, 30000);
});

test("checkout refuses sold-out, too-large, unpublished and expired group fares without creating a booking", async () => {
  const call = bookApi();
  const fare = await addFare({ seatsAvailable: 1 });
  const big = await post(call, bookBody(fare.id, 2));
  assert.equal(big.status, 409);
  assert.deepEqual(((await big.json()) as any).errorCode, "GROUP_FARE_SOLD_OUT");
  const small = await addFare({ minPax: 3, flightNumber: "6E1500" });
  const tooSmall = await post(call, bookBody(small.id, 2));
  assert.equal(tooSmall.status, 400);
  assert.match(((await tooSmall.json()) as any).error, /at least 3/);
  const unpublished = await addFare({ isPublished: false, flightNumber: "6E1501" });
  assert.equal(((await (await post(call, bookBody(unpublished.id, 1))).json()) as any).errorCode, "FARE_EXPIRED");
  const ended = await addFare({ saleEndsAt: new Date(Date.now() - 1000), flightNumber: "6E1502" });
  assert.equal(((await (await post(call, bookBody(ended.id, 1))).json()) as any).errorCode, "FARE_EXPIRED");
  assert.equal((await pg.query(`SELECT * FROM bookings`)).rows.length, 0);
  assert.equal(await seatsOf(fare.id), 1);
});

test("concurrent checkouts for the last seats: exactly as many bookings as seats", async () => {
  const fare = await addFare({ seatsAvailable: 3 });
  const call = bookApi();
  const responses = await Promise.all(Array.from({ length: 6 }, () => post(call, bookBody(fare.id, 1))));
  const statuses = responses.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 201, 201, 409, 409, 409]);
  assert.equal(await seatsOf(fare.id), 0);
  assert.equal((await pg.query(`SELECT * FROM bookings`)).rows.length, 3);
  assert.equal((await pg.query(`SELECT * FROM manual_fare_seat_holds WHERE status = 'HELD'`)).rows.length, 3);
});

// ── Admin → Manual fares ─────────────────────────────────────────────────────

const adminApi = () => app(flightSourcesAdminRoutes, "/api/admin/flight-sources", { userRole: "TENANT_ADMIN" });
const form = (over: Record<string, unknown> = {}) => ({
  date: future(40), origin: "COK", destination: "JED", airline: "SV", airline_name: "Saudia", flight_number: "SV 777",
  departure_time: "10:00", arrival_time: "14:00", arrival_day_offset: "0", stops: "0", cabin: "ECONOMY",
  adult_fare: "32000", child_fare: "", infant_fare: "", currency: "INR", seats: "30", refundable: false, active: true,
  group_fare: true, published: true, title: "Umrah group – Jeddah", description: "Includes 46 KG", min_pax: "1", max_pax: "", seats_total: "30", sale_ends_at: "",
  ...over,
});
const send = (call: ReturnType<typeof adminApi>, method: string, path: string, body?: unknown) =>
  call(`/api/admin/flight-sources${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

test("Admin create / update shows on the website at once and is written to the audit log", async () => {
  const admin = adminApi(), web = publicApi();
  const created = await send(admin, "POST", "/manual/fares", form());
  assert.equal(created.status, 201);
  const { fare } = await created.json() as any;
  assert.equal(fare.isGroupFare, true);
  let list = await (await web("/api/group-fares")).json() as any;
  assert.deepEqual(list.fares.map((f: any) => [f.id, f.pricePerAdult, f.title]), [[fare.id, 32000, "Umrah group – Jeddah"]]);

  const updated = await send(admin, "PUT", `/manual/fares/${fare.id}`, form({ adult_fare: "29500", title: "Umrah special", seats: "30", seats_seen: "30" }));
  assert.equal(updated.status, 200);
  list = await (await web("/api/group-fares")).json() as any;
  assert.deepEqual(list.fares.map((f: any) => [f.pricePerAdult, f.title]), [[29500, "Umrah special"]]);

  await send(admin, "PUT", `/manual/fares/${fare.id}`, form({ published: false, seats_seen: "30" }));
  assert.deepEqual(((await (await web("/api/group-fares")).json()) as any).fares, []);

  const log = (await pg.query<any>(`SELECT action, before, after FROM audit_logs WHERE entity = 'ManualFare' ORDER BY created_at`)).rows;
  assert.deepEqual(log.map((l) => l.action), ["MANUAL_FARE_CREATED", "MANUAL_FARE_UPDATED", "MANUAL_FARE_UPDATED"]);
  assert.equal(log[1].before.adultFare, "32000.00");
  assert.equal(log[1].after.adultFare, "29500.00");
});

test("Admin seat edits never undo seats a checkout took meanwhile", async () => {
  const admin = adminApi();
  const { fare } = await (await send(admin, "POST", "/manual/fares", form({ seats: "10" }))).json() as any;
  await reserveGroupSeats(db, { tenantId: T, fareId: fare.id, bookingId: "meanwhile", seats: 3 });   // Admin's form still shows 10
  await send(admin, "PUT", `/manual/fares/${fare.id}`, form({ seats: "12", seats_seen: "10" }));      // +2
  assert.equal(await seatsOf(fare.id), 9);
  const listed = await (await send(admin, "GET", "/manual/fares?group=1")).json() as any;
  assert.deepEqual(listed.fares[0].seats, { held: 3, sold: 0, oversold: 0 });
});

test("Admin can't delete or un-group a group fare with bookings; sheet fares can't become group fares", async () => {
  const admin = adminApi();
  const { fare } = await (await send(admin, "POST", "/manual/fares", form())).json() as any;
  await reserveGroupSeats(db, { tenantId: T, fareId: fare.id, bookingId: "kept", seats: 1 });
  assert.equal((await send(admin, "DELETE", `/manual/fares/${fare.id}`)).status, 409);
  assert.equal((await send(admin, "PUT", `/manual/fares/${fare.id}`, form({ group_fare: false }))).status, 409);
  const fresh = await (await send(admin, "POST", "/manual/fares", form({ flight_number: "SV778" }))).json() as any;
  assert.equal((await send(admin, "DELETE", `/manual/fares/${fresh.fare.id}`)).status, 200);
  const [sheet] = await db.insert(schema.manualFares).values({ tenantId: T, source: "SHEET", travelDate: future(10), origin: "COK", destination: "DXB",
    airline: "6E", flightNumber: "6E1", departureTime: "10:00", arrivalTime: "12:00", adultFare: "1000" }).returning();
  assert.equal((await send(admin, "PUT", `/manual/fares/${sheet.id}`, form())).status, 400);
  const actions = (await pg.query<any>(`SELECT action FROM audit_logs ORDER BY created_at`)).rows.map((r) => r.action);
  assert.ok(actions.includes("MANUAL_FARE_DELETED"));
});

test("the website switch is saved with the manual fare settings and audited", async () => {
  const admin = adminApi();
  assert.equal((await send(admin, "PUT", "/manual", { enabled: true, sheetUrl: "", autoSync: false, groupFares: false })).status, 200);
  assert.equal(JSON.parse(env.TENANT_CACHE_KV.store.get(`admin_settings:${T}:integration:manual`)).groupFares, false);
  // The existing settings form (no groupFares field) leaves the switch as it is.
  await send(admin, "PUT", "/manual", { enabled: true, sheetUrl: "", autoSync: true });
  assert.equal(JSON.parse(env.TENANT_CACHE_KV.store.get(`admin_settings:${T}:integration:manual`)).groupFares, false);
  const log = (await pg.query<any>(`SELECT action FROM audit_logs WHERE entity = 'ManualFareSettings'`)).rows;
  assert.deepEqual(log.map((l) => l.action), ["GROUP_FARES_DISABLED"]);
});
