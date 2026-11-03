// Akbar round trips in one search (RT / RS), checked against Akbar's own sample payloads and
// Akbar support's reply (GetSPricer / CreateItinerary / StartPay / GetItineraryStatus /
// RetrieveBooking are the same as for a one-way booking; SmartPricer gets each leg's amount).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AkbarAdapter, AkbarClient,
  akbarRoundTripSearchBody, akbarRoundTripJourneys, akbarSpecialFarePairs, akbarSpecialFareCombinations, akbarSpecialFarePricerBody,
  akbarRoundTripPricerBody, normalizeAkbarRoundTrip, normalizeAkbarSearch,
  type NormalizedFare,
} from "@zamrabooking/suppliers";
import {
  akbarBookingUnits, akbarLegSource, akbarOutcome, runAkbarBooking, AkbarStepError,
  type AkbarBookingState, type AkbarEngineDeps, type AkbarLegSource,
} from "../src/lib/akbar-booking.js";
import { lookupOfflineFare, rememberOfflineFares } from "../src/lib/flight-sources.js";

// The journey page's onward → return pairing (apps/web/app/search/journey/page.tsx, optionsFor / pick).
// Copied here as a predicate; the test below checks the page still has exactly these expressions.
type Pairable = { fareIdentifier?: string; sri?: string; msri?: string[] };
const returnPairs = (onward: Pairable | undefined, f: Pairable): boolean =>
  !onward ? f.fareIdentifier !== "SPECIAL_RETURN"
  : onward.fareIdentifier === "SPECIAL_RETURN" ? f.fareIdentifier === "SPECIAL_RETURN" && !!onward.sri && !!f.msri?.includes(onward.sri)
  : f.fareIdentifier !== "SPECIAL_RETURN";
const returnOptions = <F extends Pairable>(list: F[], onward: Pairable | undefined) => list.filter((f) => returnPairs(onward, f));

test("the journey page still pairs return fares with exactly this rule", () => {
  const page = readFileSync(new URL("../../web/app/search/journey/page.tsx", import.meta.url), "utf8");
  for (const line of [
    `if (!onward) return list.filter((f) => f.fareIdentifier !== "SPECIAL_RETURN");`,
    `if (onward.fareIdentifier === "SPECIAL_RETURN") return list.filter((f) => f.fareIdentifier === "SPECIAL_RETURN" && onward.sri && f.msri?.includes(onward.sri));`,
    `const ok = f.fareIdentifier === "SPECIAL_RETURN" ? r.fareIdentifier === "SPECIAL_RETURN" && !!f.sri && !!r.msri?.includes(f.sri) : r.fareIdentifier !== "SPECIAL_RETURN";`,
    // A journey is booked with one supplier.
    `for (const k of Object.keys(next)) if (next[k].supplier !== f.supplier) delete next[k];`,
  ]) assert.ok(page.includes(line), `journey page changed: ${line}`);
});

