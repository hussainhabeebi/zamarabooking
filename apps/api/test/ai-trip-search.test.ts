import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { normalizeTripFields, todayIn } from "../src/lib/ai-trip-search.js";
import { aiRoutes } from "../src/routes/ai.js";

test("normalizes and re-checks the model's answer", () => {
  const f = normalizeTripFields({
    isFlightSearch: true, origin: { code: "cok", city: "Kochi" }, destination: { code: "DXB", city: "Dubai" },
    departureDate: "2026-10-09", returnDate: "2026-10-16", tripType: "ONEWAY",
    adults: 2, children: 0, infants: 3, cabinClass: "ECONOMY", fareType: "REGULAR",
    directOnly: false, refundableOnly: false, withBaggage: true, sort: "price", currency: null, language: "English", summary: "ok", missing: [],
  }, "2026-10-01");
  assert.deepEqual(f.origin, { code: "COK", city: "Kochi" });
  assert.equal(f.tripType, "ROUNDTRIP");            // a return date makes it a round trip
  assert.equal(f.infants, 2);                       // one lap infant per adult
  assert.equal(f.sort, "price");
  assert.deepEqual(f.missing, []);

  const g = normalizeTripFields({ origin: null, destination: { code: "DXB", city: "Dubai" }, departureDate: "2025-01-01", tripType: "ROUNDTRIP",
    returnDate: "2024-12-30", adults: 12, children: 5, infants: 0, sort: "weird", cabinClass: "LUXURY" }, "2026-10-01");
  assert.deepEqual(g.missing.sort(), ["departureDate", "origin", "returnDate"]);
  assert.equal(g.adults, 9);
  assert.equal(g.children, 0);                      // adults + children ≤ 9
  assert.equal(g.sort, "best");
  assert.equal(g.cabinClass, "ECONOMY");
});

test("today is resolved in the visitor's time zone", () => {
  assert.equal(todayIn("Asia/Kolkata", new Date("2026-10-01T20:00:00Z")).date, "2026-10-02");
  assert.equal(todayIn("Asia/Dubai", new Date("2026-10-01T19:00:00Z")).date, "2026-10-01");
});

test("POST /api/ai/trip-search calls Gemini with a JSON schema and returns form fields", async () => {
  const kv = new Map<string, string>();
  const env: any = { GEMINI_API_KEY: "G", FARE_CACHE_KV: { get: async (k: string, t?: string) => kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)!) : kv.get(k)) : null, put: async (k: string, v: string) => { kv.set(k, v); } } };
  const app = new Hono<any>();
  app.use("*", async (c, n) => { c.set("tenantId", "t"); await n(); });
  app.route("/api/ai", aiRoutes);
  const ctx: any = { waitUntil: (p: Promise<unknown>) => p, passThroughOnException() {} };
  let calls = 0; let sent: any;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls++; sent = { url, body: JSON.parse(init.body), key: init.headers["x-goog-api-key"] };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      isFlightSearch: true, origin: { code: "COK", city: "Kochi" }, destination: { code: "DXB", city: "Dubai" },
      departureDate: "2099-10-09", returnDate: "2099-10-16", tripType: "ROUNDTRIP", adults: 2, children: 0, infants: 1,
      cabinClass: "ECONOMY", fareType: "REGULAR", directOnly: false, refundableOnly: false, withBaggage: true, sort: "price",
      currency: null, language: "Malayalam", summary: "കൊച്ചി → ദുബായ്", missing: [] }) }] } }] }));
  }) as any;
  try {
    const post = () => app.fetch(new Request("http://x/api/ai/trip-search", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "കൊച്ചിയിൽ നിന്ന് ദുബായിലേക്ക് അടുത്ത വെള്ളിയാഴ്ച", timeZone: "Asia/Kolkata" }) }), env, ctx);
    const r1 = await post(); const d1: any = await r1.json();
    assert.equal(r1.status, 200, JSON.stringify(d1));
    assert.equal(d1.fields.destination.code, "DXB");
    assert.equal(d1.fields.infants, 1);
    assert.match(sent.url, /gemini-2\.5-flash:generateContent$/);
    assert.equal(sent.key, "G");
    assert.equal(sent.body.generationConfig.responseMimeType, "application/json");
    assert.ok(sent.body.generationConfig.responseSchema.properties.destination);
    assert.match(sent.body.contents[0].parts[0].text, /^TODAY: \d{4}-\d{2}-\d{2} \(\w+day\)/);
    const r2: any = await (await post()).json();      // same text again → cache, no second Gemini call
    assert.equal(r2.cached, true);
    assert.equal(calls, 1);
    const status: any = await (await app.fetch(new Request("http://x/api/ai/status"), env, ctx)).json();
    assert.equal(status.tripSearch, true);
  } finally { globalThis.fetch = realFetch; }
});
