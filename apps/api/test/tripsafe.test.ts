import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { insuranceRoutes } from "../src/routes/insurance.js";
import { tripsafeAdminRoutes } from "../src/routes/admin/tripsafe.js";

function kv() {
  const m = new Map<string, string>();
  return { get: async (k: string, t?: string) => { const v = m.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
    put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); }, m };
}
const r2 = new Map<string, string>();
const inserted: any[] = [];
const db: any = { insert: () => ({ values: async (v: any) => { inserted.push(v); } }) };
const TENANT = kv();
TENANT.m.set("admin_settings:t1:integration:tripjack", JSON.stringify({ tripsafeEnabled: true, apiKey: "KEY", environment: "UAT", tripsafePayUserId: "614507" }));
const env: any = { TENANT_CACHE_KV: TENANT, SESSIONS_KV: kv(), FARE_CACHE_KV: kv(), TRIPJACK_API_BASE_URL: "https://gw.example", TRIPJACK_PROXY_KEY: "P",
  DOCUMENTS_R2: { put: async (k: string, v: string) => { r2.set(k, v); }, get: async (k: string) => r2.has(k) ? { text: async () => r2.get(k), arrayBuffer: async () => new TextEncoder().encode(r2.get(k)).buffer } : null } };

const app = new Hono<any>();
app.use("*", async (c, next) => { c.set("tenantId", "t1"); c.set("db", db); await next(); });
app.route("/api/insurance", insuranceRoutes);
app.route("/api/admin/tripsafe", tripsafeAdminRoutes);
const ctx: any = { waitUntil: () => {}, passThroughOnException: () => {} };
const req = (path: string, init?: RequestInit) => app.fetch(new Request(`https://api.x${path}`, { ...init, headers: { "Content-Type": "application/json" } }), env, ctx);

