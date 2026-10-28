import test from "node:test";
import assert from "node:assert/strict";
import {
  AkbarAdapter, AkbarClient, akbarDurationMinutes, normalizeAkbarSearch, expressSearchBody, fareRuleBody, flightInfoBody, normalizePoomasOffer, PoomasAdapter, seatLayoutBody, signatureBody, smartPricerBody, ssrBody, startPayBody, retrieveBookingBody, cancelBody,
} from "@zamrabooking/suppliers";
import {
  DEFAULT_AKBAR, getAkbarSettings, getAkbarToken, saveAkbarSettings, isOfflineSupplier, manualFareToNormalized, parseCsv, parseManualFaresCsv, quoteOfflineFare, rememberOfflineFares, sheetCsvUrl,
} from "../src/lib/flight-sources.js";

function memoryKv(init: Record<string, string> = {}) {
  const store = new Map(Object.entries(init));
  return {
    store,
    async get(k: string, type?: string) { const v = store.get(k) ?? null; return v && type === "json" ? JSON.parse(v) : v; },
    async put(k: string, v: string) { store.set(k, v); },
  };
}

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });

const HEADER = "Date,Origin,Destination,Airline,Airline Name,Flight Number,Departure Time,Arrival Time,Arrival Day Offset,Adult Fare,Child Fare,Infant Fare,Currency,Seats,Cabin,Checked Baggage,Refundable,Notes";

test("CSV parser handles quotes, commas and line breaks inside fields", () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n1,"two\nlines",3\n\n'), [["a", "b, c", 'say "hi"'], ["1", "two\nlines", "3"]]);
});

test("sheet rows become manual fares; bad rows are skipped with a reason", () => {
  const csv = [
    HEADER,
    '25/12/2026,cok,DXB,6e,IndiGo,6E 1403,21:30,00:15,1,"14,500",13000,,INR,12,Economy,30 KG,yes,Group fare',
    "2026-12-26,COK,DXB,IX,,IX 435,9:05 PM,11:50 PM,0,780,,,AED,4,economy,,no,",
    "31/02/2026,COK,DXB,6E,,6E 1,10:00,12:00,0,1000,,,INR,9,Economy,,,",
    "26/12/2026,COK,COK,6E,,6E 1,10:00,12:00,0,1000,,,INR,9,Economy,,,",
    "26/12/2026,COK,DXB,6E,,6E 1,10:00,12:00,0,1000,,,XYZ,9,Economy,,,",
  ].join("\n");
  const { rows, skipped, errors } = parseManualFaresCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(skipped, 3);
  assert.match(errors[0], /^Row 4: date "31\/02\/2026"/);
  assert.match(errors[1], /^Row 5: origin and destination are the same/);
  assert.match(errors[2], /^Row 6: currency "XYZ"/);
  assert.deepEqual(
    { ...rows[0] },
    {
      source: "SHEET", travelDate: "2026-12-25", origin: "COK", destination: "DXB", airline: "6E", airlineName: "IndiGo",
      flightNumber: "6E1403", departureTime: "21:30", arrivalTime: "00:15", arrivalDayOffset: 1, durationMinutes: null,
      stops: 0, cabinClass: "ECONOMY", adultFare: "14500", childFare: "13000", infantFare: null, currency: "INR",
      seatsAvailable: 12, checkedBaggage: "30 KG", cabinBaggage: null, isRefundable: true, notes: "Group fare", isActive: true,
    },
  );
  assert.equal(rows[1].departureTime, "21:05");
  assert.equal(rows[1].arrivalTime, "23:50");
  assert.equal(rows[1].currency, "AED");
});

test("a sheet without the required columns is rejected as a whole", () => {
  const r = parseManualFaresCsv("date,origin,destination\n25/12/2026,COK,DXB");
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0], /Missing column\(s\).*airline, flight_number, departure_time, arrival_time, adult_fare/);
});