const samples = JSON.parse(readFileSync(new URL("./fixtures/akbar-roundtrip-samples.json", import.meta.url), "utf8"));
const { rt, rs } = samples;
const base = { tripType: "ROUNDTRIP" as const, adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY" as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const creds = { utilsUrl: "https://utils.test", flightsUrl: "https://flights.test", merchantId: "300", apiKey: "k", clientId: "bitest", password: "p", agentCode: "", browserKey: "bk", key: "", gatewayUrl: "" };
const token = { token: "jwt", clientId: "SAMPLE-CLIENT-ID" };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ── Requests, field for field as in Akbar's samples ──────────────────────────

test("RT ExpressSearch body matches Akbar's RT sample (apart from the sample's SG airline filter)", () => {
  const body = akbarRoundTripSearchBody({ ...base, origin: "BOM", destination: "DEL", departureDate: "2025-05-22", returnDate: "2025-05-25" } as any, "SAMPLE-CLIENT-ID", "RT");
  const expected = clone(rt.expressSearchRequest);
  expected.Parameters.Airlines = "";   // the sample searched SpiceJet only; Zamra searches every airline
  assert.deepEqual(body, expected);
});

test("RS ExpressSearch body matches Akbar's RS sample", () => {
  const body = akbarRoundTripSearchBody({ ...base, origin: "BOM", destination: "DXB", departureDate: "2026-02-11", returnDate: "2026-03-20" } as any, "SAMPLE-CLIENT-ID", "RS");
  assert.deepEqual(body, rs.expressSearchRequest);
});

test("SmartPricer bodies match Akbar's RT sample (two airlines) and RS sample: each leg's own amount, one TUI", () => {
  const rtTrips = rt.smartPricerRequest.Trips;
  assert.deepEqual(
    akbarRoundTripPricerBody([{ amount: rtTrips[0].Amount, index: rtTrips[0].Index }, { amount: rtTrips[1].Amount, index: rtTrips[1].Index }], rtTrips[0].TUI, "SAMPLE-CLIENT-ID", "RT"),
    rt.smartPricerRequest);
  const rsTrips = rs.smartPricerRequest.Trips;
  assert.deepEqual(
    akbarRoundTripPricerBody([{ amount: rsTrips[0].Amount, index: rsTrips[0].Index }, { amount: rsTrips[1].Amount, index: rsTrips[1].Index }], rsTrips[0].TUI, "SAMPLE-CLIENT-ID", "RS"),
    rs.smartPricerRequest);
  // The first RS sample differs from the latest only in ChannelCode (null vs ""); the latest is followed.
  const [pair] = akbarSpecialFareCombinations(rs.getExpSearchResponse);
  assert.deepEqual(akbarSpecialFarePricerBody(pair, rs.expressSearchResponse.TUI), { ...rs.smartPricerRequestFirst,
    Trips: rs.smartPricerRequestFirst.Trips.map((t: any) => ({ ...t, ChannelCode: "" })) });
});

test("SmartPricer refuses an invalid leg amount, a missing Index or a missing TUI", () => {
  const ok = { amount: 100, index: "SG|1" };
  for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => akbarRoundTripPricerBody([{ ...ok, amount }, ok], "t", "c", "RT"), /amount/);
  }
  assert.throws(() => akbarRoundTripPricerBody([ok, { ...ok, index: "" }], "t", "c", "RT"), /Index/);
  assert.throws(() => akbarRoundTripPricerBody([ok, ok], "", "c", "RT"), /TUI/);
});

// ── Search parsing and pairing ────────────────────────────────────────────────

test("GetExpSearch RT / RS: Trips[0] is the onward list, Trips[1] the return list", () => {
  for (const s of [rt, rs]) {
    const { onward, return: ret } = akbarRoundTripJourneys(s.getExpSearchResponse);
    const [from, to] = [s.expressSearchRequest.Trips[0].From, s.expressSearchRequest.Trips[0].To];
    assert.ok(onward.length && ret.length);
    assert.ok(onward.every((j) => j.From === from && j.To === to));
    assert.ok(ret.every((j) => j.From === to && j.To === from));
  }
});

test("RT fares: one ONWARD and one RETURN fare per journey, ids distinct although Akbar reuses the Index on both sides", () => {
  const fares = normalizeAkbarRoundTrip(rt.getExpSearchResponse, "ECONOMY", "RT");
  const onward = fares.filter((f) => f.tripKey === "ONWARD"), ret = fares.filter((f) => f.tripKey === "RETURN");
  assert.equal(onward.length, 3); assert.equal(ret.length, 3);
  assert.equal((onward[0].raw as any).index, (ret[0].raw as any).index);   // "SG|1" on both sides in the sample
  assert.equal(new Set(fares.map((f) => f.id)).size, fares.length);
  assert.ok(onward.every((f) => f.origin === "BOM" && f.destination === "DEL" && (f.raw as any).orderId === 1 && (f.raw as any).fareType === "RT"));
  assert.ok(ret.every((f) => f.origin === "DEL" && f.destination === "BOM" && (f.raw as any).orderId === 2));
  // Each leg's own searched NetFare, untouched.
  const journeys = akbarRoundTripJourneys(rt.getExpSearchResponse);
  assert.deepEqual(onward.map((f) => f.totalFare), journeys.onward.map((j) => j.NetFare));
  assert.deepEqual(ret.map((f) => f.totalFare), journeys.return.map((j) => j.NetFare));
  assert.ok(fares.every((f) => f.fareIdentifier !== "SPECIAL_RETURN"));
});

