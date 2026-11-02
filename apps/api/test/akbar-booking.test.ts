import test from "node:test";
import assert from "node:assert/strict";
import { AkbarAdapter, AkbarClient, AkbarError, akbarBookingRefs, akbarTravelRequirements, createItineraryBody, startPayBody, smartPricerBody } from "@zamrabooking/suppliers";
import {
  akbarBookingGate, akbarContact, akbarLegRefs, akbarMobile, akbarOutcome, akbarPrepaymentCheck, akbarTravellers, ageOn,
  refreshAkbarBooking, runAkbarBooking, type AkbarBookingState, type AkbarEngineDeps,
} from "../src/lib/akbar-booking.js";
import { akbarCertificationPack, akbarCertificationRequest, akbarStep, akbarUrl } from "../src/lib/akbar-certification.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const creds = { utilsUrl: "https://utils.test", flightsUrl: "https://flights.test", merchantId: "300", apiKey: "k", clientId: "bitest", password: "p", agentCode: "", browserKey: "bk", key: "" };
const token = { token: "jwt", clientId: "enc-client" };

// Postman sample bodies (B2B Revamp Flight API - Test collection).
const POSTMAN_CREATE_ITINERARY_KEYS = ["TUI", "ContactInfo", "Travellers", "PLP", "SSR", "CrossSell", "NetAmount", "SSRAmount", "ClientID", "DeviceID", "AppVersion", "CrossSellAmount"];
const POSTMAN_CONTACT_KEYS = ["Title", "FName", "LName", "Mobile", "Phone", "Email", "Address", "CountryCode", "State", "City", "PIN", "GSTCompanyName", "GSTTIN", "GSTMobile", "GSTEmail", "UpdateProfile", "IsGuest"];
const POSTMAN_TRAVELLER_KEYS = ["ID", "Title", "FName", "LName", "Age", "DOB", "Gender", "PTC", "Nationality", "PassportNo", "PLI", "PDOE", "VisaType"];
const POSTMAN_STARTPAY_KEYS = ["TransactionID", "PaymentAmount", "NetAmount", "BrowserKey", "ClientID", "TUI", "Hold", "Promo", "PaymentType", "BankCode", "GateWayCode", "MerchantID", "PaymentCharge", "ReleaseDate", "OnlinePayment", "DepositPayment", "Card", "VPA", "CardAlias", "QuickPay", "RMSSignature", "TargetCurrency", "TargetAmount", "ServiceType"];

const contact = { fName: "Anand", lName: "Kumar", mobile: "9999999999", email: "a@b.in", address: "1 MG Road", city: "KOCHI", state: "Kerala", pin: "682001", countryCode: "IN" };
const pax = [{ type: "ADULT" as const, firstName: "Anand", lastName: "Kumar", gender: "M" as const, dob: "1987-08-27" }];
const leg = { tui: "search-tui", index: "6E|1", orderId: 1, netFare: 4890.5 };

test("CreateItinerary and StartPay bodies have every field of the Postman samples", () => {
  const body = createItineraryBody({
    tui: "priced-tui", netAmount: 4890.5, contact,
    travellers: akbarTravellers(pax, "2026-12-01").travellers,
  }, "cid");
  assert.deepEqual(Object.keys(body), POSTMAN_CREATE_ITINERARY_KEYS);
  assert.deepEqual(Object.keys(body.ContactInfo), POSTMAN_CONTACT_KEYS);
  assert.deepEqual(Object.keys(body.Travellers[0]), POSTMAN_TRAVELLER_KEYS);
  assert.deepEqual(body.Travellers[0], { ID: 1, Title: "Mr", FName: "Anand", LName: "Kumar", Age: 39, DOB: "1987-08-27", Gender: "M", PTC: "ADT", Nationality: "", PassportNo: "", PLI: "", PDOE: "", VisaType: "" });
  assert.deepEqual([body.SSR, body.PLP, body.CrossSell, body.SSRAmount, body.CrossSellAmount], [[], [], [], 0, 0]);
  const pay = startPayBody({ transactionId: 230003316, netAmount: 123800, tui: "t" }, "cid", "bk");
  assert.deepEqual(Object.keys(pay), POSTMAN_STARTPAY_KEYS);
  assert.equal(pay.DepositPayment, true);
  assert.equal(pay.OnlinePayment, false);
  assert.equal(pay.Hold, false);
  assert.equal(pay.ServiceType, "ITI");
  assert.equal(pay.Card.Number, "");
  // Booking flow pricing as in the collection: Mode AS, Options "".
  assert.deepEqual(smartPricerBody([{ amount: 1, index: "i", orderId: 1, tui: "t" }], "cid", "ON", "AS", ""), {
    ClientID: "cid", Trips: [{ Amount: 1, Index: "i", OrderID: 1, TUI: "t" }], Mode: "AS", Options: "", Source: "SF", TripType: "ON",
  });
});

