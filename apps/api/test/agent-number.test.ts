import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { currencyForCountry, normalizeAgentNumber, regionForCountry, walletCurrencyFor } from "../src/lib/agent-number.js";
import { integrationRoutes } from "../src/routes/integrations.js";
import { withAgentCurrency } from "../src/routes/search.js";

function memoryKv(init: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    async get(k: string, t?: string) { const v = store.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
    async put(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
  } as any;
}

test("agent numbers are normalised and validated", () => {
  assert.equal(normalizeAgentNumber(" fpa 10023 "), "FPA10023");
  assert.equal(normalizeAgentNumber("FPA-10023"), "FPA10023");
  assert.equal(normalizeAgentNumber("FPA12"), null);
  assert.equal(normalizeAgentNumber("ABC10023"), null);
  assert.equal(normalizeAgentNumber(undefined), null);
});

test("currency, wallet and region follow the agency's country", () => {
  assert.deepEqual(["IN", "ae", "SA", "QA", "OM", "KW", "BH", "GB"].map(currencyForCountry), ["INR", "AED", "SAR", "QAR", "OMR", "KWD", "BHD", "USD"]);
  assert.deepEqual(["INR", "AED", "SAR", "KWD", "USD"].map((c) => walletCurrencyFor(c as any)), ["INR", "AED", "AED", "AED", "USD"]);
  assert.equal(regionForCountry("in"), "INDIA");
  assert.equal(regionForCountry("SA"), "GCC");
});

test("search results get prices in the agency's currency", async () => {
  const kv = memoryKv({ "fx_auto:INR": { inrPer: { AED: 22.7, SAR: 22.2, QAR: 22.9, OMR: 216.8, KWD: 272.4, BHD: 221.2, USD: 83.4 }, source: "t", fetchedAt: new Date().toISOString() } });
  const app = new Hono<any>();
  app.use("*", async (c, n) => { c.set("tenantId", "t1"); await n(); });
  app.get("/", (c) => withAgentCurrency(c as any, Response.json({ fares: [{ id: "a", displayPrice: 27240, currency: "INR" }, { id: "b", totalFare: 100, currency: "USD" }] }),
    { id: "ag", number: "FPA10001", businessName: "Kuwait Air Travel", currency: "KWD", status: "APPROVED" }));
  const res = await app.fetch(new Request("http://x/"), { TENANT_CACHE_KV: kv }, { waitUntil() {}, passThroughOnException() {} } as any);
  const d = await res.json() as any;
  assert.deepEqual(d.agent, { number: "FPA10001", businessName: "Kuwait Air Travel", currency: "KWD", status: "APPROVED" });
  assert.equal(d.agentCurrency.inrPerUnit, 272.4);
  assert.deepEqual(d.fares[0].agentPrice, { amount: 100, currency: "KWD" });    // 27,240 / 272.4, 3 decimals
  assert.equal(d.fares[1].agentPrice, undefined);                               // non-INR fares are left alone
});

test("Leadvyne checkout links carry the agency; unknown numbers never block checkout", async () => {
  const agent = { id: "ag1", number: "FPA10006", businessName: "Riyadh Wings", currency: "SAR", status: "APPROVED" };
  const kv = memoryKv({ "agent_no:t1:FPA10006": agent, "agent_no:t1:FPA10007": { ...agent, number: "FPA10007", status: "SUSPENDED" }, "agent_no:t1:FPA99999": { none: true } });
  const tracked: string[] = [];
  const db: any = { insert: () => ({ values: () => ({ onConflictDoUpdate: async () => { tracked.push("checkout"); } }) }) };
  const app = new Hono<any>();
  app.use("*", async (c, n) => { c.set("tenantId", "t1"); c.set("db", db); await n(); });
  app.route("/api/integrations", integrationRoutes);
  const env = { SESSIONS_KV: kv, TENANT_CACHE_KV: kv, POOMAS_INTEGRATION_KEY: "ik" };
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as any;
  const body = { fareId: "F1", supplier: "TRIPJACK", passengers: [{ type: "ADULT", firstName: "Ali", lastName: "Khan" }], contact: { email: "a@b.co", mobile: "+966511111111" } };
  const post = (extra: Record<string, unknown>, headers: Record<string, string> = {}) => app.fetch(new Request("http://x/api/integrations/checkout-sessions", {
    method: "POST", headers: { "Content-Type": "application/json", "X-POOMAS-INTEGRATION-KEY": "ik", ...headers }, body: JSON.stringify({ ...body, ...extra }),
  }), env, ctx);

  let res = await post({}, { "X-FP-Agent": "fpa10006" });
  assert.equal(res.status, 201);
  let d = await res.json() as any;
  assert.match(d.checkoutUrl, /&pc=SAR$/);
  assert.equal(d.agent.number, "FPA10006");
  const saved = JSON.parse(kv.store.get(`booking_prefill:t1:${d.sessionId}`));
  assert.equal(saved.agentNumber, "FPA10006");
  assert.equal(saved.agentCurrency, "SAR");
  await Promise.all(waits);
  assert.deepEqual(tracked, ["checkout"]);

  res = await post({ agentNumber: "FPA99999" });
  d = await res.json() as any;
  assert.equal(res.status, 201);
  assert.match(d.warning, /Unknown FlyPoomas agent number FPA99999/);
  assert.doesNotMatch(d.checkoutUrl, /pc=/);

  res = await post({ agentNumber: "FPA10007" });
  d = await res.json() as any;
  assert.match(d.warning, /suspended/);
  assert.equal(tracked.length, 1);                                              // only the approved agency was counted
});