test("RS fares: SPECIAL_RETURN halves linked by sri / msri to their one partner", () => {
  const fares = normalizeAkbarRoundTrip(rs.getExpSearchResponse, "ECONOMY", "RS");
  const onward = fares.filter((f) => f.tripKey === "ONWARD"), ret = fares.filter((f) => f.tripKey === "RETURN");
  assert.equal(onward.length, 3); assert.equal(ret.length, 3);
  assert.ok(fares.every((f) => f.fareIdentifier === "SPECIAL_RETURN"));
  for (const o of onward) {
    const partners = returnOptions(ret, o);
    assert.equal(partners.length, 1);
    assert.equal((partners[0].raw as any).returnIdentifier, (o.raw as any).returnIdentifier);
  }
});

test("Special Fare pairing rule: ReturnIdentifier > 0 and equal, same VAC, same Provider; Index may differ", () => {
  const { onward, return: ret } = akbarRoundTripJourneys(rs.getExpSearchResponse);
  const o = onward[0], r = ret.find((j) => j.ReturnIdentifier === o.ReturnIdentifier)!;
  assert.equal(akbarSpecialFarePairs(o, r), true);
  assert.equal(akbarSpecialFarePairs(o, { ...r, Index: "SG|9" }), true);
  assert.equal(akbarSpecialFarePairs(o, { ...r, ReturnIdentifier: 2002 }), false);
  assert.equal(akbarSpecialFarePairs(o, { ...r, VAC: "6E" }), false);
  assert.equal(akbarSpecialFarePairs(o, { ...r, Provider: "AM" }), false);
  assert.equal(akbarSpecialFarePairs({ ...o, ReturnIdentifier: 0 }, { ...r, ReturnIdentifier: 0 }), false);
  assert.equal(akbarSpecialFarePairs({ ...o, ReturnIdentifier: -1 }, { ...r, ReturnIdentifier: -1 }), false);
  assert.deepEqual(akbarSpecialFareCombinations(rt.getExpSearchResponse), []);
});

test("search parsing drops RS halves without a valid partner, and fares with no Index or no positive amount", () => {
  const data = clone(rs.getExpSearchResponse);
  const [o0, o1, o2] = data.Trips[0].Journey;
  const back = (rid: number) => data.Trips[1].Journey.find((j: any) => j.ReturnIdentifier === rid);
  back(o0.ReturnIdentifier).VAC = "6E";          // pair 1: VAC differs
  back(o1.ReturnIdentifier).Provider = "AM";     // pair 2: Provider differs
  o2.NetFare = 0;                                // pair 3: onward has no amount
  assert.deepEqual(normalizeAkbarRoundTrip(data, "ECONOMY", "RS"), []);
  const rtData = clone(rt.getExpSearchResponse);
  rtData.Trips[0].Journey[0].Index = "";
  rtData.Trips[1].Journey[0].NetFare = -1;
  rtData.Trips[1].Journey[1].ReturnIdentifier = 7;   // not a normal RT fare
  const fares = normalizeAkbarRoundTrip(rtData, "ECONOMY", "RT");
  assert.equal(fares.filter((f) => f.tripKey === "ONWARD").length, 2);
  assert.equal(fares.filter((f) => f.tripKey === "RETURN").length, 1);
});

