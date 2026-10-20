import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { bookDirectRoutes } from "../src/routes/book.js";
import { bookings, bookingPassengers, payments, markupRules } from "@poomas/db/schema";

const input = { fareId: "fare-1", supplier: "TRIPJACK", passengers: [{ type: "ADULT", firstName: "Arun", lastName: "Kumar" }], contactEmail: "test@example.com", contactPhone: "+919999999999", origin: "COK", destination: "BLR", departureDate: "2026-10-10", totalFare: 99999, currency: "INR" };
async function request(total: unknown, cached = true, extras = false) {
  const writes: { table: unknown; value: any }[] = [];
  const kvWrites: string[] = [];
  const summary = { bookingId: "review-1", totalFare: total, currency: "INR", fareIdentifiers: ["PUBLISHED"], conditions: { seatApplicable: true, dobRequired: { ADULT: false } }, segments: [{ key: "S1", ssr: { baggage: [{ code: "B5", amount: 200 }], meal: [{ code: "M1", amount: 50 }], extra: [] } }] };
  const env: any = { JWT_SECRET: "test-secret", TRIPJACK_API_KEY: "test", TRIPJACK_API_BASE_URL: "https://gateway.example", TENANT_CACHE_KV: { get: async () => null }, DOCUMENTS_R2: { put: async () => {} }, SESSIONS_KV: {
    get: async (key: string) => key.startsWith("flight_review:") ? { priceIds: ["fare-1"], summary } : key.startsWith("flight_seatmap:") ? [{ key: "S1", seats: [{ code: "1A", amount: 100, booked: false }] }] : null,
    put: async (key: string) => { kvWrites.push(key); },
  } };
  const db = {
    insert: (table: unknown) => ({ values: (value: any) => { writes.push({ table, value }); return { returning: async () => [{ id: "local-1" }] }; } }),
    select: () => ({ from: (table: unknown) => ({ where: async () => table === markupRules ? [{ isActive: true, priority: 1, markupType: "FLAT", markupValue: "75" }] : [] }) }),
  };
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("tenantId" as never, "tenant-1" as never); c.set("tenant" as never, { supplierConfigs: [] } as never); c.set("db" as never, db as never); await next(); });
  app.route("/book", bookDirectRoutes);
  const passenger = extras ? { ...input.passengers[0], ssr: { baggage: [{ key: "S1", code: "B5" }], meal: [{ key: "S1", code: "M1" }], seat: [{ key: "S1", code: "1A" }] } } : input.passengers[0];
  const res = await app.request("/book", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, passengers: [passenger], ...(cached ? { reviewBookingId: "review-1" } : {}) }) }, env);
  return { res, data: await res.json() as any, writes, kvWrites };
}

test("invalid cached reviewed totals fail before any payable booking/session", async (t) => {
  for (const total of [undefined, null, "1000", "bad", NaN, Infinity, -Infinity, 0, -1]) {
    await t.test(String(total), async () => {
      const { res, data, writes, kvWrites } = await request(total);
      assert.equal(res.status, 503);
      assert.equal(data.errorCode, "FARE_REVIEW_FAILED");
      assert.equal(data.diagnosticCode, "REVIEW_TOTAL_INVALID");
      assert.equal(data.checkoutToken, undefined);
      assert.equal(writes.some((w) => [bookings, bookingPassengers, payments].includes(w.table as any)), false);
      assert.deepEqual(kvWrites, []);
    });
  }
});

test("invalid fresh review totals cannot be rescued by browser totalFare", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const total of [undefined, null, "1000", "bad", 0, -1]) {
    globalThis.fetch = async () => Response.json({ bookingId: "review-1", status: { success: true }, totalPriceInfo: { totalFareDetail: { fC: { TF: total } } } });
    const { res, writes, kvWrites } = await request(total, false);
    assert.equal(res.status, 503);
    assert.equal(writes.some((w) => [bookings, bookingPassengers, payments].includes(w.table as any)), false);
    assert.deepEqual(kvWrites, []);
  }
  globalThis.fetch = async () => new Response('{"bookingId":"review-1","status":{"success":true},"totalPriceInfo":{"totalFareDetail":{"fC":{"TF":1e999}}}}', { headers: { "Content-Type": "application/json" } });
  const overflow = await request(undefined, false);
  assert.equal(overflow.res.status, 503);
  assert.equal(overflow.data.diagnosticCode, "REVIEW_TOTAL_INVALID");
  assert.equal(overflow.writes.some((w) => [bookings, bookingPassengers, payments].includes(w.table as any)), false);
  assert.deepEqual(overflow.kvWrites, []);
});

test("valid review uses server SSR, seat prices and markup exactly once", async () => {
  const { res, data, writes } = await request(1000, true, true);
  assert.equal(res.status, 201);
  assert.equal(data.requiresPayment, true);
  assert.equal(typeof data.checkoutToken, "string");
  assert.equal(data.amount, 1425); // reviewed 1000 + baggage 200 + meal 50 + seat 100 + markup 75
  const booking = writes.find((w) => w.table === bookings)!.value;
  assert.equal(booking.baseFare, "1350");
  assert.equal(booking.markup, "75");
  assert.equal(booking.totalAmount, "1425");
  assert.equal(booking.flightData.tripjack.ssrAmount, 350);
  assert.equal(booking.flightData.tripjack.seatAmount, 100);
  assert.equal(writes.some((w) => w.table === payments), false);
});

test("valid fresh review continues with its authoritative total", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ bookingId: "review-1", status: { success: true }, totalPriceInfo: { totalFareDetail: { fC: { TF: 1000 } } } });
  const { res, data } = await request(1000, false);
  assert.equal(res.status, 201);
  assert.equal(data.amount, 1075);
});