// A mock Akbar that follows the collection's TUI hand-off and checks each request.
function mockAkbar(opts: { priced?: number; status?: string[]; retrieve?: unknown; startPay?: () => Response; createCode?: string } = {}) {
  const calls: { path: string; body: any }[] = [];
  const status = [...(opts.status ?? ["Success"])];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    calls.push({ path, body });
    switch (path) {
      case "/Utils/Signature": return json({ Token: "jwt2", TUI: "", ClientID: "enc-client", Code: "200" });
      case "/flights/SmartPricer":
        assert.equal(body.Trips[0].TUI, "search-tui");
        return json({ TUI: "sp-tui", Code: "200", Msg: [] });
      case "/flights/GetSPricer":
        assert.equal(body.TUI, "sp-tui");
        return json({ TUI: "priced-tui", NetAmount: opts.priced ?? 4890.5, Code: "200" });
      case "/Utils/GetTravelCheckList": return json({ TUI: body.TUI, Code: "200", PassportRequired: false });
      case "/flights/ssr": case "/flights/SeatLayout": return json({ Code: "200", Trips: [] });
      case "/flights/CreateItinerary":
        assert.equal(body.TUI, "priced-tui");
        return json({ TUI: "it-tui", TransactionID: 230003316, NetAmount: body.NetAmount, Code: opts.createCode ?? "200", Msg: opts.createCode ? ["Fare expired"] : [] });
      case "/Payment/StartPay":
        assert.equal(body.TUI, "it-tui");
        assert.equal(body.TransactionID, 230003316);
        return opts.startPay ? opts.startPay() : json({ Code: "200", TransactionID: 230003316 });
      case "/Payment/GetItineraryStatus":
        assert.deepEqual(body, { TUI: "it-tui", TransactionID: 230003316 });
        return json({ CurrentStatus: status.length > 1 ? status.shift() : status[0], Code: "200" });
      case "/Utils/RetrieveBooking":
        assert.equal(body.ReferenceNumber, "230003316");
        return json(opts.retrieve ?? { Code: "200", Trips: [{ Journey: [{ Segments: [{ CRSPNR: "X7KQ2P", Pax: [{ ID: 1, Ticket: "" }] }] }] }] });
    }
    return json({ Code: "404" }, 404);
  }) as unknown as typeof fetch;
  return { calls, client: new AkbarClient(creds, fetchImpl) };
}

function engine(client: AkbarClient, over: Partial<AkbarEngineDeps> = {}) {
  const saves: AkbarBookingState[] = [];
  const logs: string[] = [];
  const deps: AkbarEngineDeps = {
    client, token: async () => token, sleep: async () => {},
    save: async (s) => { saves.push(JSON.parse(JSON.stringify(s))); },
    log: (_l, m) => { logs.push(m); },
    ...over,
  };
  return { deps, saves, logs };
}

const paths = (calls: { path: string }[]) => calls.map((c) => c.path.split("/").pop());