test("Special Fare SmartPricer rejects missing pricing data instead of sending malformed requests", () => {
  const [pair] = akbarSpecialFareCombinations(rs.getExpSearchResponse);
  assert.throws(() => akbarSpecialFarePricerBody(pair, "", ""), /search TUI/);
  for (const amount of [undefined, null, "invalid", 0, -1]) {
    assert.throws(
      () => akbarSpecialFarePricerBody({ onward: { ...pair.onward, NetFare: amount }, return: pair.return }, "test-tui", ""),
      /positive NetFare/,
    );
  }
  assert.throws(
    () => akbarSpecialFarePricerBody({ onward: pair.onward, return: { ...pair.return, Index: "" } }, "test-tui", ""),
    /Index/,
  );
});

test("today's one-way parser never sells half of a Special Fare", () => {
  assert.deepEqual(normalizeAkbarSearch(rs.getExpSearchResponse, "ECONOMY"), []);
});

// ── Booking units and pricing validation ──────────────────────────────────────

const src = (over: Partial<AkbarLegSource> = {}): AkbarLegSource => ({ tui: "T", index: "SG|2001", orderId: 1, netFare: 4863, fareType: "RS", side: "ONWARD", returnIdentifier: 2001, vac: "SG", provider: "SG", ...over });
const back = (over: Partial<AkbarLegSource> = {}) => src({ index: "SG|2001", orderId: 2, netFare: 5120, side: "RETURN", ...over });
const invalid = (legs: AkbarLegSource[], why: RegExp) => assert.throws(() => akbarBookingUnits(legs), (e: unknown) => e instanceof AkbarStepError && e.code === "ROUNDTRIP_PAIR_INVALID" && why.test(e.message));

test("one-way legs (and round trips searched one way at a time) stay separate itineraries, unchanged", () => {
  const on = [{ tui: "a", index: "6E|1", orderId: 1, netFare: 4000, carriers: ["6E"], origin: "BOM", destination: "DEL" },
              { tui: "b", index: "6E|4", orderId: 1, netFare: 4200, carriers: ["6E"], origin: "DEL", destination: "BOM" }];
  assert.deepEqual(akbarBookingUnits(on), on);
  // akbarLegSource of a one-way fare has no round-trip markers.
  const s = akbarLegSource({ tui: "a", index: "6E|1", orderId: 1, netFare: 4000 }, { airline: "6E", origin: "BOM", destination: "DEL" });
  assert.equal(s.fareType, undefined);
  assert.deepEqual(akbarBookingUnits([s]), [{ tui: "a", index: "6E|1", orderId: 1, netFare: 4000, carriers: ["6E"], origin: "BOM", destination: "DEL" }]);
});

test("RS / RT pair → one itinerary priced at the sum of the legs' own amounts (never counted twice)", () => {
  const [u, ...more] = akbarBookingUnits([src(), back()]);
  assert.equal(more.length, 0);
  assert.equal(u.netFare, 4863 + 5120);
  assert.deepEqual(u.roundTrip, { fareType: "RS", legs: [{ amount: 4863, index: "SG|2001" }, { amount: 5120, index: "SG|2001" }] });
  // Normal RT may combine airlines / providers (Akbar's RT sample: 6E onward, SG return).
  const [rtUnit] = akbarBookingUnits([
    src({ fareType: "RT", returnIdentifier: 0, index: "6E|111", netFare: 7072, vac: "6E", provider: "6E" }),
    back({ fareType: "RT", returnIdentifier: 0, index: "SG|1", netFare: 3491, vac: "SG", provider: "SG" }),
  ]);
  assert.equal(rtUnit.netFare, 10563);
});

