// Akbar baggage from free SSR before pricing (lib/akbar-search-baggage.ts, suppliers akbar/ssr-baggage.ts).
// Real Akbar UAT SSR answers (fixtures/akbar-ssr-samples.json). Akbar is never called: SSR, the minute
// limiter and KV are stand-ins, so the tests count every call that would go to Akbar.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { akbarSsrBaggage, ssrBody } from "@zamrabooking/suppliers";
import {
  DEFAULT_SEARCH_BAGGAGE, normalizeSettings, productKeyParts, searchBaggage, type SearchBaggageSettings,
} from "../src/lib/akbar-search-baggage.js";
import { fareBaggageRoutes } from "../src/routes/fare-baggage.js";
import { akbarSearchBaggageAdminRoutes } from "../src/routes/admin/akbar-search-baggage.js";

const S = JSON.parse(readFileSync(new URL("./fixtures/akbar-ssr-samples.json", import.meta.url), "utf8"));
const T = "tenant-ssr-test";

// ── Reading the SSR answer ─────────────────────────────────────────────────────

test("IndiGo direct: adult / child / infant allowances, check-in and cabin separately", () => {
  const r = akbarSsrBaggage(S.indigoDirect, { carriers: ["6E"], index: "6E|1" });
  assert.equal(r.status, "CONFIRMED");
  if (r.status !== "CONFIRMED") return;
  assert.deepEqual(r.adult, { checked: "15 kg", cabin: "7 kg", checkedStatus: "INCLUDED", cabinStatus: "INCLUDED" });
  assert.deepEqual(r.child, { checked: "15 kg", cabin: "7 kg", checkedStatus: "INCLUDED", cabinStatus: "INCLUDED" });
  assert.deepEqual(r.infant, { checked: "No check-in bag", cabin: "7 kg", checkedStatus: "NONE", cabinStatus: "INCLUDED" });
});

test("a connection (two flights, one journey) with the same allowance on both is confirmed once", () => {
  // Provider "AM" is Amadeus (the content source); each flight's airline is VAC "AI".
  const r = akbarSsrBaggage(S.connecting, { carriers: ["AI"], index: "AM|5" });
  assert.equal(r.status, "CONFIRMED");
  if (r.status !== "CONFIRMED") return;
  assert.equal(r.segments.length, 2);
  assert.deepEqual([r.adult.checked, r.adult.cabin], ["15 kg", "7 kg"]);
  assert.deepEqual([r.infant!.checked, r.infant!.cabin], ["10 kg", "No cabin bag"]);
});

test("flights with different allowances are never merged (VARIES, per flight)", () => {
  const d = structuredClone(S.connecting);
  d.Trips[0].Journey[0].Segments[1].SSR.find((x: any) => x.PTC === "ADT").Description = "25 Kg, 7 Kg";
  const r = akbarSsrBaggage(d, { carriers: ["AI"], index: "AM|5" });
  assert.equal(r.status, "VARIES");
  if (r.status !== "VARIES") return;
  assert.deepEqual(r.segments.map((s) => s.byPtc.ADT!.checked), ["15 kg", "25 kg"]);
});

test("never used for another fare: wrong airline, other Index echoed, several journeys, errors, paid or duplicate bags", () => {
  assert.equal(akbarSsrBaggage(S.indigoDirect, { carriers: ["SG"], index: "6E|1" }).status, "UNKNOWN");
  const echoed = structuredClone(S.indigoDirect); echoed.Trips[0].Journey[0].Segments[0].Index = "6E|2";
  assert.equal(akbarSsrBaggage(echoed, { carriers: ["6E"], index: "6E|1" }).status, "UNKNOWN");
  const two = structuredClone(S.indigoDirect); two.Trips[0].Journey.push(structuredClone(two.Trips[0].Journey[0]));
  assert.equal(akbarSsrBaggage(two, { carriers: ["6E"], index: "6E|1" }).status, "UNKNOWN");
  const expired = akbarSsrBaggage(S.storeExpired, { carriers: ["AI"], index: "AM|1" });
  assert.equal(expired.status, "UNKNOWN");
  assert.match((expired as { reason: string }).reason, /Unable to Fetch Store Response/);
  const paid = structuredClone(S.indigoDirect); for (const x of paid.Trips[0].Journey[0].Segments[0].SSR) x.Charge = 1450;
  assert.equal(akbarSsrBaggage(paid, { carriers: ["6E"], index: "6E|1" }).status, "UNKNOWN");   // paid extra bags are not the allowance
  const dup = structuredClone(S.indigoDirect); dup.Trips[0].Journey[0].Segments[0].SSR.push({ ...dup.Trips[0].Journey[0].Segments[0].SSR[0], Description: "20 Kg, 7 Kg" });
  assert.equal(akbarSsrBaggage(dup, { carriers: ["6E"], index: "6E|1" }).status, "UNKNOWN");    // two adult allowances: not reliable
});