test("one-way: the full sequence with the TUI handed on at every step, PNR from RetrieveBooking", async () => {
  const { calls, client } = mockAkbar();
  const { deps, saves } = engine(client);
  const state = await runAkbarBooking(deps, { legs: [leg], pax, departureDates: ["2026-12-01"], contact, lookups: true });
  assert.deepEqual(paths(calls), ["SmartPricer", "GetSPricer", "GetTravelCheckList", "SeatLayout", "ssr", "CreateItinerary", "StartPay", "GetItineraryStatus", "RetrieveBooking"]);
  assert.equal(state.outcome, "TICKETED");
  assert.deepEqual(state.legs[0].pnrs, ["X7KQ2P"]);
  assert.equal(state.legs[0].tickets, undefined);            // Akbar returned an empty ticket → none stored
  assert.equal(calls[0].body.Mode, "AS");
  // PAYMENT_SENT was saved before StartPay went out.
  const sentIdx = saves.findIndex((s) => s.legs[0]?.state === "PAYMENT_SENT");
  assert.ok(sentIdx >= 0 && saves[sentIdx].legs[0].paymentSentAt);
  assert.ok(!saves.slice(0, sentIdx).some((s) => s.legs[0]?.paymentSentAt));
});

test("a higher live fare stops before CreateItinerary and StartPay", async () => {
  const { calls, client } = mockAkbar({ priced: 5200 });
  const { deps } = engine(client);
  const state = await runAkbarBooking(deps, { legs: [leg], pax, departureDates: ["2026-12-01"], contact });
  assert.equal(state.outcome, "FAILED_BEFORE_PAYMENT");
  assert.equal(state.legs[0].errorCode, "FARE_INCREASED");
  assert.ok(!paths(calls).includes("CreateItinerary") && !paths(calls).includes("StartPay"));
});

test("CreateItinerary refused by Akbar: no StartPay", async () => {
  const { calls, client } = mockAkbar({ createCode: "500" });
  const { deps } = engine(client);
  const state = await runAkbarBooking(deps, { legs: [leg], pax, departureDates: ["2026-12-01"], contact });
  assert.equal(state.outcome, "FAILED_BEFORE_PAYMENT");
  assert.equal(state.legs[0].errorCode, "ITINERARY_FAILED");
  assert.match(state.legs[0].message!, /Fare expired/);
  assert.ok(!paths(calls).includes("StartPay"));
});

test("StartPay timeout: status is checked, and a rerun never sends StartPay again", async () => {
  const { calls, client } = mockAkbar({ status: [""], retrieve: { Code: "200" }, startPay: () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); } });
  const { deps } = engine(client);
  const first = await runAkbarBooking(deps, { legs: [leg], pax, departureDates: ["2026-12-01"], contact, statusDeadlineMs: 1 });
  assert.equal(first.outcome, "PENDING");
  assert.equal(first.legs[0].pnrs, undefined);
  assert.equal(paths(calls).filter((p) => p === "StartPay").length, 1);
  calls.length = 0;
  const second = await runAkbarBooking(deps, { legs: [leg], pax, departureDates: ["2026-12-01"], contact, state: first, statusDeadlineMs: 1 });
  assert.deepEqual(paths(calls), ["GetItineraryStatus", "RetrieveBooking"]);
  assert.equal(second.outcome, "PENDING");
  assert.equal(second.runs, 2);
});

test("StartPay is not sent when the PAYMENT_SENT state can't be saved", async () => {
  const { calls, client } = mockAkbar();
  const { deps } = engine(client, { save: async (s) => { if (s.legs.some((l) => l.state === "PAYMENT_SENT")) throw new Error("db down"); } });
  await assert.rejects(runAkbarBooking(deps, { legs: [leg], pax, departureDates: ["2026-12-01"], contact }), /db down/);
  assert.ok(!paths(calls).includes("StartPay"));
});

test("Success without a PNR is not ticketed (no PNR is invented)", async () => {
  const { client } = mockAkbar({ retrieve: { Code: "200", Trips: [{ Journey: [{ Segments: [{ CRSPNR: "" }] }] }] } });
  const { deps } = engine(client);
  const state = await runAkbarBooking(deps, { legs: [leg], pax, departureDates: ["2026-12-01"], contact });
  assert.equal(state.outcome, "PENDING");
  assert.match(state.legs[0].message!, /no PNR/);
});