test("invalid round-trip selections are refused before any supplier call", () => {
  invalid([src(), back({ returnIdentifier: 2002 })], /ReturnIdentifier/);
  invalid([src({ returnIdentifier: 0 }), back({ returnIdentifier: 0 })], /ReturnIdentifier/);
  invalid([src(), back({ vac: "6E" })], /VAC/);
  invalid([src(), back({ provider: "AM" })], /Provider/);
  invalid([src(), back({ index: "" })], /Index/);
  for (const netFare of [0, -1, Number.NaN]) invalid([src(), back({ netFare })], /amount/);
  invalid([src(), back({ tui: "OTHER" })], /same search/);
  invalid([back(), src()], /onward flight must come first/);
  invalid([src()], /exactly one onward and one return/);
  invalid([src(), back(), back()], /exactly one onward and one return/);
  invalid([src(), back({ fareType: "RT" })], /same round-trip fare type/);
  invalid([src(), { tui: "T", index: "SG|1", orderId: 1, netFare: 5000 }], /same round-trip fare type/);   // RS half + a one-way fare
  invalid([src({ fareType: "RT", returnIdentifier: 0 }), back({ fareType: "RT", returnIdentifier: 3 })], /ReturnIdentifier 0/);
});

// ── Mocked end to end: search → selection → checkout → booking status ────────

function akbarUat(opts: { pricedNet?: (sum: number) => number; status?: string; pnrs?: string[] } = {}) {
  const calls: { path: string; body: any }[] = [];
  let sum = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    switch (path) {
      case "/flights/ExpressSearch":
        if (body.FareType === "RT") return json(rt.expressSearchResponse);
        if (body.FareType === "RS") return json(rs.expressSearchResponse);
        return json({ TUI: "on-tui", Code: "200", Msg: ["Success"] });
      case "/flights/GetExpSearch":
        if (body.TUI === rt.expressSearchResponse.TUI) return json(rt.getExpSearchResponse);
        if (body.TUI === rs.expressSearchResponse.TUI) return json({ ...rs.getExpSearchResponse, Completed: "True" });
        return json({ TUI: body.TUI, Completed: "True", Trips: [], Code: "200" });
      case "/Utils/WebSettings": return json({ TUI: body.TUI, Code: "200", Msg: ["Success"], Settings: [] });
      case "/flights/SmartPricer":
        sum = body.Trips.reduce((n: number, t: any) => n + t.Amount, 0);
        return json({ TUI: "priced-tui", Code: "200", Msg: ["Success"], NetAmount: 0 });
      case "/flights/GetSPricer": return json({ TUI: "priced-tui", Code: "200", Msg: ["Success"], NetAmount: (opts.pricedNet ?? ((s) => s))(sum) });
      case "/Utils/GetTravelCheckList": return json({ TUI: "x", Code: "200", Msg: ["Success"], TravellerCheckList: "invalid Pricing TUI" });
      case "/flights/SeatLayout": case "/flights/ssr": return json({ TUI: body?.Trips?.[0]?.TUI, Code: "200", Msg: ["Success"] });
      case "/flights/CreateItinerary": return json({ TUI: "it-tui", Code: "200", Msg: ["Success"], TransactionID: 260150001, NetAmount: body.NetAmount });
      case "/Payment/StartPay": return json({ TUI: "pay-tui", Code: "6033", Msg: ["BOOKING  INPROGRESS !"], TransactionID: 260150001 });
      case "/Payment/GetItineraryStatus": return json({ TUI: "s", Code: "200", Msg: ["Success"], CurrentStatus: opts.status ?? "Success", PaymentStatus: "Success" });
      case "/Utils/RetrieveBooking": return json({ Code: "200", Msg: ["Success"], TransactionID: 260150001, Status: opts.status === "Failed" ? "BO1" : "TO0",
        Trips: (opts.pnrs ?? ["RS1ONW", "RS1RET"]).map((p) => ({ Journey: [{ Segments: [{ Flight: { APNR: p, CRSPNR: p, TicketInfo: [{ PaxID: 1, TicketNo: "", Status: "TO0" }] } }] }] })) });
      default: return json({ Code: "404" }, 404);
    }
  }) as typeof fetch;
  return { calls, fetchImpl, paths: () => calls.map((c) => c.path.split("/").pop()) };
}

async function withFetch<T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = saved; }
}