test("request: the search TUI and the journey's own Index, free SSR only, Amount 0", () => {
  assert.deepEqual(ssrBody({ tui: "TUI-1", orderId: 1, index: "6E|2" }, "CID", false),
    { ClientID: "CID", PaidSSR: false, Source: "LV", Trips: [{ TUI: "TUI-1", Amount: 0, OrderID: 1, Index: "6E|2" }] });
  assert.equal(ssrBody({ tui: "TUI-1", orderId: 1, index: "6E|2" }, "CID", false, "CF").Source, "CF");
  assert.equal(ssrBody({ tui: "TUI-1", orderId: 1 }, "CID", false).Trips[0].Index, "");   // booking run: unchanged
});

// ── The service: limits, cache, safety ───────────────────────────────────────────

function memoryKv() {
  const store = new Map<string, string>();
  return { store, get: async (k: string, t?: string) => { const v = store.get(k) ?? null; return v && t === "json" ? JSON.parse(v) : v; }, put: async (k: string, v: string) => { store.set(k, v); }, delete: async (k: string) => { store.delete(k); } };
}
const fare = (index: string, over: Record<string, unknown> = {}) => ({
  id: `AK|TUI-1|${index}`, supplier: "AKBAR", airline: "6E", airlineName: "IndiGo", flightNumber: "153", origin: "CCJ", destination: "BLR",
  departureTime: "2026-12-20T06:00:00", arrivalTime: "2026-12-20T07:05:00", duration: 65, stops: 0, stopDetails: [], cabinClass: "ECONOMY",
  baseFare: 8243, taxes: 0, totalFare: 8243, currency: "INR", isRefundable: false, fareClass: "R", fareIdentifier: index === "6E|1" ? "SAVER" : "FLEXI PLUS FARE",
  baggage: { checked: "", cabin: "", checkedStatus: "UNKNOWN", cabinStatus: "UNKNOWN" },
  raw: { tui: "TUI-1", index, orderId: null, provider: "6E", carriers: ["6E"] }, ...over,
});
function env(fares: any[]) {
  const FARE_CACHE_KV = memoryKv();
  FARE_CACHE_KV.store.set(`offline_fares:${T}:TUI-1`, JSON.stringify({ pax: { adults: 1, children: 0, infants: 0 }, fares: Object.fromEntries(fares.map((f) => [f.id, f])) }));
  return { FARE_CACHE_KV, TENANT_CACHE_KV: memoryKv() } as any;
}
const PAX = { adults: 1, children: 0, infants: 0 };
const ON: SearchBaggageSettings = { ...DEFAULT_SEARCH_BAGGAGE, enabled: true };
function deps(answer: (t: any) => unknown = () => S.indigoDirect, budget = 1000) {
  const calls: any[] = [];
  let used = 0, live = 0, peak = 0;
  return {
    calls, peak: () => peak,
    d: {
      allow: async () => ++used <= budget,
      ssr: async (t: any) => { calls.push(t); live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return answer(t); },
    },
  };
}