test("Failed after StartPay is FAILED; refresh only reads status", async () => {
  const { calls, client } = mockAkbar({ status: ["Failed"], retrieve: { Code: "200" } });
  const { deps } = engine(client);
  const state = await runAkbarBooking(deps, { legs: [leg], pax, departureDates: ["2026-12-01"], contact });
  assert.equal(state.outcome, "FAILED");
  calls.length = 0;
  const again = await refreshAkbarBooking(deps, state, 1);
  assert.deepEqual(paths(calls), ["GetItineraryStatus", "RetrieveBooking"]);
  assert.equal(again.outcome, "FAILED");
});

test("round trip: legs are booked in order and the return is not started when the outbound fails", async () => {
  const { calls, client } = mockAkbar({ priced: 9999 });
  const { deps } = engine(client);
  const state = await runAkbarBooking(deps, { legs: [leg, { ...leg, index: "6E|9" }], pax, departureDates: ["2026-12-01", "2026-12-05"], contact });
  assert.equal(state.outcome, "FAILED_BEFORE_PAYMENT");
  assert.equal(calls.filter((c) => c.path.endsWith("SmartPricer")).length, 1);
  assert.equal(akbarOutcome({ legs: [{ leg: 0, state: "SUCCESS" }, { leg: 1, state: "FAILED", paymentSentAt: "x" }], startedAt: "", runs: 1 }, 2), "PARTIAL");
  assert.equal(akbarOutcome({ legs: [{ leg: 0, state: "SUCCESS" }], startedAt: "", runs: 1 }, 2), "PARTIAL");
  assert.equal(akbarOutcome({ legs: [{ leg: 0, state: "FAILED" }], startedAt: "", runs: 1 }, 2), "FAILED_BEFORE_PAYMENT");
});

test("a fresh pre-payment price is reused after payment; a cached token Akbar rejects is renewed once", async () => {
  const { calls, client } = mockAkbar();
  let tokens = 0;
  let rejected = false;
  const real = client.createItinerary.bind(client);
  client.createItinerary = async (p, t) => {
    if (!rejected) { rejected = true; throw new AkbarError("Akbar /flights/CreateItinerary failed (HTTP 401)", 401, "/flights/CreateItinerary"); }
    return real(p, t);
  };
  const { deps } = engine(client, { token: async (fresh) => { tokens++; return { ...token, token: fresh ? "jwt-new" : "jwt" }; }, now: () => new Date("2026-11-02T10:05:00Z") });
  const pre = await akbarPrepaymentCheck(deps, { legs: [leg], pax, departureDates: ["2026-12-01"] });
  assert.equal(pre.legs[0].pricedTui, "priced-tui");
  calls.length = 0;
  const state = await runAkbarBooking(deps, { legs: [leg], pax, departureDates: ["2026-12-01"], contact, state: { ...pre, legs: pre.legs.map((l) => ({ ...l, pricedAt: "2026-11-02T10:00:00Z" })) } });
  // No second SmartPricer / GetSPricer: the pre-payment price is reused.
  assert.deepEqual(paths(calls), ["CreateItinerary", "StartPay", "GetItineraryStatus", "RetrieveBooking"]);
  assert.equal(state.outcome, "TICKETED");
  assert.equal(tokens, 3);   // pre-payment, booking run, renewed after the 401
});

test("pre-payment check reports missing traveller details and the airline's passport rule", async () => {
  const { client } = mockAkbar();
  client.getTravelCheckList = async () => ({ Code: "200", Checklist: { PassportNo: "Mandatory", DOB: "Optional" } });
  const { deps } = engine(client);
  await assert.rejects(akbarPrepaymentCheck(deps, { legs: [leg], pax, departureDates: ["2026-12-01"] }),
    (e: any) => e.code === "TRAVELLER_DETAILS_MISSING" && /passport number and expiry/.test(e.message));
});

test("Akbar booking is off by default and blocked on production until approved", () => {
  assert.equal(akbarBookingGate({}, { apiBooking: "OFF", environment: "UAT", enabled: true }).allowed, false);
  assert.deepEqual(akbarBookingGate({}, { apiBooking: "MANUAL", environment: "UAT", enabled: true }), { allowed: true, auto: false });
  assert.deepEqual(akbarBookingGate({}, { apiBooking: "AUTO", environment: "UAT", enabled: true }), { allowed: true, auto: true });
  assert.equal(akbarBookingGate({}, { apiBooking: "AUTO", environment: "PRODUCTION", enabled: true }).allowed, false);
  assert.equal(akbarBookingGate({ AKBAR_API_BOOKING_PRODUCTION: "yes" }, { apiBooking: "AUTO", environment: "PRODUCTION", enabled: true }).allowed, false);
  assert.equal(akbarBookingGate({ AKBAR_API_BOOKING_PRODUCTION: "approved" }, { apiBooking: "AUTO", environment: "PRODUCTION", enabled: true }).allowed, true);
});