test("Google Sheets links become CSV export links", () => {
  assert.equal(
    sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbC_d-9/edit#gid=12345"),
    "https://docs.google.com/spreadsheets/d/1AbC_d-9/export?format=csv&gid=12345",
  );
  assert.equal(
    sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbC/edit?usp=sharing"),
    "https://docs.google.com/spreadsheets/d/1AbC/export?format=csv&gid=0",
  );
  const published = "https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv";
  assert.equal(sheetCsvUrl(published), published);
  assert.equal(sheetCsvUrl("http://example.com/fares.csv"), null);
  assert.equal(sheetCsvUrl("not a link"), null);
});

test("manual fare prices the whole party in INR", () => {
  const row = {
    id: "11111111-1111-1111-1111-111111111111", tenantId: "t1", source: "SHEET", travelDate: "2026-12-25",
    origin: "COK", destination: "DXB", airline: "6E", airlineName: "IndiGo", flightNumber: "6E1403",
    departureTime: "21:30", arrivalTime: "00:15", arrivalDayOffset: 1, durationMinutes: null, stops: 0, cabinClass: "ECONOMY",
    adultFare: "500", childFare: null, infantFare: "100", currency: "AED", seatsAvailable: 5,
    checkedBaggage: "30 KG", cabinBaggage: null, isRefundable: false, notes: null, isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const toInr = (amount: number, cur: string) => (cur === "AED" ? amount * 22.7 : cur === "INR" ? amount : null);
  const fare = manualFareToNormalized(row, { adults: 2, children: 1, infants: 1 }, toInr)!;
  assert.equal(fare.supplier, "MANUAL");
  assert.equal(fare.totalFare, (2 * 500 + 500 + 100) * 22.7);   // child pays the adult fare
  assert.equal(fare.perAdultFare, 500 * 22.7);
  assert.equal(fare.currency, "INR");
  assert.equal(fare.departureTime, "2026-12-25T21:30:00");
  assert.equal(fare.arrivalTime, "2026-12-26T00:15:00");
  assert.equal(fare.duration, 165);
  assert.equal(manualFareToNormalized(row, { adults: 1, children: 0, infants: 0 }, () => null), null);   // no exchange rate
});

const OFFER = {
  offerId: "a8d2c4e0-0000-4000-8000-000000000001", supplier: "TRIPJACK", isBookable: true,
  airline: "6E", airlineName: "IndiGo", flightNumber: "6E1403", origin: "COK", destination: "DXB",
  departureTime: "2026-12-25T21:30", arrivalTime: "2026-12-26T00:15", duration: 255, stops: 0, stopDetails: [],
  cabinClass: "ECONOMY", baseFare: 9000, taxes: 3000, totalFare: 12000, displayPrice: 12600, perAdultFare: 12000,
  currency: "INR", isRefundable: false, baggage: { cabin: "7 KG", checked: "30 KG" }, fareClass: "R",
};

test("Poomas offers are priced at what Poomas charges Zamra", () => {
  const f = normalizePoomasOffer(OFFER, "2026-12-01T10:00:00Z");
  assert.equal(f.supplier, "POOMAS");
  assert.equal(f.id, OFFER.offerId);
  assert.equal(f.totalFare, 12600);
  assert.equal(f.baseFare, 9450);
  assert.equal(f.taxes, 3150);
  assert.equal(f.perAdultFare, 12600);
  assert.deepEqual(f.raw, { offerId: OFFER.offerId, expiresAt: "2026-12-01T10:00:00Z", poomasSupplier: "TRIPJACK" });
});

test("Poomas search calls the partner API and keeps bookable one-way offers", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return json({ searchId: "s1", expiresAt: "2026-12-01T10:00:00Z", offers: [OFFER, { ...OFFER, offerId: "x", isBookable: false }, { ...OFFER, offerId: "y", tripKey: "ONWARD" }] });
  });
  const adapter = new PoomasAdapter({ apiKey: "pmsk_test", baseUrl: "https://api.flypoomas.com/" });
  const params = { origin: "COK", destination: "DXB", departureDate: "2026-12-25", adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY", tripType: "ONEWAY", currency: "INR" } as const;
  const fares = await adapter.search(params);
  assert.equal(fares.length, 1);
  assert.equal(calls[0].url, "https://api.flypoomas.com/api/partner/v1/search");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer pmsk_test");
  assert.equal(JSON.parse(String(calls[0].init.body)).tripType, "ONEWAY");
  assert.deepEqual(await adapter.search({ ...params, tripType: "ROUNDTRIP", returnDate: "2026-12-30" }), []);
  assert.equal(calls.length, 1);
});