test("each fare is asked with its own TUI + Index; OrderID 1 when the search gave none", async () => {
  const e = env([fare("6E|1"), fare("6E|2")]);
  const x = deps();
  const out = await searchBaggage(e, null as any, T, ["AK|TUI-1|6E|1", "AK|TUI-1|6E|2"], PAX, ON, x.d);
  assert.deepEqual(x.calls, [{ tui: "TUI-1", orderId: 1, index: "6E|1" }, { tui: "TUI-1", orderId: 1, index: "6E|2" }]);
  assert.equal(out["AK|TUI-1|6E|1"].status, "CONFIRMED");
  assert.deepEqual(out["AK|TUI-1|6E|1"].baggage, { checked: "15 kg", cabin: "7 kg", checkedStatus: "INCLUDED", cabinStatus: "INCLUDED" });
});

test("not asked: search already confirmed, unknown / expired fares, other suppliers; at most maxPerRequest", async () => {
  const confirmed = fare("6E|3", { baggage: { checked: "25 kg", cabin: "7 kg", checkedStatus: "INCLUDED", cabinStatus: "INCLUDED" } });
  const e = env([fare("6E|1"), confirmed]);
  const x = deps();
  const ids = ["AK|TUI-1|6E|3", "AK|TUI-1|gone", "TJ-123", ...Array.from({ length: 10 }, (_, i) => `AK|TUI-1|6E|${100 + i}`)];
  const out = await searchBaggage(e, null as any, T, ids, PAX, { ...ON, maxPerRequest: 6 }, x.d);
  assert.equal(out["AK|TUI-1|6E|3"].status, "SEARCH");
  assert.equal(out["AK|TUI-1|gone"].status, "EXPIRED");
  assert.equal(out["TJ-123"].status, "INVALID");
  assert.equal(Object.keys(out).length, 6);                  // the rest were not looked at
  assert.equal(x.calls.length, 0);
});

test("cache: the same fare is never asked twice; a confirmed allowance is reused for the same fare product only", async () => {
  const e = env([fare("6E|1"), fare("6E|2")]);
  const x = deps();
  await searchBaggage(e, null as any, T, ["AK|TUI-1|6E|1"], PAX, ON, x.d);
  const again = await searchBaggage(e, null as any, T, ["AK|TUI-1|6E|1"], PAX, ON, x.d);
  assert.equal(x.calls.length, 1);
  assert.equal(again["AK|TUI-1|6E|1"].source, "CACHE");
  // A new search (new TUI) for the same flight + fare type reuses it; the Flexi option of that flight does not.
  const e2 = e;   // same KV, a later search
  e2.FARE_CACHE_KV.store.set(`offline_fares:${T}:TUI-2`, JSON.stringify({ pax: PAX, fares: {
    "AK|TUI-2|6E|1": { ...fare("6E|1"), id: "AK|TUI-2|6E|1", raw: { ...fare("6E|1").raw, tui: "TUI-2" } },
    "AK|TUI-2|6E|2": { ...fare("6E|2"), id: "AK|TUI-2|6E|2", raw: { ...fare("6E|2").raw, tui: "TUI-2" } },
  } }));
  const later = await searchBaggage(e2, null as any, T, ["AK|TUI-2|6E|1", "AK|TUI-2|6E|2"], PAX, ON, x.d);
  assert.equal(later["AK|TUI-2|6E|1"].source, "CACHE");
  assert.equal(x.calls.length, 2);                            // only the Flexi option was asked
  assert.equal(x.calls[1].index, "6E|2");
  // The product key covers flight, times, fare type, class, cabin and passenger types — never the price.
  const k = (o: Record<string, unknown>) => productKeyParts(fare("6E|1", o) as any, PAX).join("|");
  assert.notEqual(k({ departureTime: "2026-12-21T06:00:00" }), k({}));
  assert.notEqual(k({ fareClass: "S" }), k({}));
  assert.equal(k({ totalFare: 9999 }), k({}));
  assert.notEqual(productKeyParts(fare("6E|1") as any, { adults: 1, children: 0, infants: 1 }).join("|"), k({}));
});

