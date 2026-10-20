import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { TripjackClient } from "@poomas/suppliers";
import {
  cheapestPerAdult, createAlert, getAlert, observable, readCalendar, recordFareObservation, shouldNotify, type FareAlert,
} from "../src/lib/fare-insights.js";
import { fallbackHoldDeadline, findHoldDeadline } from "../src/lib/fare-hold.js";
import { applyReferral, referralCode, ReferralError } from "../src/lib/referral.js";
import { markupAmount, withAgentMarkup } from "../src/lib/agent-markup.js";
import { fareRoutes } from "../src/routes/fares.js";

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, type?: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: "" };
    },
  } as any;
}

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const search = (date: string, extra: Record<string, unknown> = {}) => ({
  origin: "COK", destination: "DXB", departureDate: date, tripType: "ONEWAY", cabinClass: "ECONOMY",
  adults: 2, currency: "INR", ...extra,
});

test("price per adult uses perAdultFare share and markup", () => {
  // Two adults: total 20,000 (10,000 each), shown with markup at 21,000.
  assert.equal(cheapestPerAdult([{ totalFare: 20000, perAdultFare: 10000, displayPrice: 21000 }], 2), 10500);
  // Without perAdultFare: split evenly by adults.
  assert.equal(cheapestPerAdult([{ totalFare: 30000 }, { totalFare: 24000 }], 3), 8000);
  assert.equal(cheapestPerAdult([], 1), null);
});

test("only plain economy one-way searches feed the calendar", () => {
  assert.equal(observable(search("2030-01-01")), true);
  assert.equal(observable(search("2030-01-01", { tripType: "ROUNDTRIP" })), false);
  assert.equal(observable(search("2030-01-01", { cabinClass: "BUSINESS" })), false);
  assert.equal(observable(search("2030-01-01", { fareType: "STUDENT" })), false);
  assert.equal(observable(search("2030-01-01", { legs: [{}, {}] })), false);
});

test("searches build the price calendar and trigger matching alerts", async () => {
  const kv = memoryKv();
  const date = future(20);
  const alert = await createAlert(kv, {
    tenantId: "t1", origin: "COK", destination: "DXB", date, currency: "INR", targetPrice: 9000, email: "a@b.co", phone: null,
  });
  assert.notEqual(alert, "ROUTE_FULL");

  // 9,500 per adult — above the target: recorded, no alert.
  let due = await recordFareObservation(kv, "t1", search(date), [{ totalFare: 19000, perAdultFare: 9500 }]);
  assert.equal(due.length, 0);
  let cal = await readCalendar(kv, "t1", "COK", "DXB", date.slice(0, 7), "INR");
  assert.deepEqual(cal.map((d) => [d.date, d.price]), [[date, 9500]]);

  // Drops to 8,800: the alert is due.
  due = await recordFareObservation(kv, "t1", search(date), [{ totalFare: 17600, perAdultFare: 8800 }]);
  assert.equal(due.length, 1);
  assert.equal(due[0].price, 8800);
  cal = await readCalendar(kv, "t1", "COK", "DXB", date.slice(0, 7), "INR");
  assert.equal(cal[0].price, 8800);

  // Other currencies and tenants are separate.
  assert.equal((await readCalendar(kv, "t1", "COK", "DXB", date.slice(0, 7), "AED")).length, 0);
  assert.equal((await readCalendar(kv, "t2", "COK", "DXB", date.slice(0, 7), "INR")).length, 0);
});

test("an alert repeats only on a further 3% drop, at most 3 times", () => {
  const a: FareAlert = { id: "x", tenantId: "t", origin: "COK", destination: "DXB", date: "2030-01-01", currency: "INR",
    targetPrice: 9000, email: null, phone: "+911", createdAt: 0, lastPrice: null, notifications: 0 };
  assert.equal(shouldNotify(a, 9001), false);
  assert.equal(shouldNotify(a, 9000), true);
  assert.equal(shouldNotify({ ...a, lastPrice: 8800, notifications: 1 }, 8700), false);   // only ~1% lower
  assert.equal(shouldNotify({ ...a, lastPrice: 8800, notifications: 1 }, 8500), true);
  assert.equal(shouldNotify({ ...a, lastPrice: 8800, notifications: 3 }, 5000), false);
});

test("fare alert routes: validation, create, calendar and one-click stop", async () => {
  const kv = memoryKv();
  const app = new Hono<any>();
  app.use("*", async (c, next) => { c.set("tenantId", "t1"); await next(); });
  app.route("/api/fares", fareRoutes);
  const env = { FARE_CACHE_KV: kv };
  const ctx = { waitUntil: (p: Promise<unknown>) => { p.catch(() => {}); }, passThroughOnException() {} } as any;
  const post = (body: unknown) => app.fetch(new Request("http://x/api/fares/alerts", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), env, ctx);
  const date = future(30);

  let res = await post({ origin: "COK", destination: "DXB", date, targetPrice: 9000 });
  assert.equal(res.status, 400);
  assert.match((await res.json() as any).error, /email or a WhatsApp/);

  res = await post({ origin: "COK", destination: "DXB", date: "2020-01-01", targetPrice: 9000, email: "a@b.co" });
  assert.equal(res.status, 400);

  res = await post({ origin: "cok", destination: "dxb", date, targetPrice: 9000, phone: "98765 43210" });
  assert.equal(res.status, 201);
  const created = await res.json() as any;
  assert.equal(created.alert.origin, "COK");
  const stored = await getAlert(kv, "t1", created.alert.id);
  assert.equal(stored?.phone, "+919876543210");

  await recordFareObservation(kv, "t1", search(date), [{ totalFare: 16000, perAdultFare: 8000 }]);
  res = await app.fetch(new Request(`http://x/api/fares/calendar?origin=COK&destination=DXB&month=${date.slice(0, 7)}&currency=INR`), env, ctx);
  assert.equal(res.status, 200);
  assert.equal((await res.json() as any).days[0].price, 8000);

  res = await app.fetch(new Request(`http://x/api/fares/alerts/${created.alert.id}/stop`), env, ctx);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /is stopped/);
  assert.equal(await getAlert(kv, "t1", created.alert.id), null);
  assert.equal([...kv.store.keys()].some((k: string) => k.startsWith("falert_route:")), false);
});