function kv() {
  const store = new Map<string, string>();
  return { async get(k: string, type?: string) { const v = store.get(k) ?? null; return v && type === "json" ? JSON.parse(v) : v; }, async put(k: string, v: string) { store.set(k, v); } };
}

const searchParams = { ...base, origin: "BOM", destination: "DXB", departureDate: "2026-02-11", returnDate: "2026-03-20" } as any;
const adapter = (over: Record<string, unknown> = {}) =>
  new AkbarAdapter({ ...creds, apiBooking: "MANUAL", roundTripFares: "ON", getToken: async () => token, ...over } as any);
const contact = { fName: "Anand", lName: "Kumar", mobile: "9999999999", email: "a@b.in", address: "1 MG Road", city: "KOCHI", state: "Kerala", pin: "682001", countryCode: "IN" };
const pax = [{ type: "ADULT" as const, firstName: "Anand", lastName: "Kumar", gender: "M" as const, dob: "1987-08-27", nationality: "IN", passportNumber: "P1", passportExpiry: "2030-01-01", passportCountry: "IN" }];
function deps(fetchImpl: typeof fetch) {
  const saves: AkbarBookingState[] = [];
  const d: AkbarEngineDeps = { client: new AkbarClient(creds as any, fetchImpl), token: async () => token, sleep: async () => {},
    save: async (s) => { saves.push(clone(s)); }, log: () => {} };
  return { d, saves };
}

async function searchAndSelect(kind: "RT" | "RS") {
  const uat = akbarUat();
  const fares: NormalizedFare[] = await withFetch(uat.fetchImpl, () => adapter().search(searchParams));
  const ofType = fares.filter((f) => (f.raw as any).fareType === kind);
  const onward = ofType.find((f) => f.tripKey === "ONWARD")!;
  const choices = returnOptions(fares.filter((f) => f.tripKey === "RETURN"), onward);
  return { fares, onward, ret: choices[0], choices, uat };
}

test("e2e: API booking + round-trip fares on → one RT and one RS search; Special Fare return list is the partner only", async () => {
  const { fares, onward, choices, uat } = await searchAndSelect("RS");
  const express = uat.calls.filter((c) => c.path === "/flights/ExpressSearch").map((c) => c.body.FareType).sort();
  assert.deepEqual(express, ["RS", "RT"]);
  assert.equal(new Set(fares.map((f) => f.id)).size, fares.length);
  assert.equal(choices.length, 1);
  assert.equal((choices[0].raw as any).returnIdentifier, (onward.raw as any).returnIdentifier);
  // A normal RT onward never offers RS halves, and vice versa.
  const rtOnward = fares.find((f) => (f.raw as any).fareType === "RT" && f.tripKey === "ONWARD")!;
  const rtChoices = returnOptions(fares.filter((f) => f.tripKey === "RETURN"), rtOnward);
  assert.ok(rtChoices.length === 3 && rtChoices.every((f) => (f.raw as any).fareType === "RT"));
  assert.equal(returnPairs(onward, rtChoices[0]), false);
});

test("e2e: round-trip fares off (default) or API booking off → round trips searched one way at a time, as before", async () => {
  for (const over of [{ roundTripFares: "OFF" }, { apiBooking: "OFF" }]) {
    const uat = akbarUat();
    await withFetch(uat.fetchImpl, () => adapter(over).search(searchParams));
    const express = uat.calls.filter((c) => c.path === "/flights/ExpressSearch").map((c) => c.body.FareType);
    assert.deepEqual(express, ["ON", "ON"]);
  }
});

