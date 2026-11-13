// Per-passenger, once-per-journey markup (lib/markup.ts) and its use in search, checkout, group fares
// and the Partner API. Rules as configured for Zamra: all airlines ₹400 per passenger, Oman Air (WY)
// and Saudia (SV) ₹600 per passenger instead. Checkout runs on a real PostgreSQL engine (PGlite) with
// the repository's migrations; no supplier is called, nothing is paid.
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import * as schema from "@zamrabooking/db/schema";
import { applyMarkup, isJourneyContinuation, markupAmount, paxTotal, priceSearchFares } from "../src/lib/markup.js";
import { bookDirectRoutes, customerPrice } from "../src/routes/book.js";
import { partnerPublicFare, partnerRoutes } from "../src/routes/partner.js";
import { rememberOfflineFares } from "../src/lib/flight-sources.js";

// ── The configured rules ─────────────────────────────────────────────────────

const rule = (o: Record<string, unknown>) => ({ agentId: null, markupType: "FLAT_PER_PAX", markupValue: "400", priority: 0, isActive: true, validFrom: null, validTo: null,
  airline: null, origin: null, destination: null, cabinClass: null, supplier: null, tripType: null, ...o });
const RULES = [
  rule({ name: "All airlines", markupValue: "400", priority: 0 }),
  rule({ name: "Oman Air", airline: "WY", markupValue: "600", priority: 10 }),
  rule({ name: "Saudia", airline: "SV", markupValue: "600", priority: 10 }),
];
const fare = (o: Record<string, unknown> = {}) => ({ totalFare: 10000, airline: "6E", origin: "COK", destination: "DXB", cabinClass: "ECONOMY", supplier: "AKBAR", ...o }) as any;
const ONE = { adults: 1 };

test("normal airline: ₹400 per passenger", () => {
  assert.equal(markupAmount(fare(), RULES as any, { pax: ONE }), 400);
  assert.equal(applyMarkup(fare(), RULES as any, { pax: ONE }), 10400);
});

test("Oman Air (WY) and Saudia (SV): ₹600 per passenger instead — never ₹600 + ₹400", () => {
  for (const airline of ["WY", "SV", "wy"]) {
    assert.equal(markupAmount(fare({ airline }), RULES as any, { pax: ONE }), 600, airline);
    assert.equal(applyMarkup(fare({ airline }), RULES as any, { pax: { adults: 3 } }), 10000 + 1800, airline);
  }
  // Rule order in the table doesn't matter: priority decides.
  assert.equal(markupAmount(fare({ airline: "WY" }), [...RULES].reverse() as any, { pax: ONE }), 600);
});

test("every passenger counts: adults, children and infants", () => {
  assert.equal(paxTotal({ adults: 2, children: 1, infants: 1 }), 4);
  assert.equal(markupAmount(fare(), RULES as any, { pax: { adults: 2, children: 1, infants: 1 } }), 1600);
  assert.equal(markupAmount(fare({ airline: "SV" }), RULES as any, { pax: { adults: 1, infants: 1 } }), 1200);
  assert.equal(markupAmount(fare(), RULES as any, {}), 400);   // no count given: 1 passenger
});

test("round trip and multi-city: once per passenger per journey, never per flight", () => {
  assert.equal(isJourneyContinuation(undefined), false);
  for (const k of ["COMBO", "ONWARD", "0"]) assert.equal(isJourneyContinuation(k), false, k);
  for (const k of ["RETURN", "1", "2", "5"]) assert.equal(isJourneyContinuation(k), true, k);

  const pax = { adults: 2, children: 1 };
  // Separate legs: the first leg carries the journey's markup, the return none.
  const rt = priceSearchFares([fare({ tripKey: "ONWARD", totalFare: 9000 }), fare({ tripKey: "RETURN", totalFare: 8000, origin: "DXB", destination: "COK" })], RULES as any, { pax });
  assert.deepEqual(rt.map((f) => f.displayPrice), [9000 + 1200, 8000]);
  // One fare for the whole journey: the markup once.
  assert.equal(priceSearchFares([fare({ tripKey: "COMBO", totalFare: 17000 })], RULES as any, { pax })[0].displayPrice, 17000 + 1200);
  // Multi-city, 3 legs: once.
  const mc = priceSearchFares([fare({ tripKey: "0" }), fare({ tripKey: "1" }), fare({ tripKey: "2" })], RULES as any, { pax: ONE });
  assert.equal(mc.reduce((n, f) => n + f.displayPrice, 0), 30000 + 400);
  // The journey's rule is its first leg's airline.
  const wy = priceSearchFares([fare({ tripKey: "ONWARD", airline: "WY" }), fare({ tripKey: "RETURN", airline: "6E" })], RULES as any, { pax: ONE });
  assert.equal(wy.reduce((n, f) => n + f.displayPrice, 0), 20000 + 600);
});

