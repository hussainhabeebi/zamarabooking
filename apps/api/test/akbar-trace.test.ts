// Admin "Akbar request trace": allowlisted fields only, pricing checked against the search.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchJourneys, traceCall, traceChecks, traceRequest } from "../src/lib/akbar-trace.js";

const { rs } = JSON.parse(readFileSync(new URL("./fixtures/akbar-roundtrip-samples.json", import.meta.url), "utf8"));
const meta = (id: string, endpoint: string, startedAt: string, extra: Record<string, unknown> = {}) =>
  ({ id, endpoint, startedAt, httpStatus: 200, durationMs: 100, error: null, searchId: "s1", requestId: null, ...extra });
const tui = rs.expressSearchResponse.TUI;
const stored = (body: unknown) => ({ url: "https://flights.test/x", method: "POST", headers: { Authorization: "Bearer ••••" }, body });
const [o, r] = [rs.getExpSearchResponse.Trips[0].Journey[0], rs.getExpSearchResponse.Trips[1].Journey[0]];
const pricer = (legs: { Index: string; Amount: number }[], t = tui) => stored({ Trips: legs.map((l, i) => ({ ...l, OrderID: i + 1, ChannelCode: "", TUI: t })), ClientID: "", Mode: "SS", Options: "", Source: "SF", TripType: "RS" });

function trace(pricing: unknown, pricedAt = "2026-11-03T10:05:00.000Z") {
  const calls = [
    traceCall(meta("1", "/flights/ExpressSearch", "2026-11-03T10:00:00.000Z"), stored(rs.expressSearchRequest), rs.expressSearchResponse),
    traceCall(meta("2", "/flights/GetExpSearch", "2026-11-03T10:00:02.000Z"), stored(rs.getExpSearchRequest), rs.getExpSearchResponse),
    traceCall(meta("3", "/flights/SmartPricer", pricedAt, { requestId: "req-1" }), pricing, { TUI: null, Code: "1001", Msg: ["No Record found"] }),
  ];
  return { calls, checks: traceChecks(calls, new Map([[tui, { journeys: searchJourneys(rs.getExpSearchResponse), startedAt: calls[0].startedAt }]])) };
}

test("a valid RS SmartPricer: TUI, both Indexes and Amounts found in the search, pair rule holds, timing shown", () => {
  const { calls, checks } = trace(pricer([{ Index: o.Index, Amount: o.NetFare }, { Index: r.Index, Amount: r.NetFare }]));
  assert.deepEqual(calls[2].request && { mode: calls[2].request.mode, tripType: calls[2].request.tripType, options: calls[2].request.options, clientId: calls[2].request.clientId },
    { mode: "SS", tripType: "RS", options: "", clientId: "empty" });
  assert.deepEqual(calls[2].response?.messages, ["No Record found"]);
  const [c] = checks;
  assert.equal(c.searchFound, true);
  assert.equal(c.secondsAfterSearch, 300);
  assert.deepEqual(c.trips.map((t) => [t.found?.index, t.found?.returnIdentifier, t.amountMatches]), [[o.Index, o.ReturnIdentifier, true], [r.Index, r.ReturnIdentifier, true]]);
  assert.deepEqual(c.specialFarePair, { returnIdentifierEqual: true, vacEqual: true, providerEqual: true });
});

test("a wrong TUI, a missing Index or a different Amount is shown as such", () => {
  assert.equal(trace(pricer([{ Index: o.Index, Amount: o.NetFare }, { Index: r.Index, Amount: r.NetFare }], "OTHER-TUI")).checks[0].searchFound, false);
  const [c] = trace(pricer([{ Index: "SG|9999", Amount: o.NetFare }, { Index: r.Index, Amount: r.NetFare + 1 }])).checks;
  assert.equal(c.trips[0].found, null);
  assert.equal(c.trips[1].amountMatches, false);
});

test("no passenger, contact, credential, token or ClientID value ever appears in the trace", () => {
  const secret = "SECRET-CLIENT-ID";
  const ci = traceCall(meta("4", "/flights/CreateItinerary", "2026-11-03T10:06:00.000Z"),
    stored({ TUI: "t", ClientID: secret, NetAmount: 9983, ContactInfo: { FName: "Anand", Email: "a@b.in", Mobile: "9999999999" },
      Travellers: [{ FName: "Anand", LName: "Kumar", DOB: "1987-08-27", PassportNo: "P1" }] }),
    { TUI: "t", Code: "200", TransactionID: 1, NetAmount: 9983, Travellers: [{ FName: "Anand" }] });
  const sig = traceCall(meta("5", "/Utils/Signature", "2026-11-03T10:00:00.000Z"), stored({ MerchantID: "300", ApiKey: "k", Password: "p", ClientID: secret }), { Token: "jwt-secret", TUI: "x" });
  const text = JSON.stringify([ci, sig]);
  for (const v of ["Anand", "Kumar", "a@b.in", "9999999999", "1987-08-27", "P1", secret, "jwt-secret", "ContactInfo", "Travellers"]) assert.ok(!text.includes(v), v);
  assert.equal(ci.request?.clientId, "sent");
  assert.equal(ci.request?.netAmount, 9983);
  assert.equal(sig.request, null);
  assert.equal(traceRequest(null), null);
});