test("hold deadline: TripJack time limit when given, short fallback otherwise", () => {
  const now = Date.parse("2030-01-01T10:00:00Z");
  const deadline = findHoldDeadline({ order: { status: "ON_HOLD" }, itemInfos: { AIR: { timeLimit: "2030-01-01T14:30:00Z" } } }, now);
  assert.equal(deadline?.toISOString(), "2030-01-01T14:30:00.000Z");
  assert.equal(findHoldDeadline({ timeLimit: "2029-12-31T00:00:00Z" }, now), null);   // already past
  assert.equal(findHoldDeadline({ fare: 123 }, now), null);
  // 3 hours, but never later than 6 hours before departure.
  assert.equal(fallbackHoldDeadline(new Date("2030-01-05T00:00:00Z"), now).toISOString(), "2030-01-01T13:00:00.000Z");
  assert.equal(fallbackHoldDeadline(new Date("2030-01-01T17:00:00Z"), now).toISOString(), "2030-01-01T11:00:00.000Z");
});

test("TripJack hold books without paymentInfos; confirmHold pays it", async () => {
  const calls: { url: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ bookingId: "TJ1", status: { success: true } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const client = new TripjackClient({ apiKey: "k", baseUrl: "https://tj.example" });
    const params = { fareId: "f", holdId: "TJ1", passengers: [{ type: "ADULT" as const, firstName: "Asha", lastName: "Nair", gender: "F" as const }],
      contactEmail: "a@b.co", contactPhone: "9876543210", paymentRef: "HOLD", paymentAmount: 5000 };
    await client.book({ ...params, holdOnly: true });
    assert.equal(calls[0].url, "https://tj.example/oms/v1/air/book");
    assert.equal("paymentInfos" in calls[0].body, false);
    await client.book(params);
    assert.deepEqual(calls[1].body.paymentInfos, [{ amount: 5000 }]);
    await client.confirmHold("TJ1", 5000);
    assert.equal(calls[2].url, "https://tj.example/oms/v1/air/confirm-book");
    assert.deepEqual(calls[2].body, { bookingId: "TJ1", paymentInfos: [{ amount: 5000 }] });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("referral codes are stable per user and guard against misuse", async () => {
  const a = await referralCode("secret", "t1", "user-a");
  assert.match(a, /^FP[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(await referralCode("secret", "t1", "user-a"), a);
  assert.notEqual(await referralCode("secret", "t1", "user-b"), a);

  const kv = memoryKv();
  const env: any = { JWT_SECRET: "secret", SESSIONS_KV: kv };
  kv.store.set(`ref_code:t1:${a}`, "user-a");
  const db: any = {};   // not reached for these cases
  await assert.rejects(applyReferral(env, db, "t1", "user-a", a), (e: any) => e instanceof ReferralError && /own code/.test(e.message));
  await assert.rejects(applyReferral(env, db, "t1", "user-b", "FPNOPE22"), (e: any) => e instanceof ReferralError && e.status === 404);
  kv.store.set("ref_by:t1:user-b", JSON.stringify({ referrerId: "user-a" }));
  await assert.rejects(applyReferral(env, db, "t1", "user-b", a), (e: any) => e instanceof ReferralError && e.status === 409);
});

test("sub-agent markup: flat or percentage on top of the shown price", () => {
  const m = { type: "PERCENTAGE" as const, value: 5, setBy: "p", updatedAt: "" };
  assert.equal(markupAmount(m, 10000), 500);
  assert.equal(markupAmount({ ...m, type: "FLAT", value: 250 }, 10000), 250);
  const fares = withAgentMarkup([{ totalFare: 9000, displayPrice: 10000 }, { totalFare: 8000 }], m);
  assert.equal(fares[0].displayPrice, 10500);
  assert.equal(fares[0].agentMarkup, 500);
  assert.equal(fares[1].displayPrice, 8400);
  assert.equal(withAgentMarkup([{ totalFare: 1 }], null)[0].displayPrice, undefined);
});

test("TripJack fare rules nested under the route are read with amounts", async () => {
  const { parseTripjackFareRules } = await import("@poomas/suppliers");
  const rules = parseTripjackFareRules({ fareRule: { "AUH-CCJ": { tfr: {
    CANCELLATION: [{ policyInfo: "Cancellation__nls__allowed", amount: 3500, additionalFee: 300, st: 4, et: 8760 }],
    DATECHANGE: [{ amount: 2500 }],
  } } } });
  assert.equal(rules.length, 2);
  assert.equal(rules[0].category, "CANCELLATION");
  assert.match(rules[0].description, /Cancellation allowed — ₹3,500 \+ ₹300 fee · 4–8760 hrs/);
  assert.equal(rules[1].description, "₹2,500");
  assert.deepEqual(parseTripjackFareRules({}), []);
});