test("the minute limit and concurrency are respected; over the limit → BUSY, not queued", async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `6E|${i + 1}`);
  const e = env(ids.map((i) => fare(i, { flightNumber: `15${i}` })));
  const x = deps(() => S.indigoDirect, 3);
  const out = await searchBaggage(e, null as any, T, ids.map((i) => `AK|TUI-1|${i}`), PAX, { ...ON, concurrency: 2 }, x.d);
  assert.equal(x.calls.length, 3);
  assert.equal(Object.values(out).filter((r) => r.status === "BUSY").length, 3);
  assert.ok(x.peak() <= 2);
});

test("SSR failures and unusable answers give UNKNOWN (and are not asked again for that search)", async () => {
  const e = env([fare("6E|1"), fare("6E|2")]);
  const x = deps((t) => { if (t.index === "6E|1") throw new Error("timeout"); return S.storeExpired; });
  const out = await searchBaggage(e, null as any, T, ["AK|TUI-1|6E|1", "AK|TUI-1|6E|2"], PAX, ON, x.d);
  assert.deepEqual([out["AK|TUI-1|6E|1"].status, out["AK|TUI-1|6E|2"].status], ["UNKNOWN", "UNKNOWN"]);
  await searchBaggage(e, null as any, T, ["AK|TUI-1|6E|1", "AK|TUI-1|6E|2"], PAX, ON, x.d);
  assert.equal(x.calls.length, 2);
  // Unknown answers are never stored under the fare product.
  assert.ok(![...e.FARE_CACHE_KV.store.keys()].some((k) => k.startsWith("ssrbag:p:")));
});

test("AKB-SPCL fares and special-return halves are asked like any other fare (own Index and OrderID)", async () => {
  const spcl = fare("SP1|7", { airline: "6E", fareIdentifier: "AKB-SPCL", raw: { tui: "TUI-1", index: "SP1|7", orderId: 2, provider: "SP1", carriers: ["6E"] } });
  const e = env([spcl]);
  const x = deps();
  const out = await searchBaggage(e, null as any, T, [spcl.id], PAX, ON, x.d);
  assert.deepEqual(x.calls[0], { tui: "TUI-1", orderId: 2, index: "SP1|7" });
  assert.equal(out[spcl.id].status, "CONFIRMED");
});

// ── Routes ───────────────────────────────────────────────────────────────────────

test("OFF by default: the page gets enabled:false and nothing is sent to Akbar", async () => {
  const app = new Hono<any>();
  app.use("*", async (c, next) => { c.set("tenantId", T); c.set("db", null); await next(); });
  app.route("/api/fare-baggage", fareBaggageRoutes);
  const e = env([fare("6E|1")]);
  const r = await app.request("/api/fare-baggage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fareIds: ["AK|TUI-1|6E|1"], adults: 1 }) }, e);
  assert.deepEqual(await r.json(), { enabled: false, fares: {} });
  assert.equal((await app.request("/api/fare-baggage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fareIds: Array(11).fill("AK|x|y") }) }, e)).status, 400);
});

test("settings: admins only, values kept within safe limits, audited", async () => {
  const audit: unknown[] = [];
  const app = (role: string) => {
    const a = new Hono<any>();
    a.use("*", async (c, next) => { c.set("tenantId", T); c.set("userRole", role); c.set("userId", "u1"); c.set("db", { insert: () => ({ values: async (v: unknown) => { audit.push(v); } }) }); await next(); });
    a.route("/x", akbarSearchBaggageAdminRoutes);
    return a;
  };
  const e = env([]);
  assert.equal((await app("STAFF").request("/x", {}, e)).status, 403);
  assert.equal((await (await app("SUPER_ADMIN").request("/x", {}, e)).json()).enabled, false);
  const put = await app("SUPER_ADMIN").request("/x", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, perMinute: 5000, concurrency: 50 }) }, e);
  const saved = await put.json();
  assert.equal(saved.enabled, true);
  assert.equal(saved.perMinute, 120);
  assert.equal(saved.concurrency, 4);
  assert.equal(audit.length, 1);
  assert.deepEqual(normalizeSettings({}), { ...DEFAULT_SEARCH_BAGGAGE });
});