test("Poomas search errors carry the HTTP status for the supplier logs", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json({ error: "PARTNER_API_KEY_INVALID" }, 401));
  await assert.rejects(
    new PoomasAdapter({ apiKey: "bad" }).search({ origin: "COK", destination: "DXB", departureDate: "2026-12-25", adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY", tripType: "ONEWAY", currency: "INR" }),
    (err: any) => err.statusCode === 401 && /PARTNER_API_KEY_INVALID/.test(err.responseSnippet),
  );
});

test("a Poomas fare is booked at the searched price, for the searched party only", async () => {
  const kv = memoryKv();
  const env = { FARE_CACHE_KV: kv } as any;
  const fare = normalizePoomasOffer(OFFER);
  await rememberOfflineFares(env, "t1", [fare, { ...fare, id: "tj", supplier: "TRIPJACK" }], { adults: 1, children: 0, infants: 0 });
  assert.equal(kv.store.size, 1);
  const quoted = await quoteOfflineFare(env, {} as any, "t1", "POOMAS", fare.id, { adults: 1, children: 0, infants: 0 });
  assert.equal(quoted?.totalFare, 12600);
  assert.equal(await quoteOfflineFare(env, {} as any, "t1", "POOMAS", fare.id, { adults: 2, children: 0, infants: 0 }), null);
  assert.equal(await quoteOfflineFare(env, {} as any, "t2", "POOMAS", fare.id, { adults: 1, children: 0, infants: 0 }), null);
  assert.equal(await quoteOfflineFare(env, {} as any, "t1", "MANUAL", "not-a-uuid", { adults: 1, children: 0, infants: 0 }), null);
});

test("only Poomas and manual fares are ticketed offline", () => {
  assert.equal(isOfflineSupplier("POOMAS"), true);
  assert.equal(isOfflineSupplier("MANUAL"), true);
  assert.equal(isOfflineSupplier("TRIPJACK"), false);
  assert.equal(isOfflineSupplier(null), false);
});

// ── Akbar Travels (Benzy B2B) ────────────────────────────────────────────────

const akbarCreds = {
  utilsUrl: "https://utils.test/", flightsUrl: "https://flights.test", merchantId: "300", apiKey: "k", clientId: "bitest",
  password: "p", agentCode: "", browserKey: "bk", key: "",
};

test("Akbar Signature sends the doc's fields and reads the token", async () => {
  const calls: { url: string; body: any; auth?: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization });
    return json({ Token: "jwt", ClientID: "search-client" });
  }) as unknown as typeof fetch;
  const t = await new AkbarClient(akbarCreds, fetchImpl).signature();
  assert.deepEqual(t, { token: "jwt", clientId: "search-client" });
  assert.equal(calls[0].url, "https://utils.test/Utils/Signature");
  assert.deepEqual(calls[0].body, { MerchantID: "300", ApiKey: "k", ClientID: "bitest", Password: "p", AgentCode: "", BrowserKey: "bk" });
  assert.equal(calls[0].auth, undefined);
  assert.equal(signatureBody({ ...akbarCreds, key: "ef20" }).Key, "ef20");
});

test("Akbar Signature without a token is an error", async () => {
  const fetchImpl = (async () => json({ Code: "401", Msg: ["Invalid"] })) as unknown as typeof fetch;
  await assert.rejects(new AkbarClient(akbarCreds, fetchImpl).signature(), /no token/);
});

test("Akbar ExpressSearch body", () => {
  const body = expressSearchBody({
    origin: "bom", destination: "del", departureDate: "2026-12-01", returnDate: "2026-12-05",
    adults: 2, children: 1, infants: 1, cabinClass: "BUSINESS", tripType: "ROUNDTRIP", currency: "INR",
  }, "cid");
  assert.equal(body.Cabin, "B");
  assert.equal(body.FareType, "RT");
  assert.equal(body.ClientID, "cid");
  assert.deepEqual([body.ADT, body.CHD, body.INF], [2, 1, 1]);
  assert.deepEqual(body.Trips, [{ From: "BOM", To: "DEL", OnwardDate: "2026-12-01", ReturnDate: "2026-12-05", TUI: "" }]);
});