test("Partner API offers are booked one by one: each carries its full markup", () => {
  const legs = priceSearchFares([fare({ tripKey: "ONWARD" }), fare({ tripKey: "RETURN" })], RULES as any, { pax: { adults: 2 }, standalone: true });
  assert.deepEqual(legs.map((f) => f.displayPrice), [10800, 10800]);
});

test("percentage rules, per-booking FLAT, inactive / expired rules and agency rules behave as before", () => {
  const pct = [rule({ markupType: "PERCENTAGE", markupValue: "5" })];
  assert.equal(applyMarkup(fare({ tripKey: "RETURN" }), pct as any, { continuation: true }), 10500);   // % applies to every leg
  const flat = [rule({ markupType: "FLAT", markupValue: "300" })];
  assert.equal(applyMarkup(fare(), flat as any, { pax: { adults: 4 } }), 10300);                        // per booking: not multiplied
  assert.equal(applyMarkup(fare(), flat as any, { continuation: true }), 10000);                        // …and once per journey
  assert.equal(markupAmount(fare(), [rule({ isActive: false })] as any, { pax: ONE }), 0);
  assert.equal(markupAmount(fare(), [rule({ validTo: new Date(Date.now() - 1000) })] as any, { pax: ONE }), 0);
  const agency = [...RULES, rule({ agentId: "ag1", markupValue: "100", priority: 0 })];
  assert.equal(markupAmount(fare({ airline: "WY" }), agency.filter((r) => !r.agentId || r.agentId === "ag1") as any, { pax: ONE }), 100);
});

test("Partner API response: the final customer price only, no supplier cost", () => {
  const out = partnerPublicFare({ id: "tj-1", supplier: "TRIPJACK", totalFare: 30000, displayPrice: 30800, baseFare: 25000, taxes: 5000, perAdultFare: 15000,
    raw: { secret: 1 }, airline: "6E", flightNumber: "6E1403", currency: "INR", seatsLeft: 4, fareClass: "R" });
  assert.equal(out.totalFare, 30800);
  assert.equal(out.displayPrice, 30800);
  for (const k of ["id", "supplier", "baseFare", "taxes", "perAdultFare", "raw"]) assert.equal(k in out, false, k);
  assert.equal(out.airline, "6E");
  assert.equal(out.fareClass, "R");
});

// ── Checkout on a real PostgreSQL engine ─────────────────────────────────────

const MIGRATIONS = new URL("../../../packages/db/drizzle/migrations/", import.meta.url);
let pg: PGlite;
let db: any;
const T = "tenant-markup";
function memoryKv(init: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return {
    store,
    async get(k: string, type?: string) { const v = store.get(k) ?? null; return v && type === "json" ? JSON.parse(v) : v; },
    async put(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
  };
}
let env: any;

before(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8").replace(/CREATE EXTENSION[^;]*;/gi, ""));
  }
  db = drizzle(pg, { schema });
  await pg.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Markup', 'markup')`, [T]);
  for (const r of RULES) {
    await pg.query(`INSERT INTO markup_rules (tenant_id, name, airline, markup_type, markup_value, priority, is_active) VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [T, r.name, r.airline, r.markupType, r.markupValue, r.priority]);
  }
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM booking_passengers; DELETE FROM bookings; DELETE FROM manual_fares;`);
  env = {
    TENANT_CACHE_KV: memoryKv({ [`admin_settings:${T}:integration:manual`]: { enabled: true, sheetUrl: "", autoSync: false } }),
    FARE_CACHE_KV: memoryKv(), SESSIONS_KV: memoryKv(), JWT_SECRET: "test-secret-markup-only", ENVIRONMENT: "test",
  };
});

