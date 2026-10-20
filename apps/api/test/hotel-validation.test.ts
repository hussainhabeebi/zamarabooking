import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { hotelRoutes } from "../src/routes/hotel.js";
test("hotel review validation returns readable reason", async () => {
  const app = new Hono<any>();
  const logs: any[] = [];
  app.use("*", async (c, n) => { c.set("tenantId", "t"); c.set("db", { insert: () => ({ values: async (v: any) => { logs.push(v); } }) }); await n(); });
  app.route("/h", hotelRoutes);
  const res = await app.fetch(new Request("http://x/h/review", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ correlationId: "abcdefgh12", hid: "100000038374", optionId: "", checkIn: "2026-10-01", checkOut: "2026-10-08", rooms: [{ adults: 2, children: 0 }], nationality: "IN", currency: "INR" }) }),
    {}, { waitUntil: (p: any) => p, passThroughOnException() {} } as any);
  const d: any = await res.json();
  console.log(res.status, d.error);
  assert.equal(res.status, 400);
  assert.match(d.error, /optionId/);
});

test("TripJack 1092 (PAN) becomes a fixable PAN_REQUIRED error", async () => {
  const { hotelError } = await import("../src/routes/hotel.js");
  const res = hotelError({ json: (body: any, status: number) => ({ body, status }) },
    Object.assign(new Error("TripJack hotel /oms/v3/hotel/book failed (HTTP 400, 1092): Please, enter valid PAN number."), { code: "1092", statusCode: 400 }), "Booking failed") as any;
  assert.equal(res.status, 400);
  assert.equal(res.body.errorCode, "PAN_REQUIRED");
  assert.match(res.body.error, /PAN/);
});