test("Akbar search polls GetExpSearch with the TUI until Completed", async () => {
  const calls: { url: string; body: any; auth: string }[] = [];
  const replies = [{ TUI: "t1", Completed: false }, { TUI: "t1", Completed: "False" }, { TUI: "t1", Completed: true, Trips: [] }];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization });
    return json({ Code: "200", transactionID: 230003656, ...replies.shift() });
  }) as unknown as typeof fetch;
  const r = await new AkbarClient(akbarCreds, fetchImpl).search(
    { origin: "BOM", destination: "DEL", departureDate: "2026-12-01", adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY", tripType: "ONEWAY", currency: "INR" },
    { token: "jwt", clientId: "cid" }, { sleep: async () => {} },
  );
  assert.equal(r.completed, true);
  assert.equal(r.polls, 2);
  assert.equal(calls[0].url, "https://flights.test/flights/ExpressSearch");
  assert.equal(calls[1].url, "https://flights.test/flights/GetExpSearch");
  assert.deepEqual(calls[1].body, { ClientID: "cid", TUI: "t1" });
  assert.ok(calls.every((c) => c.auth === "Bearer jwt"));
});

test("Akbar StartPay body", () => {
  assert.deepEqual(startPayBody({ transactionId: 230003316, netAmount: 2903.68, tui: "t" }, "cid", "bk"), {
    TransactionID: 230003316, PaymentAmount: 0, NetAmount: 2903.68, BrowserKey: "bk", ClientID: "cid", TUI: "t",
    Hold: false, Promo: null, PaymentType: "", BankCode: "",
  });
});

test("Akbar RetrieveBooking and Cancel bodies", () => {
  assert.deepEqual(retrieveBookingBody(200001224, "cid"), { TUI: "", ClientID: "cid", ReferenceNumber: "200001224", ReferenceType: "T", ServiceType: "FLT" });
  assert.deepEqual(cancelBody({ transactionId: 123412, remarks: "Test", trips: [{ crsPnr: "T9DGF24", pax: [{ id: 5024, ticket: "734553687" }] }] }, "cid"), {
    ClientID: "cid", ClientIP: "", Remarks: "Test", TUI: "", TransactionID: 123412,
    Trips: [{ CRSPNR: "T9DGF24", Pax: [{ ID: 5024, Ticket: "734553687" }] }],
  });
});

test("Akbar waits for the itinerary status after StartPay", async () => {
  const calls: any[] = [];
  const replies = [{ CurrentStatus: "InProgress" }, { CurrentStatus: "" }, { CurrentStatus: "Success" }];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return json({ Code: "200", transactionID: 230003656, ...replies.shift() }); }) as unknown as typeof fetch;
  const r = await new AkbarClient(akbarCreds, fetchImpl).waitForItinerary(230003656, "t", { token: "jwt", clientId: "cid" }, { sleep: async () => {} });
  assert.equal(r.status, "Success");
  assert.equal(r.polls, 3);
  assert.equal(calls[0].url, "https://flights.test/Payment/GetItineraryStatus");
  assert.deepEqual(calls[0].body, { TUI: "t", TransactionID: 230003656 });
});

test("Akbar seat layout body", () => {
  assert.deepEqual(seatLayoutBody({ tui: "t", orderId: 1 }, "cid"), { ClientID: "cid", Source: "LV", Trips: [{ TUI: "t", Index: "", OrderID: 1 }] });
});