test("travellers, contact and stored fare references", () => {
  const { travellers, problems } = akbarTravellers([
    { type: "ADULT", firstName: "Asha ", lastName: "Nair", gender: "F", passportNumber: "m1234567", passportExpiry: "2030-01-01", nationality: "in", passportCountry: "in" },
    { type: "CHILD", firstName: "Ravi", lastName: "Nair", gender: "M", dob: "2018-12-02" },
    { type: "INFANT", firstName: "Mia", lastName: "Nair" },
  ], "2026-12-01");
  assert.deepEqual(travellers.map((t) => [t.title, t.ptc, t.age]), [["Ms", "ADT", null], ["Mstr", "CHD", 7], ["Mstr", "INF", null]]);
  assert.deepEqual([travellers[0].passportNo, travellers[0].nationality, travellers[0].pdoe, travellers[0].fName], ["M1234567", "IN", "2030-01-01", "Asha"]);
  assert.deepEqual(problems, ["Traveller 3: gender is required.", "Traveller 3: date of birth is required for children and infants."]);
  assert.equal(ageOn("2018-12-02", "2026-12-01"), 7);
  assert.equal(akbarMobile("+91 98765 43210"), "9876543210");
  assert.match(akbarContact({ contactAddress: "", contactCity: "", contactState: "", contactPin: "", contactCountryCode: "IN" }, pax[0], "a@b", "1").problems[0], /contact address/);
  assert.deepEqual(akbarLegRefs({ offline: { sourceRef: { tui: "t", index: "i", orderId: 1, netFare: 10 } } }), [{ tui: "t", index: "i", orderId: 1, netFare: 10 }]);
  assert.equal(akbarLegRefs({ offline: { legs: [{ sourceRef: { tui: "a" } }, { sourceRef: { tui: "b" } }] } }).length, 2);
});

test("PNRs and tickets are read only from what Akbar returned", () => {
  assert.deepEqual(akbarBookingRefs({ Trips: [{ Journey: [{ Segments: [
    { CRSPNR: "t9dgf2", APNR: "", Pax: [{ ID: 5024, Ticket: "0987345536870" }, { ID: 5025, Ticket: "" }] },
    { CRSPNR: "T9DGF2", Pax: [{ ID: 5024, Ticket: "0987345536870" }] },
  ] }] }] }), { pnrs: ["T9DGF2"], tickets: ["0987345536870"] });
  assert.deepEqual(akbarBookingRefs({ Code: "200", Msg: ["Success"] }), { pnrs: [], tickets: [] });
  assert.equal(akbarTravelRequirements({ x: { IsPassportMandatory: true, DOBRequired: "N" } }).passport, true);
  assert.equal(akbarTravelRequirements({ x: { IsPassportMandatory: true, DOBRequired: "N" } }).dob, false);
});

