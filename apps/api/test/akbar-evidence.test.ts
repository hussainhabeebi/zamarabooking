import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { akbarConfirmation, redactAkbarJson } from "../src/lib/akbar-evidence.js";
import { persistExchanges } from "../src/lib/api-exchanges.js";
import { bookDirectRoutes } from "../src/routes/book.js";
import { bookingsAdminRoutes } from "../src/routes/admin/bookings.js";

test("payment and manual references never establish Akbar API confirmation", () => {
  for (const status of ["CONFIRMED", "TICKETED"]) {
    const c = akbarConfirmation({ status, pnr: "MANUAL", supplierBookingRef: "manual-ref" });
    assert.equal(c.supplierConfirmed, false);
    assert.equal(c.transactionId, null);
    assert.match(c.label, /unverified/);
  }
});
test("Akbar JSON exports retain genuine transaction evidence but redact sensitive fields", () => {
  const out = JSON.parse(redactAkbarJson(JSON.stringify({ TransactionId: 12345, PNR: "ABC123", Token: "secret", Passenger: { FirstName: "Private", PassportNumber: "Private" }, headers: { Authorization: "secret", "Set-Cookie": "secret" } })));
  assert.equal(out.TransactionId, 12345);
  assert.equal(out.PNR, "ABC123");
  assert.doesNotMatch(JSON.stringify(out), /secret|Private/);
  assert.doesNotMatch(redactAkbarJson("error with secret"), /error with secret/);
});
test("stored Akbar logs are sanitized without modifying TripJack log handling", async () => {
  const writes = new Map<string, string>(); const rows: any[] = [];
  const env = { DOCUMENTS_R2: { put: async (key: string, value: string) => { writes.set(key, value); } } };
  const db = { insert: () => ({ values: async (row: any) => { rows.push(row); } }) };
  const exchange = { endpoint: "/flights/ExpressSearch", url: "https://example.test/flights/ExpressSearch", method: "POST", requestHeaders: { Authorization: "secret" }, requestBody: '{"Password":"secret"}', status: 200, responseHeaders: {}, responseBody: '{"TransactionId":12345,"Email":"private@example.test"}', startedAt: "2026-10-28T12:00:00.000Z", durationMs: 1 };
  await persistExchanges(env as any, db as any, "tenant", [{ ...exchange, supplier: "AKBAR" }] as any, { bookingId: "booking" });
  assert.equal(rows[0].supplier, "AKBAR");
  assert.doesNotMatch([...writes.values()].join(""), /secret|private@example/);
  writes.clear();
  await persistExchanges(env as any, db as any, "tenant", [{ ...exchange, supplier: "TRIPJACK" }] as any, { bookingId: "booking" });
  assert.match([...writes.values()].join(""), /secret/); // existing TripJack behavior unchanged
});
test("Akbar direct booking fails before DB writes, payment or any network call", async () => {
  const app = new Hono();
  app.route("/book", bookDirectRoutes);
  const response = await app.request("/book", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    fareId: "AK|tui|index", supplier: "AKBAR", passengers: [{ type: "ADULT", firstName: "Arun", lastName: "Kumar" }], contactEmail: "test@example.test", contactPhone: "+919999999999", origin: "COK", destination: "DXB", departureDate: "2026-12-01", totalFare: 100,
  }) }, {});
  assert.equal(response.status, 409);
  assert.equal((await response.json()).errorCode, "AKBAR_BOOKING_DISABLED");
});
test("Admin cannot assert Akbar confirmation through an internal status override", async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, "tenant" as never);
    c.set("db" as never, { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ supplier: "AKBAR" }] }) }) }) } as never);
    await next();
  });
  app.route("/bookings", bookingsAdminRoutes);
  for (const status of ["CONFIRMED", "TICKETED"]) {
    const res = await app.request("/bookings/booking/status", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    assert.equal(res.status, 409);
  }
});

test("Akbar request download uses recorded Akbar URL and redacts historical secrets", async () => {
  const booking = { id: "booking", tenantId: "tenant", supplier: "AKBAR", status: "CONFIRMED", flightData: { searchId: "search" } };
  let selects = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, "tenant" as never);
    c.set("db" as never, { select: () => {
      const row = ++selects === 1 ? booking : { supplier: "AKBAR", endpoint: "/flights/ExpressSearch", requestKey: "request.json" };
      return { from: () => ({ where: () => ({ limit: async () => [row] }) }) };
    } } as never);
    await next();
  });
  app.route("/bookings", bookingsAdminRoutes);
  const res = await app.request("/bookings/booking/exchanges/exchange/request", {}, {
    DOCUMENTS_R2: { get: async () => ({ text: async () => JSON.stringify({ url: "https://akbar.example.test/flights/ExpressSearch", headers: { Authorization: "secret" }, body: { ClientID: "secret" } }) }) },
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /akbar\.example\.test/);
  assert.doesNotMatch(text, /tripjack|secret/);
});
test("Akbar cannot be downloaded through the TripJack booking ZIP exporter", async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, "tenant" as never);
    c.set("db" as never, { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "booking", tenantId: "tenant", supplier: "AKBAR" }] }) }) }) } as never);
    await next();
  });
  app.route("/bookings", bookingsAdminRoutes);
  assert.equal((await app.request("/bookings/booking/exchanges.zip")).status, 409);
});