test("Akbar pricing, fare rule, flight info and SSR bodies", () => {
  const trip = { amount: 20709, index: "1G|1", orderId: 1, tui: "t" };
  assert.deepEqual(smartPricerBody([trip], "cid", "ON"), {
    ClientID: "cid", Trips: [{ Amount: 20709, Index: "1G|1", OrderID: 1, TUI: "t" }], Mode: "SY", Options: "A", Source: "SF", TripType: "ON",
  });
  assert.deepEqual(fareRuleBody([trip], "cid"), { ClientID: "cid", Source: "SF", Trips: [{ Amount: 20709, Index: "1G|1", OrderID: 1, TUI: "t" }] });
  assert.equal(flightInfoBody([trip], "cid", "RT").Trips[0].ChannelCode, null);
  assert.deepEqual(ssrBody({ tui: "t", orderId: 1 }, "cid", true), {
    ClientID: "cid", PaidSSR: true, Source: "LV", Trips: [{ TUI: "t", Amount: 0, OrderID: 1, Index: "" }],
  });
});

test("Akbar token is cached and new credentials drop it", async () => {
  const kv = { ...memoryKv(), async delete(k: string) { kv.store.delete(k); } };
  const env = { TENANT_CACHE_KV: kv } as any;
  let signatures = 0;
  const fetchImpl = (async () => { signatures++; return json({ Token: `jwt${signatures}` }); }) as unknown as typeof fetch;
  const client = new AkbarClient(akbarCreds, fetchImpl);
  assert.equal((await getAkbarToken(env, "t1", client)).token, "jwt1");
  assert.equal((await getAkbarToken(env, "t1", client)).token, "jwt1");
  assert.equal((await getAkbarToken(env, "t1", client, true)).token, "jwt2");
  await saveAkbarSettings(env, "t1", { ...DEFAULT_AKBAR, ...akbarCreds });
  assert.equal((await getAkbarToken(env, "t1", client)).token, "jwt3");
});

test("old Akbar settings fields are dropped", async () => {
  const env = { TENANT_CACHE_KV: memoryKv({ "admin_settings:t1:integration:akbar": JSON.stringify({ enabled: true, username: "u", baseUrl: "x", clientId: "c" }) }) } as any;
  const s = await getAkbarSettings(env, "t1");
  assert.equal(s.clientId, "c");
  assert.equal(s.utilsUrl, DEFAULT_AKBAR.utilsUrl);
  assert.ok(!("username" in s) && !("baseUrl" in s));
});

// ── Akbar in customer search ─────────────────────────────────────────────────

const akbarJourney = {
  Index: "6E|1", Provider: "6E", VAC: "6E", FlightNo: "6E 2101", From: "BOM", To: "DEL",
  DepartureTime: "2026-12-01T06:00:00", ArrivalTime: "2026-12-01T08:10:00", Duration: "02h 10m ", Stops: 0, Seats: 7,
  AirlineName: "IndiGo|IndiGo|IndiGo", NetFare: 4890.5, GrossFare: 5100, Refundable: "Y", Cabin: "E", RBD: "R",
  FCType: "SAVER", Inclusions: { Baggage: "15 Kg", Cabin: "7 Kg" }, Connections: [], OrderID: 1,
};

test("Akbar journey becomes a Zamra fare at Akbar's net fare", () => {
  const fares = normalizeAkbarSearch({ TUI: "tui1", Completed: true, Trips: [{ Journey: [
    akbarJourney,
    { ...akbarJourney, Index: "6E|2", NetFare: 0 },             // no price → dropped
    { ...akbarJourney, Index: "6E|3", ReturnIdentifier: 2 },     // special-return half → dropped
  ] }] }, "ECONOMY");
  assert.equal(fares.length, 1);
  const f = fares[0];
  assert.equal(f.id, "AK|tui1|6E|1");
  assert.equal(f.supplier, "AKBAR");
  assert.equal(f.isBookable, false);
  assert.equal(f.airline, "6E");
  assert.equal(f.airlineName, "IndiGo");
  assert.equal(f.flightNumber, "2101");
  assert.equal(f.duration, 130);
  assert.equal(f.totalFare, 4890.5);
  assert.equal(f.isRefundable, true);
  assert.deepEqual(f.baggage, { cabin: "7 Kg", checked: "15 Kg" });
  assert.equal(f.seatsLeft, 7);
  assert.equal(f.fareIdentifier, "SAVER");
});