test("Akbar certification files: Akbar URLs, secrets blanked, every call numbered in order", async () => {
  assert.equal(akbarStep("/flights/ssr"), "SSR");
  assert.equal(akbarStep("/Payment/GetItineraryStatus"), "GetItineraryStatus");
  const hosts = { utilsUrl: "https://b2bapiutils.benzyinfotech.com", flightsUrl: "https://b2bapiflights.benzyinfotech.com/" };
  assert.equal(akbarUrl("https://gw.test/utils/Utils/Signature", hosts), "https://b2bapiutils.benzyinfotech.com/Utils/Signature");
  assert.equal(akbarUrl("https://gw.test/flights/Payment/StartPay", hosts), "https://b2bapiflights.benzyinfotech.com/Payment/StartPay");
  assert.equal(akbarUrl("https://b2bapiflights.benzyinfotech.com/flights/SmartPricer", hosts), "https://b2bapiflights.benzyinfotech.com/flights/SmartPricer");
  const req = akbarCertificationRequest({ url: "https://gw.test/utils/Utils/Signature", method: "POST",
    headers: { "Content-Type": "application/json", "X-Zamra-Gateway-Key": "gk", Authorization: "Bearer real" }, body: { ClientID: "bitest", Password: "pw", ApiKey: "ak" } }, hosts);
  assert.deepEqual(req.headers, { "Content-Type": "application/json", Authorization: "Bearer ••••" });
  assert.deepEqual(req.body, { ClientID: "bitest", Password: "••••", ApiKey: "••••" });

  const r2 = new Map<string, string>();
  const at = (m: number) => new Date(Date.UTC(2026, 10, 2, 10, m));
  const ex = (id: string, endpoint: string, m: number, extra: Record<string, unknown> = {}) => {
    r2.set(`${id}-rq`, JSON.stringify({ method: "POST", url: `https://gw.test/flights${endpoint}`, headers: { "X-Zamra-Gateway-Key": "gk" }, body: { id } }));
    r2.set(`${id}-rs.json`, JSON.stringify({ id, Code: "200" }));
    return { id, supplier: "AKBAR", endpoint, requestKey: `${id}-rq`, responseKey: `${id}-rs.json`, startedAt: at(m), ...extra };
  };
  const rows = [
    ex("sig", "/Utils/Signature", 0), ex("es", "/flights/ExpressSearch", 1), ex("sp", "/flights/SmartPricer", 2), ex("gp", "/flights/GetSPricer", 3),
    ex("ci", "/flights/CreateItinerary", 4), ex("pay", "/Payment/StartPay", 5), ex("st1", "/Payment/GetItineraryStatus", 6), ex("st2", "/Payment/GetItineraryStatus", 7),
  ];
  let call = 0;
  const chain = (r: any[]) => ({ from: () => ({ where: () => Object.assign(Promise.resolve(r), { orderBy: () => Object.assign(Promise.resolve(r), { limit: async () => r }) }) }) });
  const db: any = { select: () => chain(call++ === 0 ? rows : [{ firstName: "Anand", lastName: "Kumar", passengerType: "ADULT" }]) };
  const env: any = {
    TENANT_CACHE_KV: { get: async () => null },
    DOCUMENTS_R2: { get: async (k: string) => r2.has(k) ? { text: async () => r2.get(k), arrayBuffer: async () => new TextEncoder().encode(r2.get(k)!).buffer } : null },
  };
  const booking: any = { id: "bk1", tenantId: "t1", supplier: "AKBAR", status: "TICKETED", tripType: "ONEWAY", origin: "BOM", destination: "DEL", createdAt: at(4), departureDate: at(0),
    flightData: { searchId: "s1", akbarBooking: { outcome: "TICKETED", legs: [{ leg: 0, state: "SUCCESS", transactionId: 230003316, pnrs: ["X7KQ2P"] }] } } };
  const files = await akbarCertificationPack(env, db, booking, "oneway/BOM-DEL-1A-DIRECT/");
  assert.deepEqual(files.map((f) => f.name.replace("oneway/BOM-DEL-1A-DIRECT/", "")), [
    "BookingSummary.json",
    "01-Signature-Request.json", "01-Signature-Response.json", "02-ExpressSearch-Request.json", "02-ExpressSearch-Response.json",
    "03-SmartPricer-Request.json", "03-SmartPricer-Response.json", "04-GetSPricer-Request.json", "04-GetSPricer-Response.json",
    "05-CreateItinerary-Request.json", "05-CreateItinerary-Response.json", "06-StartPay-Request.json", "06-StartPay-Response.json",
    "07-GetItineraryStatus-Request.json", "07-GetItineraryStatus-Response.json", "08-GetItineraryStatus-Request.json", "08-GetItineraryStatus-Response.json",
  ]);
  const dec = (n: string) => JSON.parse(new TextDecoder().decode(files.find((f) => f.name.endsWith(n))!.data));
  assert.equal(dec("06-StartPay-Request.json").url, "https://b2bapiflights.benzyinfotech.com/Payment/StartPay");
  assert.ok(!JSON.stringify(dec("06-StartPay-Request.json")).includes("gk"));
  const summary = dec("BookingSummary.json");
  assert.deepEqual(summary.missingSteps, ["GetExpSearch", "GetTravelCheckList", "SeatLayout", "SSR", "RetrieveBooking"]);
  assert.deepEqual(summary.akbar.legs[0], { leg: 1, state: "SUCCESS", searchTui: null, pricingTui: null, itineraryTui: null, transactionId: 230003316, pnrs: ["X7KQ2P"], tickets: [] });
});

