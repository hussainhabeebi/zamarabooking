import test from "node:test";
import assert from "node:assert/strict";
import { journeyLegsMatch } from "../src/routes/book.js";

const leg = (origin: string, destination: string, departureTime: string) => ({ origin, destination, departureTime });

test("Akbar round trip legs must go out and come back, in order", () => {
  assert.equal(journeyLegsMatch([leg("BOM", "DEL", "2026-12-01T06:00"), leg("DEL", "BOM", "2026-12-05T06:00")], "ROUNDTRIP"), true);
  assert.equal(journeyLegsMatch([leg("BOM", "DEL", "2026-12-01T06:00"), leg("DEL", "BLR", "2026-12-05T06:00")], "ROUNDTRIP"), false);
  assert.equal(journeyLegsMatch([leg("BOM", "DEL", "2026-12-05T06:00"), leg("DEL", "BOM", "2026-12-01T06:00")], "ROUNDTRIP"), false);
  assert.equal(journeyLegsMatch([leg("BOM", "DEL", "2026-12-01T06:00")], "ROUNDTRIP"), false);
});

test("Akbar multi-city legs must be in travel order", () => {
  const legs = [leg("BOM", "DEL", "2026-12-01T06:00"), leg("DEL", "BLR", "2026-12-04T06:00"), leg("BLR", "BOM", "2026-12-08T06:00")];
  assert.equal(journeyLegsMatch(legs, "MULTICITY"), true);
  assert.equal(journeyLegsMatch([legs[1], legs[0]], "MULTICITY"), false);
});

import { journeyLegsProblem } from "../src/routes/book.js";
import { lookupOfflineFare, rememberOfflineFares } from "../src/lib/flight-sources.js";

function countingKv() {
  const store = new Map<string, string>();
  let puts = 0;
  return {
    store, puts: () => puts,
    async get(k: string, type?: string) { const v = store.get(k) ?? null; return v && type === "json" ? JSON.parse(v) : v; },
    async put(k: string, v: string) { puts++; store.set(k, v); },
  };
}
const akbarFare = (tui: string, i: number, extra: Record<string, unknown> = {}) => ({
  id: `AK|${tui}|6E|${i}`, supplier: "AKBAR", origin: "BOM", destination: "DEL", departureTime: "2026-12-01T06:00:00", arrivalTime: "2026-12-01T08:10:00",
  totalFare: 4000 + i, raw: { tui, index: `6E|${i}` }, ...extra,
}) as any;

test("a round-trip search of ~830 Akbar fares is remembered in one write per leg, and every fare can be booked", async () => {
  const kv = countingKv();
  const env = { FARE_CACHE_KV: kv } as any;
  const onward = Array.from({ length: 379 }, (_, i) => akbarFare("tui-out", i));
  const back = Array.from({ length: 451 }, (_, i) => akbarFare("tui-ret", i, { origin: "DEL", destination: "BOM" }));
  const pax = { adults: 2, children: 1, infants: 0 };
  await rememberOfflineFares(env, "t1", [...onward, ...back], pax);
  assert.equal(kv.puts(), 2);   // was 830 writes, past the Workers per-invocation KV limit
  for (const f of [onward[0], onward[378], back[0], back[450]]) {
    const r = await lookupOfflineFare(env, null as any, "t1", "AKBAR", f.id, pax);
    assert.ok("fare" in r && r.fare.id === f.id && r.fare.totalFare === f.totalFare);
  }
  assert.deepEqual(await lookupOfflineFare(env, null as any, "t1", "AKBAR", "AK|tui-out|6E|999", pax), { reason: "NOT_FOUND" });
  const changed = await lookupOfflineFare(env, null as any, "t1", "AKBAR", onward[0].id, { adults: 1, children: 1, infants: 0 });
  assert.equal("reason" in changed && changed.reason, "PASSENGERS_CHANGED");
});

test("fares remembered one key each before this change can still be booked", async () => {
  const kv = countingKv();
  const f = akbarFare("old", 1);
  kv.store.set(`offline_fare:t1:${f.id}`, JSON.stringify({ fare: f, pax: { adults: 1, children: 0, infants: 0 } }));
  const r = await lookupOfflineFare({ FARE_CACHE_KV: kv } as any, null as any, "t1", "AKBAR", f.id, { adults: 1, children: 0, infants: 0 });
  assert.ok("fare" in r && r.fare.id === f.id);
});

test("same-day round trips are accepted when the return leaves after the outbound lands", () => {
  const out = { origin: "TRV", destination: "BOM", departureTime: "2026-12-01T06:00:00", arrivalTime: "2026-12-01T08:10:00" };
  const ret = (dep: string) => ({ origin: "BOM", destination: "TRV", departureTime: dep, arrivalTime: "2026-12-01T23:00:00" });
  assert.equal(journeyLegsProblem([out, ret("2026-12-01T19:30:00")], "ROUNDTRIP"), null);            // same day, later
  assert.equal(journeyLegsProblem([out, ret("2026-12-05T19:30:00")], "ROUNDTRIP"), null);            // normal round trip
  assert.equal(journeyLegsProblem([out, ret("2026-12-01T07:00:00")], "ROUNDTRIP"), "JOURNEY_TIMES_CONFLICT"); // before outbound lands
  assert.equal(journeyLegsProblem([out, { ...ret("2026-12-01T19:30:00"), destination: "COK" }], "ROUNDTRIP"), "JOURNEY_MISMATCH");
});
