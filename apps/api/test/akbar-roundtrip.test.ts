// Akbar round trips in one search (RT / RS), checked against Akbar's own sample payloads.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  akbarRoundTripSearchBody, akbarRoundTripJourneys, akbarSpecialFarePairs, akbarSpecialFareCombinations, akbarSpecialFarePricerBody,
  normalizeAkbarSearch,
} from "@zamrabooking/suppliers";

const samples = JSON.parse(readFileSync(new URL("./fixtures/akbar-roundtrip-samples.json", import.meta.url), "utf8"));
const { rt, rs } = samples;
const base = { tripType: "ROUNDTRIP" as const, adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY" as const };

test("RT ExpressSearch body matches Akbar's RT sample field for field (apart from the sample's SG airline filter)", () => {
  const body = akbarRoundTripSearchBody({ ...base, origin: "BOM", destination: "DEL", departureDate: "2025-05-22", returnDate: "2025-05-25" } as any, "SAMPLE-CLIENT-ID", "RT");
  const expected = structuredClone(rt.expressSearchRequest);
  expected.Parameters.Airlines = "";   // the sample searched SpiceJet only; Zamra searches every airline
  assert.deepEqual(body, expected);
});

test("RS ExpressSearch body matches Akbar's RS sample field for field", () => {
  const body = akbarRoundTripSearchBody({ ...base, origin: "BOM", destination: "DXB", departureDate: "2026-02-11", returnDate: "2026-03-20" } as any, "SAMPLE-CLIENT-ID", "RS");
  assert.deepEqual(body, rs.expressSearchRequest);
});

test("GetExpSearch RT / RS: Trips[0] is the onward list, Trips[1] the return list", () => {
  for (const s of [rt, rs]) {
    const { onward, return: ret } = akbarRoundTripJourneys(s.getExpSearchResponse);
    const [from, to] = [s.expressSearchRequest.Trips[0].From, s.expressSearchRequest.Trips[0].To];
    assert.ok(onward.length && ret.length);
    assert.ok(onward.every((j) => j.From === from && j.To === to));
    assert.ok(ret.every((j) => j.From === to && j.To === from));
  }
  // Normal RT fares carry ReturnIdentifier 0; every RS fare one above 0.
  assert.ok(akbarRoundTripJourneys(rt.getExpSearchResponse).onward.every((j) => j.ReturnIdentifier === 0));
  assert.ok(akbarRoundTripJourneys(rs.getExpSearchResponse).return.every((j) => (j.ReturnIdentifier as number) > 0));
});

test("Special Fare pairs: equal ReturnIdentifier (> 0), VAC and Provider; Index may differ", () => {
  const pairs = akbarSpecialFareCombinations(rs.getExpSearchResponse);
  assert.deepEqual(pairs.map((p) => [p.onward.Index, p.return.Index]), [["SG|2001", "SG|2001"], ["SG|2002", "SG|2002"], ["SG|2003", "SG|2003"]]);
  const { onward, return: ret } = akbarRoundTripJourneys(rs.getExpSearchResponse);
  const o = onward[0], r = ret.find((j) => j.ReturnIdentifier === o.ReturnIdentifier)!;
  assert.equal(akbarSpecialFarePairs(o, r), true);
  assert.equal(akbarSpecialFarePairs(o, { ...r, Index: "SG|9" }), true);                 // Index may differ
  assert.equal(akbarSpecialFarePairs(o, { ...r, ReturnIdentifier: 2002 }), false);        // other pair
  assert.equal(akbarSpecialFarePairs(o, { ...r, VAC: "6E" }), false);
  assert.equal(akbarSpecialFarePairs(o, { ...r, Provider: "AM" }), false);
  assert.equal(akbarSpecialFarePairs({ ...o, ReturnIdentifier: 0 }, { ...r, ReturnIdentifier: 0 }), false);
  // Normal RT fares (ReturnIdentifier 0) are never Special Fare pairs.
  assert.deepEqual(akbarSpecialFareCombinations(rt.getExpSearchResponse), []);
});

test("Special Fare SmartPricer body matches Akbar's RS sample", () => {
  const [pair] = akbarSpecialFareCombinations(rs.getExpSearchResponse);
  assert.deepEqual(akbarSpecialFarePricerBody(pair, rs.expressSearchResponse.TUI, ""), rs.smartPricerRequest);
  const { onward, return: ret } = akbarRoundTripJourneys(rs.getExpSearchResponse);
  assert.throws(() => akbarSpecialFarePricerBody({ onward: onward[0], return: ret[1] }, "t", ""), /not an Akbar Special Fare pair/);
});

test("today's one-way parser never sells half of a Special Fare", () => {
  // Live search still books round trips as two one-way searches; an RS half must not appear as a fare.
  assert.deepEqual(normalizeAkbarSearch(rs.getExpSearchResponse, "ECONOMY"), []);
});