test("TripSafe search → book → policy view", async () => {
  const calls: { url: string; method: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/insurance/v2/search")) return new Response(JSON.stringify({ success: true, data: { searchId: "isid1", productInfo: [
      { productId: "ABHI-PLAN_50", planCoverage: "$50,000", insuranceProvider: "ABHI", regionName: "ASIA", planType: "REGULAR", fareDetails: { totalFare: 1060 } }] } }));
    if (url.endsWith("/insurance/v2/booking")) return new Response(JSON.stringify({ success: true, data: { bookingId: "TJS1", status: "SUCCESS", paymentResult: { status: "SUCCESS" } } }));
    if (url.endsWith("/insurance/v2/booking/TJS1")) return new Response(JSON.stringify({ success: true, data: { bookingId: "TJS1", status: "SUCCESS", productInfo: {
      insuranceTravellerInfos: [{ id: 1, firstName: "ANAND", lastName: "KUMAR", policyId: "TSON1", coiUrl: "https://s3/coi.pdf" }] } } }));
    if (url.endsWith("/insurance/v2/amendment/raise")) return new Response(JSON.stringify({ amendmentItems: [{ amendmentId: "AMD1", status: "REQUESTED", amount: 900 }], insuranceCancellationResponse: { totalAmountToRefund: 900 } }));
    if (url.endsWith("/insurance/v2/amendment/confirm")) return new Response(JSON.stringify({ amendmentItems: [{ amendmentId: "AMD1", status: "SUCCESS", amount: 900 }] }));
    return new Response("{}", { status: 404 });
  }) as any;

  const start = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 12 * 864e5).toISOString().slice(0, 10);
  const bad = await req("/api/insurance/search", { method: "POST", body: JSON.stringify({ journey: "AMT", startDate: start, coverageDuration: 50, destinations: [{ key: "EUR", type: "POPULARREGION" }], travellerDobs: ["1990-01-01"] }) });
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 0);

  const s = await req("/api/insurance/search", { method: "POST", body: JSON.stringify({ journey: "STANDALONE", startDate: start, endDate: end, destinations: [{ key: "SG", type: "COUNTRY" }], travellerDobs: ["1990-01-01"] }) });
  const sj: any = await s.json();
  assert.equal(s.status, 200, JSON.stringify(sj));
  assert.equal(sj.searchId, "isid1");
  assert.equal(calls[0].body.funnelType, "STANDALONE");

  const mismatch = await req("/api/insurance/book", { method: "POST", body: JSON.stringify({ searchId: "isid1", productId: "ABHI-PLAN_50", contact: { email: "a@b.co" },
    travellers: [{ firstName: "Anand", lastName: "Kumar", dob: "1991-01-01" }] }) });
  assert.equal(mismatch.status, 400);

  const b = await req("/api/insurance/book", { method: "POST", body: JSON.stringify({ searchId: "isid1", productId: "ABHI-PLAN_50", contact: { email: "a@b.co", phone: "+91 98765 43210" },
    travellers: [{ title: "MR", firstName: "Anand", lastName: "Kumar", dob: "1990-01-01", gender: "Male", nominee: { name: "Asha Kumar", relationship: "SPOUSE" } }] }) });
  const bj: any = await b.json();
  assert.equal(b.status, 201, JSON.stringify(bj));
  const bookCall = calls.find((c) => c.url.endsWith("/insurance/v2/booking"))!;
  assert.deepEqual(bookCall.body.paymentOptions, { payUserId: "614507", paymentMedium: "WALLET" });
  assert.equal(bookCall.body.travellerInfos[0].id, 1);
  assert.equal(bookCall.body.travellerInfos[0].contactNumber, "9876543210");
  assert.deepEqual(bookCall.body.travellerInfos[0].nomineeInfo, [{ nomineeName: "ASHA KUMAR", nomineeRelationship: "SPOUSE" }]);

  const denied = await req(`/api/insurance/bookings/${bj.reference}?key=wrong`);
  assert.equal(denied.status, 404);
  const v = await req(`/api/insurance/bookings/${bj.reference}?key=${bj.key}`);
  const vj: any = await v.json();
  assert.equal(vj.status, "SUCCESS");
  assert.equal(vj.details.travellers[0].policyId, "TSON1");
  assert.equal(vj.accessKey, undefined);

  // Admin: list, cancel (raise + confirm), certification pack
  const list: any = await (await req("/api/admin/tripsafe/bookings")).json();
  assert.equal(list.bookings[0].reference, bj.reference);
  const raise = await req(`/api/admin/tripsafe/bookings/${bj.reference}/amendment/raise`, { method: "POST", body: JSON.stringify({ type: "CANCELLATION", travellerIds: [1] }) });
  const rj: any = await raise.json();
  assert.equal(raise.status, 200, JSON.stringify(rj));
  const raiseCall = calls.find((c) => c.url.endsWith("/amendment/raise"))!;
  assert.deepEqual(raiseCall.body.travellerKeys, { isid1: { "ABHI-PLAN_50": [{ id: 1 }] } });
  const conf = await req(`/api/admin/tripsafe/bookings/${bj.reference}/amendment/confirm`, { method: "POST", body: JSON.stringify({ amendmentId: "AMD1" }) });
  const cj: any = await conf.json();
  assert.equal(cj.amendment.status, "SUCCESS", JSON.stringify(cj));
  assert.equal(calls.find((c) => c.url.endsWith("/amendment/confirm"))!.body.paymentRequests, undefined);

  // Exchanges were stored with the apikey but never the gateway key
  const reqFiles = [...r2.entries()].filter(([k]) => k.endsWith("-request.json")).map(([, v]) => JSON.parse(v));
  assert.ok(reqFiles.length >= 5);
  assert.ok(reqFiles.every((f) => f.headers.apikey === "KEY" && !Object.keys(f.headers).some((h) => h.toLowerCase() === "x-poomas-gateway-key")));
  assert.ok(inserted.some((x) => x.bookingId === bj.reference && x.endpoint === "/insurance/v2/booking"));
  assert.ok(inserted.some((x) => x.searchId === "isid1" && x.endpoint === "/insurance/v2/search"));
});