// ── Website booking (wallet or gateway: both end in PAYMENT_CAPTURED → recordOfflinePayment) ──

const searchParams = { origin: "BOM", destination: "DEL", departureDate: "2026-12-15", adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY" as const, tripType: "ONEWAY" as const, currency: "INR" as const };
const searchReply = { TUI: "search-tui", Completed: true, Code: "200", Trips: [{ Journey: [{ Index: "6E|1", OrderID: 1, NetFare: 4890.5, From: "BOM", To: "DEL", VAC: "6E", FlightNo: "2101", DepartureTime: "2026-12-15T06:00:00", ArrivalTime: "2026-12-15T08:10:00" }] }] };

const journey = (i: number) => ({ ...searchReply.Trips[0].Journey[0], Index: `6E|${i}`, NetFare: 4000 + i });

test("API booking on: ExpressSearch Mode AS, then GetExpSearch (ClientID \"\") returns the fares; off: Mode SY unchanged", async () => {
  for (const [apiBooking, mode, calls] of [["MANUAL", "AS", ["ExpressSearch", "GetExpSearch"]], ["AUTO", "AS", ["ExpressSearch", "GetExpSearch"]], ["OFF", "SY", ["ExpressSearch"]]] as const) {
    const sent: { step: string; body: any }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const step = url.split("/").pop()!;
      sent.push({ step, body: JSON.parse(String(init.body)) });
      // Mode AS: ExpressSearch returns the TUI only; GetExpSearch returns the fares, Completed.
      if (step === "ExpressSearch" && JSON.parse(String(init.body)).Mode === "AS") return json({ TUI: "search-tui", Code: "200", Completed: false });
      if (step === "GetExpSearch") return json({ TUI: "search-tui", Code: "200", Completed: "Completed", Trips: [{ Journey: [journey(1), journey(2)] }] });
      return json(searchReply);
    }) as unknown as typeof fetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    let fares: any[];
    try { fares = await new AkbarAdapter({ ...creds, apiBooking, getToken: async () => token } as any).search(searchParams); }
    finally { globalThis.fetch = realFetch; }
    assert.deepEqual(sent.map((x) => x.step), calls, apiBooking);
    assert.equal(sent[0].body.Mode, mode, apiBooking);
    if (mode === "AS") {
      assert.deepEqual(sent[1].body, { ClientID: "", TUI: "search-tui" });
      assert.deepEqual(fares.map((f) => f.id), ["AK|search-tui|6E|1", "AK|search-tui|6E|2"]);   // fares from GetExpSearch
    } else {
      assert.deepEqual(fares.map((f) => f.id), ["AK|search-tui|6E|1"]);                         // ExpressSearch fares, as today
    }
  }
});

