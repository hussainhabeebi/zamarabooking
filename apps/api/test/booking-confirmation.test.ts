import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBookingResponse } from "../src/lib/booking-response.js";
import { bookingError } from "../../web/app/book/booking-error.js";
import { Hono } from "hono";
import { bookDirectRoutes } from "../src/routes/book.js";

test("wrapped supplier confirmation retains reference and PNR", () => {
  for (const wrapper of ["data", "result"]) {
    const result = normalizeBookingResponse({ [wrapper]: { status: { success: true }, bookingId: "book-1", pnr: "ABC123", bookingStatus: "CONFIRMED" } }, "session-1");
    assert.equal(result.success, true);
    assert.equal(result.bookingRef, "book-1");
    assert.equal(result.status, "CONFIRMED");
  }
});
test("accepted response is pending without confirmed status and string PNR", () => {
  const result = normalizeBookingResponse({ status: { success: true }, pnrDetails: { onward: "ABC123" } }, "session-1");
  assert.equal(result.bookingRef, "session-1");
  assert.equal(result.pnr, "");
  assert.equal(result.status, "PENDING");
});
test("explicit rejected booking is not success", () => {
  assert.equal(normalizeBookingResponse({ status: { success: false } }, "session-1").success, false);
  assert.equal(normalizeBookingResponse({ status: { success: true }, bookingStatus: "FAILED" }, "session-1").success, false);
});
test("unrecognized response is an unknown outcome, not a rejection", () => {
  assert.throws(() => normalizeBookingResponse({ unexpected: true }, "session-1"), /outcome/);
});
test("review failure remains actionable instead of generic server error", () => {
  assert.match(bookingError({ errorCode: "FARE_REVIEW_FAILED", diagnosticCode: "REVIEW_AUTH_FAILED", requestId: "ref-123" }, 503), /authorised.*ref-123/);
});
test("unknown booking outcome does not invite resubmission", () => {
  assert.match(bookingError({ errorCode: "BOOKING_STATUS_UNKNOWN" }, 502), /Do not submit again/);
});
test("untrusted supplier messages and references are not exposed", () => {
  const message = bookingError({ error: "secret-value", requestId: "secret/value", diagnosticCode: "secret-value" }, 500);
  assert.doesNotMatch(message, /secret/);
});

test("confirm route distinguishes review, submission and persistence failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const input = { fareId: "fare-1", supplier: "TRIPJACK", passengers: [{ type: "ADULT", firstName: "Arun", lastName: "Kumar" }],
    contactEmail: "test@example.com", contactPhone: "+919999999999", origin: "COK", destination: "BLR", departureDate: "2026-09-26", totalFare: 250 };
  const env = { TRIPJACK_API_KEY: "test", TRIPJACK_API_BASE_URL: "https://gateway.example", TENANT_CACHE_KV: { get: async () => null } };
  async function request(saveFails = false) {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("tenantId" as never, "tenant-1" as never);
      c.set("tenant" as never, { supplierConfigs: [] } as never);
      c.set("db" as never, { insert: () => ({ values: () => {
        if (saveFails) throw new Error("DB unavailable");
        return { returning: async () => [{ id: "local-1" }] };
      } }) } as never);
      await next();
    });
    app.route("/book", bookDirectRoutes);
    return app.request("/book", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }, env);
  }
  await t.test("review auth failure returns diagnostics and never submits", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({}, { status: 401 }); };
    const response = await request(); const data = await response.json();
    assert.equal(response.status, 503); assert.equal(data.diagnosticCode, "REVIEW_AUTH_FAILED"); assert.equal(calls, 1);
  });
  await t.test("lost submit response is unknown and does not retry", async () => {
    let calls = 0;
    globalThis.fetch = async () => { if (++calls === 1) return Response.json({ bookingId: "session-1", status: { success: true } }); throw new Error("connection lost"); };
    const response = await request(); const data = await response.json();
    assert.equal(data.errorCode, "BOOKING_STATUS_UNKNOWN"); assert.equal(calls, 2);
  });
  await t.test("accepted booking survives local save failure", async () => {
    globalThis.fetch = async (url) => Response.json(String(url).endsWith("/review")
      ? { bookingId: "session-1", status: { success: true } }
      : { bookingId: "supplier-1", status: { success: true } });
    const response = await request(true); const data = await response.json();
    assert.equal(response.status, 202); assert.equal(data.success, true);
    assert.equal(data.bookingReference, "supplier-1"); assert.equal(data.warningCode, "BOOKING_SAVE_PENDING");
  });
});