const dbRules = async () => (await pg.query<any>(`SELECT * FROM markup_rules WHERE tenant_id = $1`, [T])).rows.map((r) => ({
  agentId: r.agent_id, markupType: r.markup_type, markupValue: r.markup_value, airline: r.airline, origin: r.origin, destination: r.destination,
  cabinClass: r.cabin_class, supplier: r.supplier, tripType: r.trip_type, priority: r.priority, isActive: r.is_active, validFrom: r.valid_from, validTo: r.valid_to,
}));

function app(routes: Hono<any>, base: string) {
  const a = new Hono<any>();
  a.use("*", async (c, next) => { c.set("db", db); c.set("tenantId", T); await next(); });
  a.route(base, routes);
  return (path: string, init?: RequestInit) => a.request(path, init, env, { waitUntil() {}, passThroughOnException() {} } as never);
}
const travellers = (types: string[]) => types.map((type, i) => ({ type, firstName: `Alex${"abcdefghij"[i]}`, lastName: "Traveller", gender: "M" }));
const post = (body: unknown) => app(bookDirectRoutes, "/api/book")("/api/book", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const bookingRow = async (id: string) => (await pg.query<any>(`SELECT total_amount, base_fare, markup FROM bookings WHERE id = $1`, [id])).rows[0];

test("checkout charges what search showed — one-way, 3 passengers incl. an infant (manual fare)", async () => {
  for (const [airline, perPax] of [["6E", 400], ["WY", 600], ["SV", 600]] as const) {
    await pg.exec(`DELETE FROM manual_fares;`);
    const [m] = await db.insert(schema.manualFares).values({ tenantId: T, travelDate: "2026-12-20", origin: "COK", destination: "DXB", airline, flightNumber: `${airline}100`,
      departureTime: "10:00", arrivalTime: "12:00", adultFare: "10000", childFare: "9000", infantFare: "1500", currency: "INR", seatsAvailable: 9 }).returning();
    const supplier = 10000 + 9000 + 1500;
    // Search side: the price the customer is shown.
    const shown = priceSearchFares([{ ...fare({ airline, supplier: "MANUAL" }), totalFare: supplier }], await dbRules(), { pax: { adults: 1, children: 1, infants: 1 } })[0].displayPrice;
    assert.equal(shown, supplier + 3 * perPax, airline);
    // Checkout side.
    const res = await post({ fareId: m.id, supplier: "MANUAL", passengers: travellers(["ADULT", "CHILD", "INFANT"]), contactEmail: "guest@example.com", contactPhone: "+919999999999",
      origin: "COK", destination: "DXB", departureDate: "2026-12-20", totalFare: 1, currency: "INR" });
    const d = await res.json() as any;
    assert.equal(res.status, 201, JSON.stringify(d));
    assert.equal(d.amount, shown, airline);
    const row = await bookingRow(d.bookingId);
    assert.deepEqual([Number(row.total_amount), Number(row.base_fare), Number(row.markup)], [shown, supplier, 3 * perPax], airline);
  }
});

test("checkout of an Akbar round trip: markup once per passenger for the whole journey, equal to search", async () => {
  const legFare = (tui: string, origin: string, destination: string, date: string, totalFare: number, airline: string) => ({
    id: `AK|${tui}|idx-1`, supplier: "AKBAR", isBookable: true, airline, airlineName: airline, flightNumber: `${airline}1`, origin, destination,
    departureTime: `${date}T10:00:00`, arrivalTime: `${date}T13:00:00`, duration: 180, stops: 0, stopDetails: [], cabinClass: "ECONOMY",
    baseFare: totalFare, taxes: 0, totalFare, perAdultFare: totalFare / 2, currency: "INR", isRefundable: false, baggage: { cabin: "7 KG", checked: "30 KG" },
    fareClass: "", raw: { tui, index: "idx-1", netFare: totalFare },
  });
  for (const [airline, perPax] of [["6E", 400], ["SV", 600]] as const) {
    const out = legFare(`tui-out-${airline}`, "COK", "DXB", "2026-12-01", 20000, airline);
    const back = legFare(`tui-back-${airline}`, "DXB", "COK", "2026-12-10", 18000, "6E");
    const pax = { adults: 2, children: 0, infants: 0 };
    await rememberOfflineFares(env, T, [out, back] as any, pax);
    const shown = priceSearchFares([{ ...out, tripKey: "ONWARD" }, { ...back, tripKey: "RETURN" }] as any, await dbRules(), { pax })
      .reduce((n, f) => n + f.displayPrice, 0);
    assert.equal(shown, 38000 + 2 * perPax);   // never 2 × per flight
    const res = await post({ fareId: out.id, priceIds: [out.id, back.id], tripType: "ROUNDTRIP", supplier: "AKBAR", passengers: travellers(["ADULT", "ADULT"]),
      contactEmail: "guest@example.com", contactPhone: "+919999999999", origin: "COK", destination: "DXB", departureDate: "2026-12-01", totalFare: 1, currency: "INR" });
    const d = await res.json() as any;
    assert.equal(res.status, 201, JSON.stringify(d));
    assert.equal(d.amount, shown, airline);
    const row = await bookingRow(d.bookingId);
    assert.deepEqual([Number(row.total_amount), Number(row.base_fare), Number(row.markup)], [shown, 38000, 2 * perPax], airline);
  }
});

test("customerPrice (TripJack checkout, group fares): whole journey once, every passenger", async () => {
  const at = (airline: string, pax: any) => customerPrice(db, T, 50000, { origin: "COK", destination: "JED", supplier: "TRIPJACK", airline }, null, { pax });
  assert.equal(await at("6E", { adults: 1 }), 50400);
  assert.equal(await at("SV", { adults: 2, infants: 1 }), 51800);
  assert.equal(await at("WY", { adults: 1, children: 2 }), 51800);
});

test("Partner reservation: charges the offer's customer price once and records the markup", async () => {
  const rawKey = "pmsk_markup_test_key";
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const [key] = (await pg.query<any>(`INSERT INTO tenant_api_keys (tenant_id, name, key_hash, key_prefix, scopes) VALUES ($1, 'CRM', $2, 'pmsk_mar', '{search,booking}') RETURNING id`, [T, hash])).rows;
  const supplierFare = { id: "tj-1", supplier: "TRIPJACK", isBookable: true, airline: "SV", origin: "COK", destination: "JED", departureTime: "2026-12-05T08:00:00",
    cabinClass: "ECONOMY", baseFare: 40000, taxes: 10000, totalFare: 50000, currency: "INR" };
  // The offer as the partner search stored it: priced standalone for 2 passengers.
  const [priced] = priceSearchFares([supplierFare as any], await dbRules(), { pax: { adults: 2 }, standalone: true });
  assert.equal(priced.displayPrice, 51200);
  const offerId = crypto.randomUUID();
  env.SESSIONS_KV.store.set(`partner_offer:${T}:${offerId}`, JSON.stringify({ version: 1, partnerApiKeyId: key.id, searchId: crypto.randomUUID(),
    searchParams: { origin: "COK", destination: "JED", departureDate: "2026-12-05", adults: 2, children: 0, infants: 0, tripType: "ONEWAY", cabinClass: "ECONOMY" },
    fare: priced, expiresAt: new Date(Date.now() + 600_000).toISOString() }));
  const res = await app(partnerRoutes, "/api/partner/v1")(`/api/partner/v1/offers/${offerId}/reserve`, {
    method: "POST", headers: { "content-type": "application/json", "X-API-Key": rawKey }, body: JSON.stringify({ externalReference: "crm-1" }) });
  const d = await res.json() as any;
  assert.equal(res.status, 201, JSON.stringify(d));
  assert.equal(Number(d.totalAmount), 51200);
  const [row] = (await pg.query<any>(`SELECT total_amount, base_fare, taxes, markup FROM bookings WHERE id = $1`, [d.reservationId])).rows;
  assert.deepEqual([Number(row.total_amount), Number(row.base_fare), Number(row.taxes), Number(row.markup)], [51200, 40000, 10000, 1200]);
});