for (const kind of ["RS", "RT"] as const) {
  test(`e2e ${kind}: checkout keeps both legs, then ONE SmartPricer / CreateItinerary / StartPay for the combined amount → TICKETED`, async () => {
    const { onward, ret } = await searchAndSelect(kind);
    // Checkout: fares remembered at search time and looked up by id (both halves survive).
    const env = { FARE_CACHE_KV: kv() } as any;
    await rememberOfflineFares(env, "t1", [onward, ret], { adults: 1, children: 0, infants: 0 });
    const looked = await Promise.all([onward, ret].map((f) => lookupOfflineFare(env, null as any, "t1", "AKBAR", f.id, { adults: 1, children: 0, infants: 0 })));
    const legs = looked.map((r) => { assert.ok("fare" in r); return r.fare; });
    assert.deepEqual(legs.map((f) => f.id), [onward.id, ret.id]);
    const supplierAmount = legs.reduce((n, f) => n + f.totalFare, 0);   // what POST /api/book charges the supplier side
    const units = akbarBookingUnits(legs.map((f) => akbarLegSource(f.raw as any, f)));
    assert.equal(units.length, 1);
    assert.equal(units[0].netFare, supplierAmount);

    const uat = akbarUat();
    const { d } = deps(uat.fetchImpl);
    const state = await runAkbarBooking(d, { legs: units, pax, departureDates: ["2026-02-11", "2026-03-20"], contact, lookups: true });
    const sp = uat.calls.filter((c) => c.path === "/flights/SmartPricer");
    assert.equal(sp.length, 1);
    assert.deepEqual(sp[0].body, akbarRoundTripPricerBody(
      [{ amount: onward.totalFare, index: (onward.raw as any).index }, { amount: ret.totalFare, index: (ret.raw as any).index }],
      (onward.raw as any).tui, token.clientId, kind));
    const ci = uat.calls.filter((c) => c.path === "/flights/CreateItinerary");
    const pay = uat.calls.filter((c) => c.path === "/Payment/StartPay");
    assert.equal(ci.length, 1); assert.equal(pay.length, 1);
    assert.equal(ci[0].body.NetAmount, supplierAmount);
    assert.equal(pay[0].body.NetAmount, supplierAmount);   // paid once, not per leg
    assert.equal(akbarOutcome(state, units.length), "TICKETED");
    assert.deepEqual(state.legs[0].pnrs, ["RS1ONW", "RS1RET"]);
    // SeatLayout / SSR for both legs of the itinerary (OrderID 1 and 2).
    assert.deepEqual(uat.calls.filter((c) => c.path === "/flights/SeatLayout").map((c) => c.body.Trips[0].OrderID), [1, 2]);
  });
}

test("e2e: a priced total above the two legs' amounts stops before CreateItinerary / StartPay", async () => {
  const { onward, ret } = await searchAndSelect("RS");
  const units = akbarBookingUnits([onward, ret].map((f) => akbarLegSource(f.raw as any, f)));
  const uat = akbarUat({ pricedNet: (s) => s + 500 });
  const state = await runAkbarBooking(deps(uat.fetchImpl).d, { legs: units, pax, departureDates: ["2026-02-11"], contact });
  assert.equal(state.legs[0].state, "FAILED");
  assert.equal(state.legs[0].errorCode, "FARE_INCREASED");
  assert.ok(!uat.paths().includes("CreateItinerary") && !uat.paths().includes("StartPay"));
  assert.equal(akbarOutcome(state, units.length), "FAILED_BEFORE_PAYMENT");
});

test("e2e: Akbar reports the round trip Failed after StartPay → FAILED, never TICKETED, StartPay not resent", async () => {
  const { onward, ret } = await searchAndSelect("RT");
  const units = akbarBookingUnits([onward, ret].map((f) => akbarLegSource(f.raw as any, f)));
  const uat = akbarUat({ status: "Failed", pnrs: [] });
  const { d } = deps(uat.fetchImpl);
  const state = await runAkbarBooking(d, { legs: units, pax, departureDates: ["2026-02-11"], contact });
  assert.equal(akbarOutcome(state, units.length), "FAILED");
  const again = await runAkbarBooking(d, { legs: units, pax, departureDates: ["2026-02-11"], contact, state });
  assert.equal(uat.paths().filter((p) => p === "StartPay").length, 1);
  assert.notEqual(akbarOutcome(again, units.length), "TICKETED");
});
