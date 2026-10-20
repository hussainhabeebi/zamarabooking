import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_RATES_KEY, effectiveRates, getFx, refreshAutoRates, toInrPer, type AutoRates } from "../src/lib/fx.js";

function memoryKv(init: Record<string, string> = {}) {
  const store = new Map(Object.entries(init));
  return { store, async get(k: string) { return store.get(k) ?? null; }, async put(k: string, v: string) { store.set(k, v); } };
}

// Units per 1 INR, close to real market rates.
const PER_INR = { AED: 0.04405, SAR: 0.04498, QAR: 0.04366, OMR: 0.004613, KWD: 0.003671, BHD: 0.004521, USD: 0.01199, EUR: 0.0103 };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });

test("feed rates become checked INR-per-unit rates", () => {
  const r = toInrPer(PER_INR)!;
  assert.equal(r.AED, 22.7015);
  assert.equal(r.KWD, 272.4053);
  assert.equal(Object.keys(r).length, 7);
  assert.equal(toInrPer({ ...PER_INR, SAR: 0 }), null);                // missing / broken
  assert.equal(toInrPer({ ...PER_INR, AED: 0.5 }), null);              // 2 INR per AED: implausible
  const prev: AutoRates = { inrPer: { ...r, AED: 18 }, source: "x", fetchedAt: new Date().toISOString() };
  assert.equal(toInrPer(PER_INR, prev), null);                         // >10% jump vs last rates
});

test("refresh falls through to the next feed and stores the rates", async () => {
  const kv = memoryKv();
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    if (url.includes("open.er-api")) return json({ result: "error" });
    return json({ date: "2026-10-03", inr: Object.fromEntries(Object.entries(PER_INR).map(([k, v]) => [k.toLowerCase(), v])) });
  }) as any;
  const r = await refreshAutoRates({ TENANT_CACHE_KV: kv }, fakeFetch, Date.parse("2026-10-03T00:00:00Z"));
  assert.equal(r.ok, true);
  assert.equal(urls.length, 2);
  const stored = JSON.parse(kv.store.get(AUTO_RATES_KEY)!);
  assert.equal(stored.source, "fawazahmed0/currency-api");
  assert.equal(stored.inrPer.QAR, 22.9043);
});

test("automatic rates win; margin applied; manual rates are the fallback", () => {
  const now = Date.parse("2026-10-03T00:00:00Z");
  const auto: AutoRates = { inrPer: toInrPer(PER_INR)!, source: "x", fetchedAt: new Date(now - 3600_000).toISOString() };
  const auto2 = effectiveRates({ mode: "auto", marginPct: 0, manual: { AED: 23.5 } }, auto, now);
  assert.equal(auto2.rates.AED, 22.7015);
  assert.equal(auto2.sources.AED, "auto");
  const withMargin = effectiveRates({ mode: "auto", marginPct: 2, manual: {} }, auto, now);
  assert.equal(withMargin.rates.AED, 22.2564);                         // 22.7015 / 1.02
  const stale = effectiveRates({ mode: "auto", marginPct: 0, manual: { AED: 23.5 } }, { ...auto, fetchedAt: "2026-09-01T00:00:00Z" }, now);
  assert.equal(stale.rates.AED, 23.5);
  assert.equal(stale.sources.AED, "manual");
  assert.equal(stale.rates.SAR, null);                                 // nothing usable → not offered
  const manual = effectiveRates({ mode: "manual", marginPct: 0, manual: { AED: 23.5 } }, auto, now);
  assert.equal(manual.rates.AED, 23.5);
  assert.equal(manual.rates.SAR, 22.2321);                             // no manual SAR → automatic
});

test("the earlier Nomod AED rate stays as the AED fallback", async () => {
  const kv = memoryKv({ "admin_settings:t1:payments": JSON.stringify({ nomod: { aedRate: 23.1 } }) });
  const fx = await getFx({ TENANT_CACHE_KV: kv }, "t1");
  assert.equal(fx.mode, "auto");
  assert.equal(fx.rates.AED, 23.1);
  assert.equal(fx.sources.AED, "manual");
  assert.equal(fx.rates.USD, null);
});