test("Akbar duration formats", () => {
  assert.equal(akbarDurationMinutes("2h 5m"), 125);
  assert.equal(akbarDurationMinutes("14h"), 840);
  assert.equal(akbarDurationMinutes(95), 95);
  assert.equal(akbarDurationMinutes("95"), 95);
  assert.equal(normalizeAkbarSearch({ TUI: "t", Trips: [{ Journey: [{ ...akbarJourney, Duration: "" }] }] }, "ECONOMY")[0].duration, 130);
});

test("Akbar adapter searches one-way with the shared token, renewing it once on 401", async () => {
  const realFetch = globalThis.fetch;
  const tokens: boolean[] = [];
  let searches = 0;
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("/flights/ExpressSearch") && ++searches === 1) return json({ error: "expired" }, 401);
    return json({ TUI: "t", Completed: true, Trips: [{ Journey: [akbarJourney] }] });
  }) as unknown as typeof fetch;
  try {
    const adapter = new AkbarAdapter({ ...akbarCreds, getToken: async (fresh?: boolean) => { tokens.push(!!fresh); return { token: "jwt", clientId: "cid" }; } });
    const base = { origin: "BOM", destination: "DEL", departureDate: "2026-12-01", adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY" as const, currency: "INR" as const };
    assert.equal((await adapter.search({ ...base, tripType: "ONEWAY" })).length, 1);
    assert.deepEqual(tokens, [false, true]);
    assert.deepEqual(await adapter.search({ ...base, tripType: "ROUNDTRIP", returnDate: "2026-12-05" }), []);
  } finally { globalThis.fetch = realFetch; }
});

test("Akbar fares are offline and booked at the searched price", async () => {
  assert.equal(isOfflineSupplier("AKBAR"), true);
  const env = { FARE_CACHE_KV: memoryKv() } as any;
  const [fare] = normalizeAkbarSearch({ TUI: "t", Trips: [{ Journey: [akbarJourney] }] }, "ECONOMY");
  const pax = { adults: 1, children: 0, infants: 0 };
  await rememberOfflineFares(env, "t1", [fare], pax);
  assert.equal((await quoteOfflineFare(env, null as any, "t1", "AKBAR", fare.id, pax))?.totalFare, 4890.5);
  assert.equal(await quoteOfflineFare(env, null as any, "t1", "AKBAR", fare.id, { ...pax, adults: 2 }), null);
});

test("Akbar calls go through the gateway when one is set", async () => {
  const calls: { url: string; key?: string; auth?: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    calls.push({ url, key: h["X-Zamra-Gateway-Key"], auth: h.Authorization });
    return json(url.endsWith("/Signature") ? { Token: "jwt" } : { TUI: "t", Completed: true });
  }) as unknown as typeof fetch;
  const client = new AkbarClient({ ...akbarCreds, gatewayUrl: "https://gw.test/", gatewayKey: "gk" }, fetchImpl);
  const token = await client.signature();
  await client.expressSearch({ origin: "BOM", destination: "DEL", departureDate: "2026-12-01", adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY", tripType: "ONEWAY", currency: "INR" }, token);
  await client.startPay({ transactionId: 1, netAmount: 1, tui: "t" }, token);
  assert.deepEqual(calls.map((c) => c.url), [
    "https://gw.test/utils/Utils/Signature", "https://gw.test/flights/flights/ExpressSearch", "https://gw.test/flights/Payment/StartPay",
  ]);
  assert.ok(calls.every((c) => c.key === "gk"));
  assert.equal(calls[1].auth, "Bearer jwt");
  // Direct calls never carry the gateway key.
  const direct: (string | undefined)[] = [];
  await new AkbarClient(akbarCreds, (async (_u: string, init: RequestInit) => { direct.push((init.headers as Record<string, string>)["X-Zamra-Gateway-Key"]); return json({ Token: "x" }); }) as unknown as typeof fetch).signature();
  assert.deepEqual(direct, [undefined]);
  await assert.rejects(new AkbarClient({ ...akbarCreds, gatewayUrl: "https://gw.test" }, fetchImpl).signature(), /AKBAR_GATEWAY_KEY/);
});

test("Akbar client calls the global fetch unbound (Workers reject this-bound fetch)", async () => {
  const realFetch = globalThis.fetch;
  let receiver: unknown = "unset";
  globalThis.fetch = function (this: unknown) { receiver = this; return Promise.resolve(json({ Token: "jwt" })); } as unknown as typeof fetch;
  try {
    await new AkbarClient(akbarCreds).signature();
    assert.equal(receiver, undefined);
  } finally { globalThis.fetch = realFetch; }
});

test("Akbar search stops when ExpressSearch already holds flights", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => { urls.push(url); return json({ TUI: "t", Completed: false, Trips: [{ Journey: [akbarJourney] }] }); }) as unknown as typeof fetch;
  const r = await new AkbarClient(akbarCreds, fetchImpl).search(
    { origin: "BOM", destination: "DEL", departureDate: "2026-12-01", adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY", tripType: "ONEWAY", currency: "INR" },
    { token: "jwt", clientId: "cid" }, { sleep: async () => {} },
  );
  assert.equal(r.polls, 0);
  assert.equal(r.completed, true);
  assert.deepEqual(urls, ["https://flights.test/flights/ExpressSearch"]);
});

