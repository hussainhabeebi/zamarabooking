import test from "node:test";
import assert from "node:assert/strict";
import { normalizePoomasOffer, PoomasAdapter } from "@zamrabooking/suppliers";
import {
  isOfflineSupplier, manualFareToNormalized, parseCsv, parseManualFaresCsv, quoteOfflineFare, rememberOfflineFares, sheetCsvUrl,
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
