// POST /api/search end to end (real PostgreSQL via PGlite, Akbar mocked — no live calls):
// markup rules and manual fares are read WHILE Akbar searches, results and prices are unchanged,
// and the answer carries the Server-Timing breakdown (prep / suppliers / after / Akbar steps).
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import * as schema from "@zamrabooking/db/schema";
import { searchRoutes } from "../src/routes/search.js";

const MIGRATIONS = new URL("../../../packages/db/drizzle/migrations/", import.meta.url);
const migrationSql = (f: string) => readFileSync(new URL(f, MIGRATIONS), "utf8").replace(/CREATE EXTENSION[^;]*;/gi, "");
const T = "tenant-search-timing";
let pg: PGlite;
let db: any;

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

before(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(migrationSql(f));
  db = drizzle(pg, { schema });
  await pg.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Timing test', 'timing-test')`, [T]);
  await db.insert(schema.markupRules).values({ tenantId: T, name: "Default", markupType: "FLAT_PER_PAX", markupValue: "400", priority: 0, isActive: true });
  await db.insert(schema.manualFares).values({
    tenantId: T, source: "ADMIN", travelDate: "2099-12-09", origin: "CCJ", destination: "SHJ", airline: "G9", airlineName: "Air Arabia",
    flightNumber: "G9 455", departureTime: "04:00", arrivalTime: "06:30", arrivalDayOffset: 0, cabinClass: "ECONOMY",
    adultFare: "9000", childFare: "9000", infantFare: "1500", currency: "INR", seatsAvailable: 9, isGroupFare: false, isPublished: true,
  });
});

const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
const journey = { Index: "6E|1", Provider: "6E", VAC: "6E", FlightNo: "6E 1501", From: "CCJ", To: "SHJ", DepartureTime: "2099-12-09T21:10:00", ArrivalTime: "2099-12-09T23:40:00",
  Duration: "04h 00m ", Stops: 0, Seats: 9, AirlineName: "IndiGo", NetFare: 10000, GrossFare: 10500, Refundable: "Y", Cabin: "E" };

test("search: markup rules and manual fares are read while Akbar searches; prices unchanged; Server-Timing breakdown", async () => {
  const marks: Record<string, number> = {};
  // Every database read is timestamped (first one per table is what matters).
  const timedDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "select") return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => {
        const q = target.select(...args);
        return new Proxy(q, { get(t2, p2, r2) {
          if (p2 !== "from") return Reflect.get(t2, p2, r2);
          return (table: unknown) => {
            const name = table === schema.markupRules ? "markupRules" : table === schema.manualFares ? "manualFares" : "other";
            marks[name] ??= Date.now();
            return t2.from(table);
          };
        } });
      };
    },
  });

  const env: any = {
    TENANT_CACHE_KV: memoryKv({
      [`admin_settings:${T}:integration:akbar`]: { enabled: true, environment: "PRODUCTION", utilsUrl: "https://utils.test", flightsUrl: "https://flights.test",
        merchantId: "m", apiKey: "k", clientId: "cid", password: "p", agentCode: "", browserKey: "b", key: "", gatewayUrl: "", apiBooking: "MANUAL" },
      [`admin_settings:${T}:integration:manual`]: { enabled: true, sheetUrl: "", autoSync: false, groupFares: false },
      [`akbar_token:${T}`]: { token: "jwt", clientId: "cid" },
    }),
    FARE_CACHE_KV: memoryKv(), SESSIONS_KV: memoryKv(), ENVIRONMENT: "test", JWT_SECRET: "test-only-secret",
    DOCUMENTS_R2: { put: async () => {} },
  };
  const waits: Promise<unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const step = String(url).split("/").pop();
    if (step === "ExpressSearch") return json({ TUI: "t", Code: "200" });
    if (step === "GetExpSearch") { await new Promise((r) => setTimeout(r, 400)); marks.akbarAnswered ??= Date.now(); return json({ TUI: "t", Completed: true, Trips: [{ Journey: [journey] }] }); }
    if (step === "WebSettings") { await new Promise((r) => setTimeout(r, 300)); return json({ Settings: [] }); }
    return json({});
  }) as unknown as typeof fetch;
  try {
    const app = new Hono<any>();
    app.use("*", async (c, next) => {
      c.set("db", timedDb); c.set("tenantId", T);
      c.set("tenant", { id: T, slug: "timing-test", name: "Timing", plan: "x", region: "IN", defaultCurrency: "INR", searchRpmLimit: 100, bookingRpmLimit: 100, supplierConfigs: [], paymentConfig: null });
      await next();
    });
    app.route("/api/search", searchRoutes);
    const started = Date.now();
    const res = await app.request("/api/search", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "CCJ", destination: "SHJ", departureDate: "2099-12-09", adults: 2, cabinClass: "ECONOMY", tripType: "ONEWAY", currency: "INR" }) },
      env, { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException() {} } as never);
    const answeredAfter = Date.now() - started;
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    // Same results and prices as before: Akbar's fare + ₹400 per passenger, the manual fare included.
    const akbar = body.fares.find((f: any) => f.supplier === "AKBAR");
    const manual = body.fares.find((f: any) => f.supplier === "MANUAL");
    assert.equal(akbar.totalFare, 10000);
    assert.equal(akbar.displayPrice, 10800);           // 2 passengers × ₹400
    assert.ok(manual, "manual fare still included");
    assert.equal(manual.displayPrice, manual.totalFare + 800);
    // The database reads happened while Akbar was still searching (before its answer), not after.
    assert.ok(marks.markupRules && marks.markupRules < marks.akbarAnswered, "markup rules read during the Akbar search");
    assert.ok(marks.manualFares && marks.manualFares < marks.akbarAnswered, "manual fares read during the Akbar search");
    // The answer didn't wait for WebSettings (300 ms after the search, in the background).
    assert.ok(answeredAfter < 400 + 300 + 250, `answered after ${answeredAfter} ms`);
    // Timing breakdown.
    const timing = res.headers.get("server-timing") ?? "";
    for (const part of ["total;dur=", 'cache;desc="miss"', "prep;dur=", "suppliers;dur=", "after;dur=", "akbar-express;dur=", "akbar-polls;dur="]) {
      assert.ok(timing.includes(part), `${part} in ${timing}`);
    }
    await Promise.allSettled(waits);
    // Second identical search: from cache, header says so.
    const again = await app.request("/api/search", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "CCJ", destination: "SHJ", departureDate: "2099-12-09", adults: 2, cabinClass: "ECONOMY", tripType: "ONEWAY", currency: "INR" }) },
      env, { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException() {} } as never);
    assert.match(again.headers.get("server-timing") ?? "", /cache;desc="hit"/);
    assert.equal(((await again.json()) as any).fromCache, true);
  } finally {
    globalThis.fetch = realFetch;
    await Promise.allSettled(waits);
  }
});