test("a failed GetExpSearch reports what ExpressSearch answered", async () => {
  const fetchImpl = (async (url: string) => url.endsWith("/ExpressSearch")
    ? json({ TUI: "t9", Completed: false, Notices: ["collecting"] })
    : new Response("error code: 504", { status: 504 })) as unknown as typeof fetch;
  await assert.rejects(
    new AkbarClient(akbarCreds, fetchImpl).search(
      { origin: "BOM", destination: "DEL", departureDate: "2026-12-01", adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY", tripType: "ONEWAY", currency: "INR" },
      { token: "jwt", clientId: "cid" }, { sleep: async () => {} },
    ),
    (err: any) => err.statusCode === 504 && /ExpressSearch answered: .*t9/.test(err.responseSnippet) && /error code: 504/.test(err.responseSnippet),
  );
});

test("an Akbar call that hangs times out on its own", async () => {
  const keepAlive = setTimeout(() => {}, 5000);   // AbortSignal.timeout's timer doesn't hold Node open
  const fetchImpl = ((_u: string, init: RequestInit) => new Promise((_, reject) => {
    init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
  })) as unknown as typeof fetch;
  await assert.rejects(
    new AkbarClient(akbarCreds, fetchImpl).expressSearch(
      { origin: "BOM", destination: "DEL", departureDate: "2026-12-01", adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY", tripType: "ONEWAY", currency: "INR" },
      { token: "jwt", clientId: "cid" }, 1000,
    ),
    (err: any) => err.statusCode === 504 && /timed out after 1s/.test(err.message),
  );
  clearTimeout(keepAlive);
});

test("Akbar calls are recorded for API Logs with secrets blanked", async () => {
  const recorded: any[] = [];
  const fetchImpl = (async (url: string) => url.endsWith("/Signature")
    ? json({ Token: "jwt-secret", ClientID: "cid" })
    : new Response("error code: 504", { status: 504 })) as unknown as typeof fetch;
  const client = new AkbarClient({ ...akbarCreds, password: "pw", apiKey: "ak", key: "k", recorder: (x) => recorded.push(x) }, fetchImpl);
  const token = await client.signature();
  assert.equal(token.token, "jwt-secret");   // the caller still gets the real token
  await assert.rejects(client.getExpSearch("t", token));
  assert.deepEqual(recorded.map((x) => [x.supplier, x.endpoint, x.status]), [["AKBAR", "/Utils/Signature", 200], ["AKBAR", "/flights/GetExpSearch", 504]]);
  const sig = JSON.parse(recorded[0].requestBody);
  assert.equal(sig.Password, "••••");
  assert.equal(sig.ApiKey, "••••");
  assert.equal(sig.Key, "••••");
  assert.equal(sig.ClientID, "bitest");
  assert.equal(JSON.parse(recorded[0].responseBody).Token, "••••");
  assert.equal(recorded[1].requestHeaders.Authorization, "Bearer ••••");
  assert.equal(recorded[1].responseBody, "error code: 504");
  assert.ok(!JSON.stringify(recorded).includes("jwt-secret") && !JSON.stringify(recorded).includes('"pw"'));
});
