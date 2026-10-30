import test from "node:test";
import assert from "node:assert/strict";
import { baggageRequestSummary, buildBaggageRequest } from "../src/lib/baggage-request.js";

const pax = [
  { type: "ADULT", firstName: "Asha", lastName: "Rao" },
  { type: "CHILD", firstName: "Ravi", lastName: "Rao" },
  { type: "INFANT", firstName: "Mia", lastName: "Rao" },
];
const legs = [{ origin: "BOM", destination: "DEL", airline: "6E", flightNumber: "2101" }, { origin: "DEL", destination: "BOM" }];

test("no additional baggage stores nothing and charges nothing", () => {
  assert.deepEqual(buildBaggageRequest(pax, legs, ["NONE", "NONE", "NONE"], []), { request: null });
  assert.deepEqual(buildBaggageRequest(pax, legs, undefined, undefined), { request: null });
});

test("requests are stored per traveller and flight as pending, never charged", () => {
  const r = buildBaggageRequest(pax, legs, ["REQUEST", "REQUEST", "NONE"], [
    { passengerIndex: 1, legIndex: 1, extraKg: 5 }, { passengerIndex: 0, legIndex: 0, extraKg: 10 },
  ], new Date("2026-10-30T00:00:00Z"));
  assert.ok("request" in r && r.request);
  assert.equal(r.request.status, "PENDING_STAFF_CONFIRMATION");
  assert.equal(r.request.charged, false);
  assert.deepEqual(r.request.items, [
    { passenger: "ASHA RAO (ADULT)", passengerIndex: 0, leg: "BOM-DEL", legIndex: 0, flight: "6E 2101", extraKg: 10 },
    { passenger: "RAVI RAO (CHILD)", passengerIndex: 1, leg: "DEL-BOM", legIndex: 1, extraKg: 5 },
  ]);
  assert.equal(baggageRequestSummary(r.request),
    "Extra baggage requested (pending staff confirmation, not charged): ASHA RAO (ADULT) +10 kg BOM-DEL (6E 2101); RAVI RAO (CHILD) +5 kg DEL-BOM");
});

test("invalid requests are rejected", () => {
  const bad = (choices: any, reqs: any) => "problem" in buildBaggageRequest(pax, legs, choices, reqs);
  assert.ok(bad(["REQUEST"], [{ passengerIndex: 0, legIndex: 0, extraKg: 7 }]));            // weight not offered
  assert.ok(bad(["NONE"], [{ passengerIndex: 0, legIndex: 0, extraKg: 5 }]));               // chose none
  assert.ok(bad(["NONE", "NONE", "REQUEST"], [{ passengerIndex: 2, legIndex: 0, extraKg: 5 }])); // infant
  assert.ok(bad(["REQUEST"], [{ passengerIndex: 0, legIndex: 2, extraKg: 5 }]));            // no such flight
  assert.ok(bad(["REQUEST"], [{ passengerIndex: 0, legIndex: 0, extraKg: 5 }, { passengerIndex: 0, legIndex: 0, extraKg: 10 }]));
  assert.ok(bad(["REQUEST"], []));                                                           // request with no weight
});