test("Mode AS polls GetExpSearch until Completed and keeps fares already received", async () => {
  const run = async (replies: (object | Response)[], deadlineMs = 45_000) => {
    const steps: string[] = [];
    const fetchImpl = (async (url: string) => {
      steps.push(url.split("/").pop()!);
      const r = replies.shift()!;
      return r instanceof Response ? r : json(r);
    }) as unknown as typeof fetch;
    const r = await new AkbarClient(creds, fetchImpl).search(searchParams, token, { mode: "AS", sleep: async () => {}, deadlineMs });
    return { ...r, steps };
  };
  const express = { TUI: "t", Code: "200" };
  // Partial, then complete.
  const done = await run([express, { TUI: "t", Completed: false, Trips: [{ Journey: [journey(1)] }] }, { TUI: "t", Completed: "Completed", Trips: [{ Journey: [journey(1), journey(2)] }] }]);
  assert.deepEqual(done.steps, ["ExpressSearch", "GetExpSearch", "GetExpSearch"]);
  assert.equal(done.polls, 2);
  assert.equal(done.completed, true);
  assert.equal((done.data as any).Trips[0].Journey.length, 2);
  // A later GetExpSearch failure keeps the fares already received.
  const kept = await run([express, { TUI: "t", Completed: false, Trips: [{ Journey: [journey(1)] }] }, new Response("busy", { status: 503 })]);
  assert.equal((kept.data as any).Trips[0].Journey.length, 1);
  // Nothing received at all: Akbar's error, with what ExpressSearch said.
  await assert.rejects(run([express, new Response("busy", { status: 503 })]),
    (e: any) => e.statusCode === 503 && /ExpressSearch answered/.test(e.responseSnippet));
  // GetExpSearch is called at least once even when ExpressSearch already says Completed.
  const once = await run([{ ...searchReply, Completed: true }, { ...searchReply, Completed: true }]);
  assert.deepEqual(once.steps, ["ExpressSearch", "GetExpSearch"]);
});

test("a website booking logs every documented Akbar step, in order, with TUIs and the transaction", async () => {
  const { client } = mockAkbar();
  const recorded: any[] = [];
  // Same client wiring as production: every call goes to the recorder (Admin → API Logs / ZIP).
  const rec = new AkbarClient({ ...creds, recorder: (x) => recorded.push(x) }, (async (url: string, init: RequestInit) => {
    if (url.endsWith("/ExpressSearch") || url.endsWith("/GetExpSearch")) return json(searchReply);
    return (client as any).fetchImpl(url, init);
  }) as unknown as typeof fetch);
  // 1. Search (website): ExpressSearch + GetExpSearch with API booking on.
  const search = await rec.search(searchParams, token, { mode: "AS" });
  assert.equal(search.polls, 1);
  const tokenFn = async (fresh?: boolean) => (fresh ? rec.signature() : token);
  const { deps } = engine(rec, { token: tokenFn });
  // 2. Checkout (POST /api/book): live fare + checklist before payment.
  const pre = await akbarPrepaymentCheck(deps, { legs: [leg], pax, departureDates: ["2026-12-15"] });
  // 3. After the wallet / gateway payment: the booking run (UAT: fresh Signature + lookups).
  const state = await runAkbarBooking(deps, { legs: [leg], pax, departureDates: ["2026-12-15"], contact, state: pre, lookups: true, freshToken: true });
  assert.equal(state.outcome, "TICKETED");
  const steps = recorded.map((x) => akbarStep(x.endpoint));
  assert.deepEqual(steps, ["ExpressSearch", "GetExpSearch", "SmartPricer", "GetSPricer", "GetTravelCheckList",
    "Signature", "SeatLayout", "SSR", "CreateItinerary", "StartPay", "GetItineraryStatus", "RetrieveBooking"]);
  // Every documented step except WebSettings, each with a request and a response.
  const { AKBAR_REQUIRED_STEPS } = await import("../src/lib/akbar-certification.js");
  assert.deepEqual([...AKBAR_REQUIRED_STEPS].sort(), [...new Set(steps)].sort());
  assert.ok(recorded.every((x) => x.requestBody && x.responseBody && x.status === 200));
  // TUI hand-off and transaction reference as Akbar returned them.
  const body = (step: string) => JSON.parse(recorded.find((x) => akbarStep(x.endpoint) === step).requestBody);
  assert.equal(body("GetExpSearch").TUI, "search-tui");
  assert.equal(body("SmartPricer").Trips[0].TUI, "search-tui");
  assert.equal(body("GetSPricer").TUI, "sp-tui");
  assert.equal(body("CreateItinerary").TUI, "priced-tui");
  assert.deepEqual([body("StartPay").TUI, body("StartPay").TransactionID], ["it-tui", 230003316]);
  assert.equal(body("RetrieveBooking").ReferenceNumber, "230003316");
  assert.deepEqual(state.legs[0].pnrs, ["X7KQ2P"]);
  // The Signature token never reaches the logs.
  assert.ok(!JSON.stringify(recorded).includes("jwt2"));
});
